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

  // Cheap second query for sender labels — only fired when we have
  // inbound to surface. Capped at LIMIT 5 since labels are display
  // hints, not the authoritative count.
  let senderLabels = [];
  if (inboundCount > 0) {
    const labelRows = db.prepare(`
      SELECT DISTINCT COALESCE(p.label, m.from_id) AS senderLabel
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
      LIMIT 5
    `).all(selfId, selfId, selfId, selfId, now);
    senderLabels = labelRows.map(r => r.senderLabel).filter(Boolean);
  }

  db.close();

  const markers = [];
  if (inboundCount > 0) {
    const labelsAttr = senderLabels.length
      ? ` labels="${senderLabels.join(', ').replace(/"/g, '&quot;')}"`
      : '';
    markers.push(`<peer_input_pending count="${inboundCount}"${labelsAttr}/>`);
  }
  if (outboundCount > 0) {
    const ageAttr = outboundOldestAgeSec !== null
      ? ` oldest_age_sec="${outboundOldestAgeSec}"`
      : '';
    markers.push(`<outbound_awaiting_reply count="${outboundCount}"${ageAttr}/>`);
  }

  emitContext(markers.join(''));
} catch (err) {
  process.stderr.write(`synapse post-tool-use hook: ${err && err.stack ? err.stack : err}\n`);
  emitNothing();
}
