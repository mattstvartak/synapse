#!/usr/bin/env node
/**
 * Synapse PostToolUse hook — runs after every tool call resolves.
 *
 * Behavior:
 *  - Cheap unread count for this peer's inbox (direct, broadcast,
 *    thread-where-I-participate). Cap at LIMIT 50 so the query stays O(1)
 *    even on a flooded inbox.
 *  - If anything is pending, emits `additionalContext` containing a
 *    light marker tag — e.g. `<peer_input_pending count="3" labels="code, desktop"/>`.
 *    The model sees the marker between tool calls and can decide to call
 *    `synapse_poll` (or wait for the next user turn when bodies surface
 *    via UserPromptSubmit).
 *  - Does NOT mark messages as read. Surfacing bodies + auto-acking
 *    remains the responsibility of the UserPromptSubmit hook so that
 *    the user always gets a clean transcript of incoming peer messages.
 *  - Always exits 0; never blocks the tool flow. Failures log to
 *    stderr and emit `{}` (no-op).
 *
 * Stdin payload: { session_id, transcript_path, tool_name, tool_input,
 *                  tool_response } — ignored. The count is tool-agnostic.
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

function parseLabel() {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--label=')) return arg.slice('--label='.length);
  }
  return process.env.SYNAPSE_LABEL;
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

function findActiveFile(dataDir, label, sessionId, ppid, maxAgeMs) {
  // 1. Direct session_id hit (cheapest).
  if (sessionId) {
    const candidate = join(dataDir, `active-${label}-${sessionId}.json`);
    if (existsSync(candidate)) return candidate;
  }
  // 2. Freshest active-<label>-*.json within heartbeat window.
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
  // 3. Legacy ppid-keyed path.
  const legacyPpid = join(dataDir, `active-${label}-${ppid}.json`);
  if (existsSync(legacyPpid)) return legacyPpid;
  // 4. Legacy unscoped path.
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

if (!label) emitNothing();

try {
  const sessionPath = findActiveFile(dataDir, label, sessionId, PPID, peerTimeoutSec * 1000);
  if (!sessionPath) emitNothing();

  let parsed;
  try { parsed = JSON.parse(readFileSync(sessionPath, 'utf-8')); } catch { emitNothing(); }
  const selfId = parsed?.id;
  if (!selfId) emitNothing();

  const dbPath = join(dataDir, 'synapse.db');
  if (!existsSync(dbPath)) emitNothing();

  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = WAL`);

  const now = new Date().toISOString();
  const heartbeatCutoff = new Date(Date.now() - peerTimeoutSec * 1000).toISOString();

  const rows = db.prepare(`
    SELECT m.id, p.label AS fromLabel, m.from_id AS fromId
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

  if (rows.length === 0) emitNothing();

  const senderLabels = [...new Set(
    rows.map(r => r.fromLabel ?? r.fromId).filter(Boolean)
  )].slice(0, 5);
  const labelsAttr = senderLabels.length
    ? ` labels="${senderLabels.join(', ').replace(/"/g, '&quot;')}"`
    : '';
  const marker = `<peer_input_pending count="${rows.length}"${labelsAttr}/>`;

  emitContext(marker);
} catch (err) {
  process.stderr.write(`synapse post-tool-use hook: ${err && err.stack ? err.stack : err}\n`);
  emitNothing();
}
