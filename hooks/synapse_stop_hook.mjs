#!/usr/bin/env node
/**
 * Synapse Stop hook — runs after every assistant turn.
 *
 * Behavior:
 *  - Touches this session's peer row (last_seen_at = now) so the peer
 *    stays "active" in the heartbeat window for the duration of the
 *    session. When turns stop, the 10-min auto-expiry takes over and
 *    the peer naturally falls out of the active list.
 *  - Polls the inbox for unread messages addressed to self / broadcast /
 *    thread-where-I-participate. If any are pending, surfaces a count
 *    via:
 *      a) systemMessage in the Stop hook JSON (some Claude Code versions
 *         render this to the user)
 *      b) stderr line (always renders in the terminal)
 *      c) pending-<label>-<ppid>.json flag file for next-turn surfacing
 *    Does NOT mark messages as read — that remains UserPromptSubmit's job
 *    so the bodies are surfaced fully on the next user turn.
 *  - Never blocks. Always emits {"decision":"approve"} (with optional
 *    systemMessage when unread > 0).
 *  - No-op if SYNAPSE_LABEL is unset or the active session file is
 *    missing (e.g. the SessionStart hook didn't run).
 *
 * Cheap: 1 UPDATE + 1 COUNT(*) per turn.
 *
 * Env:
 *   SYNAPSE_LABEL                 required to do anything (otherwise no-op)
 *   SYNAPSE_DATA_DIR              default ~/.claude/synapse
 *   SYNAPSE_PEER_TIMEOUT_SECONDS  default 600
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function approve(extra = {}) {
  process.stdout.write(JSON.stringify({ decision: 'approve', ...extra }));
  process.exit(0);
}

function parseLabel() {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--label=')) return arg.slice('--label='.length);
  }
  return process.env.SYNAPSE_LABEL;
}

// Stdin-derived session_id matches the SessionStart hook + MCP server's v1.2
// adoption scheme. On Windows native where ppid diverges between hook and
// MCP children, this is the only reliable identifier.
function readStdinJson() {
  try {
    const buf = readFileSync(0, 'utf-8');
    if (!buf.trim()) return null;
    return JSON.parse(buf);
  } catch { return null; }
}

function findActiveFile(dataDir, label, sessionId, ppid, maxAgeMs) {
  if (sessionId) {
    const candidate = join(dataDir, `active-${label}-${sessionId}.json`);
    if (existsSync(candidate)) return candidate;
  }
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
    if (stat.mtimeMs > bestMtime) { bestMtime = stat.mtimeMs; best = full; }
  }
  if (best) return best;
  const legacyPpid = join(dataDir, `active-${label}-${ppid}.json`);
  if (existsSync(legacyPpid)) return legacyPpid;
  const legacyUnscoped = join(dataDir, `active-${label}.json`);
  if (existsSync(legacyUnscoped)) return legacyUnscoped;
  return null;
}

const label = parseLabel();
const dataDir = process.env.SYNAPSE_DATA_DIR ?? join(homedir(), '.claude', 'synapse');
const peerTimeoutSec = parseInt(process.env.SYNAPSE_PEER_TIMEOUT_SECONDS ?? '600', 10);
const PPID = process.ppid;
const stdinPayload = readStdinJson();
const sessionId = (stdinPayload && typeof stdinPayload.session_id === 'string')
  ? stdinPayload.session_id : null;

if (!label) approve();

try {
  const sessionPath = findActiveFile(dataDir, label, sessionId, PPID, peerTimeoutSec * 1000);
  if (!sessionPath) approve();

  let parsed;
  try { parsed = JSON.parse(readFileSync(sessionPath, 'utf-8')); } catch { approve(); }
  if (!parsed?.id) approve();
  const selfId = parsed.id;

  const dbPath = join(dataDir, 'synapse.db');
  if (!existsSync(dbPath)) approve();

  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = WAL`);

  const now = new Date().toISOString();
  const heartbeatCutoff = new Date(Date.now() - peerTimeoutSec * 1000).toISOString();

  // 1. Heartbeat (existing behavior).
  db.prepare(`UPDATE peers SET last_seen_at = ? WHERE id = ?`).run(now, selfId);

  // 2. Cheap unread poll. Mirror inbox visibility from storage.ts pollInbox:
  //    direct, broadcast (from others), or thread-scoped where I'm a participant.
  //    DON'T mark read here — UserPromptSubmit will surface bodies next turn
  //    and ack then. We only need a count + a few sender labels for the alert.
  const unreadRows = db.prepare(`
    SELECT m.id, m.from_id AS fromId, p.label AS fromLabel
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
    AND (p.last_seen_at IS NULL OR p.last_seen_at >= ?)
    LIMIT 50
  `).all(selfId, selfId, selfId, selfId, now, heartbeatCutoff);

  db.close();

  const flagPath = join(dataDir, `pending-${label}-${PPID}.json`);

  if (unreadRows.length === 0) {
    // Clear stale flag so a previously-pending file doesn't linger after
    // UserPromptSubmit drained the inbox.
    if (existsSync(flagPath)) {
      try { unlinkSync(flagPath); } catch { /* best-effort */ }
    }
    approve();
  }

  const senderLabels = [...new Set(
    unreadRows.map(r => r.fromLabel ?? r.fromId).filter(Boolean)
  )];
  const count = unreadRows.length;
  const labelStr = senderLabels.slice(0, 5).join(', ');
  const msg = `Synapse: ${count} unread message${count === 1 ? '' : 's'} from ${labelStr}${senderLabels.length > 5 ? ` +${senderLabels.length - 5}` : ''}. Type "check messages" to surface.`;

  // Belt: write flag file so SessionStart on resume can also surface count
  // (and so other tooling can detect pending state without hitting the DB).
  try {
    writeFileSync(flagPath, JSON.stringify({
      selfId, count, senderLabels, surfacedAt: now,
    }, null, 2), 'utf-8');
  } catch (err) {
    process.stderr.write(`synapse stop hook: flag write failed: ${err}\n`);
  }

  // Suspenders: stderr line is always rendered in Claude Code's terminal.
  process.stderr.write(`[synapse] ${msg}\n`);

  // systemMessage: documented on some hook events; harmless extra field
  // on Stop where it may or may not render depending on Claude Code version.
  approve({ systemMessage: msg });
} catch (err) {
  process.stderr.write(`synapse stop hook: ${err && err.stack ? err.stack : err}\n`);
  approve();
}
