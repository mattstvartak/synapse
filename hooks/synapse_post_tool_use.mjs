#!/usr/bin/env node
/**
 * Synapse PostToolUse hook — runs after every tool call resolves.
 *
 * Behavior:
 *  - Counts the inbox for this session's peer ID via a single SELECT
 *    COUNT(*) (matches pollInbox semantics — no LIMIT cap, no sender
 *    liveness filter, just direct + broadcast + thread-where-I-participate
 *    AND expires_at >= now AND read_at IS NULL).
 *  - If anything is pending, emits `additionalContext` containing a
 *    light marker tag — e.g. `<peer_input_pending count="3" labels="code, desktop"/>`.
 *    The model sees the marker between tool calls and can decide to call
 *    `synapse_poll` (or wait for the next user turn when bodies surface
 *    via UserPromptSubmit).
 *  - Does NOT mark messages as read. Surfacing bodies + auto-acking
 *    remains the responsibility of the UserPromptSubmit hook so that
 *    the user always gets a clean transcript of incoming peer messages.
 *  - Identity adoption validates against the peer DB: the session_id-keyed
 *    direct hit only wins if its `parsed.id` is a live peer. Otherwise the
 *    hook falls through to the freshest-active-file branch. This keeps the
 *    hook's selfId in sync with the MCP server even after a /mcp reconnect
 *    bootstrap-as-new-id (see synapse_post_tool_use docstring & matching
 *    fix in server.ts:readActiveFile).
 *  - Always exits 0; never blocks the tool flow. Failures log to
 *    stderr and emit `{}` (no-op).
 *
 * Stdin payload: { session_id, transcript_path, tool_name, tool_input,
 *                  tool_response } — ignored except session_id.
 *
 * Env:
 *   SYNAPSE_LABEL                 required (otherwise no-op)
 *   SYNAPSE_DATA_DIR              default ~/.claude/synapse
 *   SYNAPSE_PEER_TIMEOUT_SECONDS  default 600
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function emitContext(additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext,
    },
  }));
  process.exit(0);
}

function emitNothing() {
  process.stdout.write('{}');
  process.exit(0);
}

// SYNAPSE_LABEL env beats argv. Settings.json hardcodes one --label=<l>
// across all Claude Code windows; per-window labels come from env.
function parseLabel() {
  if (process.env.SYNAPSE_LABEL) return process.env.SYNAPSE_LABEL;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--label=')) return arg.slice('--label='.length);
  }
  return null;
}

// Stdin-derived session_id is the authoritative discriminator (mirrors the
// SessionStart hook + MCP server's v1.2 adoption order). On Windows native
// where ppid diverges between Claude Code's hook and MCP children, this is
// the only signal that reliably identifies our session.
function readStdinJson() {
  try {
    const buf = readFileSync(0, 'utf-8');
    if (!buf.trim()) return null;
    return JSON.parse(buf);
  } catch { return null; }
}

// Returns true if the active file at `path` references a peer that
// currently exists in the DB. Defends against the identity-divergence
// trap: SessionStart writes a file with id=A, then peer A gets cleaned
// up + MCP reconnects as id=B. The original session_id-keyed file still
// claims A but is dead state. Without this validation the hook would
// keep counting messages addressed to A while the MCP polls/acks for B.
function activeFileHasLivePeer(db, path) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return false; }
  if (!parsed?.id) return false;
  const row = db.prepare(`SELECT 1 FROM peers WHERE id = ?`).get(parsed.id);
  return !!row;
}

function findActiveFile(db, dataDir, label, sessionId, maxAgeMs) {
  // 1. Direct session_id hit — only trust it if the file points at a
  //    live peer. Stale session_id files get demoted to a fall-through.
  if (sessionId) {
    const candidate = join(dataDir, `active-${label}-${sessionId}.json`);
    if (existsSync(candidate) && activeFileHasLivePeer(db, candidate)) {
      return candidate;
    }
  }
  // 2. Freshest active-<label>-*.json within heartbeat window AND
  //    pointing at a live peer.
  let entries;
  try { entries = readdirSync(dataDir); } catch { entries = []; }
  const prefix = `active-${label}-`;
  const cutoff = Date.now() - maxAgeMs;
  let best = null, bestMtime = -Infinity;
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const full = join(dataDir, name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;
    if (!activeFileHasLivePeer(db, full)) continue;
    if (stat.mtimeMs > bestMtime) { bestMtime = stat.mtimeMs; best = full; }
  }
  return best;
}

const label = parseLabel();
const dataDir = process.env.SYNAPSE_DATA_DIR ?? join(homedir(), '.claude', 'synapse');
const peerTimeoutSec = parseInt(process.env.SYNAPSE_PEER_TIMEOUT_SECONDS ?? '600', 10);
const stdinPayload = readStdinJson();
const sessionId = (stdinPayload && typeof stdinPayload.session_id === 'string')
  ? stdinPayload.session_id : null;

if (!label) emitNothing();

try {
  const dbPath = join(dataDir, 'synapse.db');
  if (!existsSync(dbPath)) emitNothing();

  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = WAL`);

  // findActiveFile needs the DB so it can validate that each candidate
  // file's `parsed.id` is a live peer (rejecting stale identity files
  // left over from previous sessions).
  const sessionPath = findActiveFile(db, dataDir, label, sessionId, peerTimeoutSec * 1000);
  if (!sessionPath) { db.close(); emitNothing(); }

  let parsed;
  try { parsed = JSON.parse(readFileSync(sessionPath, 'utf-8')); } catch { db.close(); emitNothing(); }
  const selfId = parsed?.id;
  if (!selfId) { db.close(); emitNothing(); }

  const now = new Date().toISOString();

  // True unread count, not LIMIT-clamped. The previous `LIMIT 50` arm
  // returned `rows.length` to `count="..."`, which saturates at 50 once
  // unread genuinely exceeds 50 — making the marker look frozen even as
  // the user acks messages. Sender-liveness join was also dropped: a
  // message from a peer who just went silent is still a real message
  // and shouldn't disappear from the unread count. This now matches
  // pollInbox semantics exactly.
  const inboundRow = db.prepare(`
    SELECT COUNT(*) AS n
    FROM messages
    WHERE (
      to_id = ?
      OR (to_id = 'broadcast' AND from_id != ?)
      OR (
        to_id LIKE 'thread:%'
        AND from_id != ?
        AND EXISTS (
          SELECT 1 FROM thread_participants tp
          WHERE tp.thread_id = messages.thread_id AND tp.peer_id = ?
        )
      )
    )
    AND expires_at >= ?
    AND read_at IS NULL
  `).get(selfId, selfId, selfId, selfId, now);
  const inboundCount = Number(inboundRow?.n ?? 0);

  // Outbound awaiting reply — messages I sent on a thread where no
  // peer has replied since. Surfaces "you have an in-flight outbound,
  // don't go idle" so wait_reply timeouts don't strand conversations.
  // Real fix for human-paced peer drafting (cf. §3.1 in PR proposal).
  const outboundRow = db.prepare(`
    SELECT COUNT(*) AS n,
           MIN(m.created_at) AS oldest
    FROM messages m
    WHERE m.from_id = ?
      AND m.expires_at >= ?
      AND NOT EXISTS (
        SELECT 1 FROM messages r
        WHERE r.thread_id = m.thread_id
          AND r.from_id != ?
          AND r.created_at > m.created_at
      )
  `).get(selfId, now, selfId);
  const outboundCount = Number(outboundRow?.n ?? 0);
  const outboundOldest = outboundRow?.oldest ?? null;
  const outboundOldestAgeSec = outboundOldest
    ? Math.floor((Date.now() - new Date(outboundOldest).getTime()) / 1000)
    : null;

  if (inboundCount === 0 && outboundCount === 0) {
    db.close();
    emitNothing();
  }

  // Body-bearing fetch — supports C (inline preview) + §4.10 recruit
  // detection. LIMIT 5 keeps it cheap; recruit markers + ack-class bodies
  // are short. The bodies feed sender labels, inline preview, and recruit
  // marker parsing in a single pass.
  let unreadBodies = [];
  let senderLabels = [];
  if (inboundCount > 0) {
    unreadBodies = db.prepare(`
      SELECT m.id, m.from_id AS fromId, m.thread_id AS threadId,
             m.body, COALESCE(p.label, m.from_id) AS senderLabel
      FROM messages m
      LEFT JOIN peers p ON p.id = m.from_id
      WHERE (
        m.to_id = ?
        OR (m.to_id = 'broadcast' AND m.from_id != ?)
        OR (
          m.to_id LIKE 'thread:%'
          AND m.from_id != ?
          AND EXISTS (
            SELECT 1 FROM thread_participants tp
            WHERE tp.thread_id = m.thread_id AND tp.peer_id = ?
          )
        )
      )
      AND m.expires_at >= ?
      AND m.read_at IS NULL
      ORDER BY m.created_at ASC
      LIMIT 5
    `).all(selfId, selfId, selfId, selfId, now);
    senderLabels = [...new Set(unreadBodies.map(r => r.senderLabel).filter(Boolean))];
  }

  // §4.10 — recruit detection + atomic auto-join. Marker format:
  //   [RECRUIT] id=<uuid> from=<peerId> urgency=<l|n|h> caps=<csv>
  //             requireAll=<bool> threadId=<tid> originatorBusy=<bool>
  // Auto-join fires only when self is idle (no peer_busy_state row) AND
  // caps match. Single SQL transaction: thread_participants insert,
  // reply message, mark recruit read, set self busy=RECRUIT_ENGAGED.
  // Failures log to stderr and skip; never block the hook.
  const isBusy = !!db.prepare(
    `SELECT 1 AS x FROM peer_busy_state WHERE peer_id = ?`,
  ).get(selfId);
  const selfCapsRow = db.prepare(
    `SELECT capabilities FROM peers WHERE id = ?`,
  ).get(selfId);
  let selfCaps = [];
  try {
    selfCaps = selfCapsRow?.capabilities ? JSON.parse(selfCapsRow.capabilities) : [];
    if (!Array.isArray(selfCaps)) selfCaps = [];
  } catch { selfCaps = []; }

  function parseRecruitMarker(line) {
    const out = {};
    const tail = line.replace(/^\[RECRUIT\]\s+/, '');
    for (const pair of tail.split(/\s+/)) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return out;
  }

  const autoJoinedNotices = [];
  const autoJoinSkippedNotices = [];
  const recruitExpiredNotices = [];

  for (const m of unreadBodies) {
    const firstLine = (m.body ?? '').split('\n', 1)[0] ?? '';
    if (firstLine.startsWith('[RECRUIT_EXPIRED]')) {
      recruitExpiredNotices.push(firstLine);
      continue;
    }
    if (!firstLine.startsWith('[RECRUIT]')) continue;

    const fields = parseRecruitMarker(firstLine);
    const recruitId = fields.id ?? '?';
    const targetThreadId = fields.threadId;
    const fromPeerId = fields.from;
    const requireAll = fields.requireAll === 'true';
    const recruitCaps = (fields.caps ?? '').split(',').filter(Boolean);

    if (fromPeerId === selfId) continue; // self-recruit edge case
    if (!targetThreadId) {
      autoJoinSkippedNotices.push(`recruit ${recruitId} skipped (no threadId)`);
      continue;
    }

    let capsMatch;
    if (recruitCaps.length === 0) capsMatch = true;
    else if (requireAll) capsMatch = recruitCaps.every(c => selfCaps.includes(c));
    else capsMatch = recruitCaps.some(c => selfCaps.includes(c));

    if (!capsMatch) {
      autoJoinSkippedNotices.push(
        `recruit ${recruitId} caps mismatch (need ${recruitCaps.join(',')}, have ${selfCaps.join(',') || 'none'})`,
      );
      continue;
    }
    if (isBusy) {
      autoJoinSkippedNotices.push(`recruit ${recruitId} skipped (self busy)`);
      continue;
    }

    try {
      db.exec('BEGIN');
      db.prepare(`
        INSERT OR IGNORE INTO thread_participants (thread_id, peer_id, joined_at)
        VALUES (?, ?, ?)
      `).run(targetThreadId, selfId, now);

      const replyId = `${selfId.slice(0, 12)}-recruit-${recruitId.slice(0, 8)}-${Date.now()}`;
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      const replyBody = `I'm in. caps=[${selfCaps.join(',') || 'none'}]`;
      db.prepare(`
        INSERT INTO messages (id, from_id, to_id, thread_id, parent_id, body, workspace, created_at, expires_at, read_at)
        VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL)
      `).run(replyId, selfId, `thread:${targetThreadId}`, targetThreadId, replyBody, now, expiresAt);

      db.prepare(`UPDATE messages SET read_at = ? WHERE id = ?`).run(now, m.id);

      db.prepare(`
        INSERT INTO peer_busy_state (peer_id, busy_at, busy_reason, shim_fingerprint)
        VALUES (?, ?, 'RECRUIT_ENGAGED', NULL)
        ON CONFLICT(peer_id) DO UPDATE SET busy_at=excluded.busy_at, busy_reason=excluded.busy_reason
      `).run(selfId, now);

      db.exec('COMMIT');
      autoJoinedNotices.push(
        `recruit ${recruitId} auto-joined on thread ${targetThreadId.slice(0, 8)}…`,
      );
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* nothing to rollback */ }
      autoJoinSkippedNotices.push(
        `recruit ${recruitId} auto-join failed: ${err?.message ?? err}`,
      );
    }
  }

  db.close();

  // §1.10 fix (b) — directive-line copy. Bare counts are easy to scan
  // past; concrete next-actions trigger behavior.
  const lines = [];
  if (inboundCount > 0) {
    const labelsAttr = senderLabels.length
      ? ` labels="${senderLabels.join(', ').replace(/"/g, '&quot;')}"`
      : '';
    lines.push(
      `[!] SYNAPSE: ${inboundCount} unread message${inboundCount === 1 ? '' : 's'}` +
      (senderLabels.length ? ` from ${senderLabels.join(', ')}` : '') +
      `. Run synapse_poll before next outbound to avoid stale-context send (§5.6).`
    );
    lines.push(`<peer_input_pending count="${inboundCount}"${labelsAttr}/>`);
  }
  if (outboundCount > 0) {
    const ageHint = outboundOldestAgeSec !== null ? ` (oldest ${outboundOldestAgeSec}s ago)` : '';
    lines.push(
      `[!] SYNAPSE: ${outboundCount} outbound message${outboundCount === 1 ? '' : 's'} awaiting reply${ageHint}. ` +
      `Consider synapse_wait_reply or synapse_poll before treating the conversation as complete.`
    );
    const ageAttr = outboundOldestAgeSec !== null ? ` oldest_age_sec="${outboundOldestAgeSec}"` : '';
    lines.push(`<outbound_awaiting_reply count="${outboundCount}"${ageAttr}/>`);
  }

  // §4.10 recruit results — surface auto-joins, expiry notices, and
  // diagnostic skip reasons. Auto-joins are informational; the model
  // sees them and knows it's now a thread participant.
  for (const note of autoJoinedNotices) {
    lines.push(`[!] SYNAPSE: ${note}`);
  }
  for (const note of recruitExpiredNotices) {
    lines.push(`[!] SYNAPSE: ${note}`);
  }
  for (const note of autoJoinSkippedNotices) {
    lines.push(`<recruit_skipped reason="${note.replace(/"/g, '&quot;')}"/>`);
  }

  // C — inline body preview. For ≤3 unread short messages (≤200 char
  // bodies, non-recruit), surface the body inline so ack-class messages
  // ("ok", "shipped") don't force a poll roundtrip. Recruit markers are
  // surfaced separately above; long bodies still require synapse_poll.
  if (inboundCount > 0 && inboundCount <= 3) {
    for (const m of unreadBodies) {
      const firstLine = (m.body ?? '').split('\n', 1)[0] ?? '';
      if (firstLine.startsWith('[RECRUIT]')) continue;
      if (firstLine.startsWith('[RECRUIT_EXPIRED]')) continue;
      const body = m.body ?? '';
      if (body.length > 200) continue;
      lines.push(
        `<peer_input_preview from="${m.fromId}" id="${m.id}" thread="${m.threadId}">`,
      );
      lines.push(body);
      lines.push(`</peer_input_preview>`);
    }
  }

  emitContext(lines.join('\n'));
} catch (err) {
  process.stderr.write(`synapse post-tool-use hook: ${err && err.stack ? err.stack : err}\n`);
  emitNothing();
}
