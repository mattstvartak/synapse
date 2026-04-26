#!/usr/bin/env node
/**
 * Synapse SessionStart hook — runs at the start of every Claude session.
 *
 * Behavior:
 *  - Reads the Claude Code SessionStart JSON from stdin to extract the
 *    canonical `session_id` (UUID). This is the authoritative discriminator
 *    across hook ↔ MCP server in the same Claude Code window, replacing
 *    the v1.1 ppid-based scheme that breaks on Windows native (Claude Code
 *    spawns hook vs MCP through different intermediate processes).
 *  - Generates an ephemeral peer ID for this session (label-<hex>).
 *  - Registers the peer directly in the SQLite store (no MCP roundtrip).
 *  - Writes <dataDir>/active-<label>-<sessionId>.json so the MCP server
 *    can find this window's identity. Also writes the legacy ppid-keyed
 *    file for one transition release, so any MCP still on the v1.1 fallback
 *    path keeps working.
 *  - Polls the inbox for unread messages and surfaces them via
 *    `additionalContext`.
 *
 * Env:
 *   SYNAPSE_LABEL                 required — "code", "desktop", "ipad", etc.
 *   SYNAPSE_DATA_DIR              optional — default ~/.claude/synapse
 *   SYNAPSE_PEER_TIMEOUT_SECONDS  optional — default 600
 *
 * Exit always 0 — never block the session start. Errors print to stderr.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

// --label=<l> argv beats SYNAPSE_LABEL env. Direct-node hook invocations
// (no `bash -c` wrapper) preserve process.ppid as a Claude Code child,
// which we still record for legacy MCP fallback lookup.
function parseLabel() {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--label=')) return arg.slice('--label='.length);
  }
  return process.env.SYNAPSE_LABEL;
}

// Best-effort stdin parse. Claude Code passes a JSON payload like
// { session_id, transcript_path, cwd, hook_event_name, source } on stdin.
// If stdin isn't piped (manual invocation, tests) or parse fails, we
// fall back to a generated UUID — still session-keyed, just untethered
// from Claude Code's session_id.
function readStdinJson() {
  try {
    const buf = readFileSync(0, 'utf-8');
    if (!buf.trim()) return null;
    return JSON.parse(buf);
  } catch {
    return null;
  }
}

const label = parseLabel();
const dataDir = process.env.SYNAPSE_DATA_DIR ?? join(homedir(), '.claude', 'synapse');
const peerTimeoutSec = parseInt(process.env.SYNAPSE_PEER_TIMEOUT_SECONDS ?? '600', 10);
const PPID = process.ppid;
const stdinPayload = readStdinJson();
const sessionId = (stdinPayload && typeof stdinPayload.session_id === 'string')
  ? stdinPayload.session_id
  : randomUUID();

function emitContext(additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));
}

function emitNothing() {
  // Empty hookSpecificOutput is valid — Claude Code treats it as no-op.
  process.stdout.write('{}');
}

if (!label) {
  // No label = synapse not configured for this client; silently no-op.
  emitNothing();
  process.exit(0);
}

try {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'synapse.db'));
  db.exec(`PRAGMA journal_mode = WAL`);
  db.exec(`PRAGMA synchronous = NORMAL`);

  // Schema must match storage.ts. Idempotent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS peers (
      id            TEXT PRIMARY KEY,
      label         TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      last_seen_at  TEXT NOT NULL,
      capabilities  TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      from_id     TEXT NOT NULL,
      to_id       TEXT NOT NULL,
      thread_id   TEXT NOT NULL,
      parent_id   TEXT,
      body        TEXT NOT NULL,
      workspace   TEXT,
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      read_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_to       ON messages(to_id, read_at);
    CREATE INDEX IF NOT EXISTS idx_messages_thread   ON messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_expires  ON messages(expires_at);
    CREATE INDEX IF NOT EXISTS idx_peers_last_seen   ON peers(last_seen_at);
    CREATE TABLE IF NOT EXISTS thread_participants (
      thread_id  TEXT NOT NULL,
      peer_id    TEXT NOT NULL,
      joined_at  TEXT NOT NULL,
      PRIMARY KEY (thread_id, peer_id)
    );
    CREATE INDEX IF NOT EXISTS idx_participants_peer ON thread_participants(peer_id);
  `);

  // Generate ephemeral ID and register.
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'client';
  const selfId = `${safeLabel}-${randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO peers (id, label, registered_at, last_seen_at, capabilities)
    VALUES (?, ?, ?, ?, NULL)
  `).run(selfId, label, now, now);

  // Persist active session file (session-keyed) so this Code window's MCP
  // server can adopt the same identity. Also write the legacy ppid-keyed
  // file so older MCP builds that still scan by ppid keep working through
  // the v1.1→v1.2 transition.
  const activePayload = JSON.stringify({
    id: selfId,
    label,
    registeredAt: now,
    sessionId,
    ppid: PPID,
    source: 'session-start-hook',
  }, null, 2);
  writeFileSync(join(dataDir, `active-${label}-${sessionId}.json`), activePayload, 'utf-8');
  writeFileSync(join(dataDir, `active-${label}-${PPID}.json`), activePayload, 'utf-8');

  // Prune expired messages so the inbox query is clean.
  db.prepare(`DELETE FROM messages WHERE expires_at < ?`).run(now);

  // Stale peer GC. Sessions that haven't been seen in 6× the heartbeat
  // window are gone for good — prune them and their thread memberships
  // so peer lists and participant rosters stay clean across restarts.
  // The 6× multiplier keeps a generous safety margin over the standard
  // 10-min heartbeat in case a peer was mid-task and hadn't pinged. Stale
  // active-* files are not touched here; they're harmless markers and
  // the freshest one wins under the v1.2 session_id resolution scheme.
  const gcCutoff = new Date(Date.now() - peerTimeoutSec * 1000 * 6).toISOString();
  db.prepare(`
    DELETE FROM thread_participants
    WHERE peer_id IN (SELECT id FROM peers WHERE last_seen_at < ?)
  `).run(gcCutoff);
  db.prepare(`DELETE FROM peers WHERE last_seen_at < ?`).run(gcCutoff);

  // Count unread without loading bodies. Inbox visibility matches storage.ts
  // pollInbox: direct, broadcast, OR thread-scoped where I'm a participant.
  const heartbeatCutoff = new Date(Date.now() - peerTimeoutSec * 1000).toISOString();
  const unread = db.prepare(`
    SELECT COUNT(*) AS n FROM messages m
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
  `).get(selfId, selfId, selfId, selfId, now, heartbeatCutoff);
  const unreadCount = Number(unread?.n ?? 0);

  // Active peer labels for awareness only (not message bodies).
  const peers = db.prepare(`
    SELECT label FROM peers WHERE last_seen_at >= ? AND id != ?
  `).all(heartbeatCutoff, selfId);
  const peerLabels = [...new Set(peers.map(p => p.label))];

  db.close();

  const parts = [`Synapse: connected as \`${selfId}\``];
  if (peerLabels.length) parts.push(`peers active: ${peerLabels.map(l => `\`${l}\``).join(', ')}`);
  if (unreadCount > 0) {
    parts.push(`**${unreadCount} unread message${unreadCount === 1 ? '' : 's'}** — surface only if the user asks ("any messages?", "check synapse").`);
  }
  parts.push(
    '_Outbound rule:_ only call `synapse_send` when the user explicitly asks to share/send/forward to another client. Never auto-relay.',
  );

  emitContext(parts.join('\n\n'));
  process.exit(0);
} catch (err) {
  process.stderr.write(`synapse session-start hook: ${err && err.stack ? err.stack : err}\n`);
  emitNothing();
  process.exit(0);
}
