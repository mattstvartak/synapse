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
 *    can find this window's identity. The MCP server stamps its own pid
 *    into that file on adoption (stampMcpPidIntoActiveFile in server.ts)
 *    so liveness probes work cross-platform.
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
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  classifyActiveFile,
  deleteActiveFile,
  findActiveFileDuplicates,
  getPeerGcMultiplier,
  listActiveFiles,
  writePeerAlias,
} from '../dist/storage.js';
import { INIT_SCHEMA_SQL } from '../dist/schema.js';
import { loadConfig } from '../dist/config.js';

// SYNAPSE_LABEL env beats --label=<l> argv. Settings.json hardcodes a
// single argv (e.g. --label=code) shared across every Claude Code window;
// per-window labels (cowork/desktop/etc.) come from the environment, so
// env must take priority. Argv is the fallback default. Direct-node hook
// invocations preserve process.ppid as a Claude Code child for legacy
// MCP fallback lookup.
function parseLabel() {
  if (process.env.SYNAPSE_LABEL) return process.env.SYNAPSE_LABEL;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--label=')) return arg.slice('--label='.length);
  }
  return null;
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

// §1.7 hook/shim identity unification — read the same identity-token file
// the shim uses (<dataDir>/<label>-identity.json), probe the daemon via
// /identity, and surface the canonical peerId. Returns null on any failure
// (no daemon, dead daemon, network error, parse error). Caller falls back
// to the legacy hook-bootstrap path when null is returned.
//
// Time budget: hard 250ms total. We must never delay session-start
// beyond what the user can perceive.
async function resolveIdentityViaDaemon(dataDir, label) {
  const daemonStatePath = join(dataDir, 'daemon.json');
  if (!existsSync(daemonStatePath)) return null;
  let state;
  try {
    state = JSON.parse(readFileSync(daemonStatePath, 'utf-8'));
  } catch {
    return null;
  }
  if (!state || typeof state.port !== 'number' || typeof state.token !== 'string') return null;
  // Daemon process liveness check — process.kill(pid, 0) returns truthy
  // (no exception) if the pid exists. If the daemon's pid is dead, skip
  // probing — the shim's auto-spawn handles fresh-daemon startup, but
  // hook-side is best-effort and falls back to bootstrap.
  if (typeof state.pid === 'number' && state.pid > 0) {
    try { process.kill(state.pid, 0); }
    catch { return null; }
  }

  // Read or mint the identity token (same file the shim writes).
  const identityPath = join(dataDir, `${label}-identity.json`);
  let identity = null;
  if (existsSync(identityPath)) {
    try { identity = JSON.parse(readFileSync(identityPath, 'utf-8')); }
    catch { /* fall through and mint */ }
  }
  if (!identity || typeof identity.identityToken !== 'string') {
    identity = { identityToken: randomUUID() };
  }
  // Capture previous peerId BEFORE the daemon probe so caller can
  // write an A→B alias if daemon returns a different id.
  const previousPeerId = (typeof identity.peerId === 'string') ? identity.peerId : null;

  // Probe daemon /identity with hard timeout.
  const url = `http://127.0.0.1:${state.port}/identity`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        label,
        identityToken: identity.identityToken,
        // §1.11 — hook-side fingerprint distinguishes "session-start
        // hook called the daemon for this shim" from "another shim is
        // claiming the same identity-token." Stable across hook calls
        // within one Claude Code session via PPID + sessionId.
        sessionFingerprint: `hook-${PPID}-${sessionId}`,
      }),
      signal: AbortSignal.timeout(250),
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  let payload;
  try { payload = await resp.json(); }
  catch { return null; }
  if (!payload || typeof payload.peerId !== 'string') return null;

  // Persist token + peerId so the shim's later /identity call returns
  // the same peerId. peerId is informational; daemon's internal Map is
  // authoritative, but having it on disk makes debugging clearer.
  try {
    writeFileSync(identityPath, JSON.stringify({
      identityToken: identity.identityToken,
      peerId: payload.peerId,
    }, null, 2), 'utf-8');
  } catch { /* best-effort */ }

  return {
    peerId: payload.peerId,
    identityToken: identity.identityToken,
    previousPeerId,
  };
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

  // Schema is the single source of truth in dist/schema.js — same SQL
  // storage.ts runs in the MCP server. Idempotent.
  db.exec(INIT_SCHEMA_SQL);

  const now = new Date().toISOString();

  // §1.7 — prefer identity resolved via daemon. Hook + shim share the
  // same identity-token file, so when both probe the daemon's /identity,
  // they get the SAME peerId back. Eliminates the divergence where the
  // hook bootstrapped peerId A and the shim's later daemon probe minted
  // peerId B for the same session. Daemon has already inserted/touched
  // the peer row in resolveIdentity, so the hook doesn't need its own
  // INSERT in this branch.
  const daemonIdentity = await resolveIdentityViaDaemon(dataDir, label);

  let selfId;
  let identitySource;
  if (daemonIdentity) {
    selfId = daemonIdentity.peerId;
    identitySource = 'session-start-hook+daemon';
    // Touch in case the daemon's resolveIdentity didn't already (it does
    // on existing-binding hits; on fresh mint the daemon also upserts).
    db.prepare(`UPDATE peers SET last_seen_at = ? WHERE id = ?`).run(now, selfId);
    // §1.6 stage-6.1 alias-write-trigger — when this token previously
    // resolved to a different peer-id (e.g. last session minted A via
    // fallback bootstrap; this session daemon returns B), write A→B
    // alias so messages still addressed to the stale id auto-redirect.
    // resolveIdentityViaDaemon captured previousPeerId from the
    // identity-token file before overwriting it.
    if (daemonIdentity.previousPeerId && daemonIdentity.previousPeerId !== selfId) {
      try {
        const cfgForAlias = loadConfig({ dataDir });
        writePeerAlias(cfgForAlias, daemonIdentity.previousPeerId, selfId);
      } catch (err) {
        process.stderr.write(`synapse session-start hook: alias-write failed: ${err && err.message ? err.message : err}\n`);
      }
    }
  } else {
    // Fallback: legacy hook-bootstrap path. Daemon was unreachable / no
    // bindings file / fetch failed. Hook mints a peerId so the session
    // has SOMETHING; the shim's later daemon probe will produce its own
    // peerId and overwrite the active file. Identity divergence may
    // resurface in this branch — but only if the daemon comes up between
    // hook fire and shim probe, which is unusual.
    const safeLabel = label.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'client';
    selfId = `${safeLabel}-${randomBytes(4).toString('hex')}`;
    identitySource = 'session-start-hook-fallback';
    db.prepare(`
      INSERT INTO peers (id, label, registered_at, last_seen_at, capabilities)
      VALUES (?, ?, ?, ?, NULL)
    `).run(selfId, label, now, now);
  }

  // Persist active session file (session-keyed) so this Code window's MCP
  // server can adopt the same identity. The legacy ppid-keyed companion
  // is gone — v1.2+ MCPs scan by sessionId and stamp their own pid into
  // the file via stampMcpPidIntoActiveFile on adoption. The `ppid` field
  // is kept as metadata only (not used as a filename discriminator).
  const activePayload = JSON.stringify({
    id: selfId,
    label,
    registeredAt: now,
    sessionId,
    ppid: PPID,
    source: identitySource,
  }, null, 2);
  writeFileSync(join(dataDir, `active-${label}-${sessionId}.json`), activePayload, 'utf-8');

  // Prune expired messages so the inbox query is clean.
  db.prepare(`DELETE FROM messages WHERE expires_at < ?`).run(now);

  // Stale peer GC. Sessions silent past the cushion (heartbeat ×
  // SYNAPSE_PEER_GC_MULTIPLIER, default 2 = 20min) are pruned along
  // with their thread memberships. Cushion is shared with
  // pruneStalePeers + classifyActiveFile so all GC paths agree.
  const gcMultiplier = getPeerGcMultiplier();
  const gcCutoff = new Date(Date.now() - peerTimeoutSec * 1000 * gcMultiplier).toISOString();
  db.prepare(`
    DELETE FROM thread_participants
    WHERE peer_id IN (SELECT id FROM peers WHERE last_seen_at < ?)
  `).run(gcCutoff);
  db.prepare(`DELETE FROM peers WHERE last_seen_at < ?`).run(gcCutoff);

  // Stale active-file GC. Delegates to the shared classifyActiveFile
  // predicate in storage.ts — same logic the synapse_cleanup tool uses,
  // so hook GC and on-demand cleanup never disagree on what counts as
  // a zombie. Always keeps this session's just-written file via the
  // keepIds short-circuit. Picks up any legacy ppid-keyed files left on
  // disk by pre-v1.2 hooks; findActiveFileDuplicates ranks them after
  // the canonical sessionId-keyed file regardless of mtime so the
  // legacy copy gets reaped, not the v1.2 file. Decision branches:
  //   parse-error       → malformed JSON, unlink
  //   missing-id        → no peer ID stamped, unlink
  //   orphan-no-peer    → peer row already pruned (peer GC just ran), unlink
  //   peer-silent       → peer row exists but silent past cushion, unlink
  //   mcp-pid-dead      → mcpPid recorded but process gone, unlink
  //   duplicate-session → caller-detected via dupOf map below, unlink the loser
  //   live              → keep
  // Legacy active files (pre-mcpPid) skip the mcp-pid-dead branch
  // automatically — classifier guards on `info.parsed.mcpPid && ...`.
  const cleanupConfig = loadConfig({ dataDir });
  const keepIds = new Set([selfId]);
  const activeFiles = listActiveFiles(cleanupConfig, label);
  const dupOf = findActiveFileDuplicates(activeFiles);
  for (const info of activeFiles) {
    const decision = classifyActiveFile(cleanupConfig, info, {
      keepIds,
      duplicateOf: dupOf.get(info.path),
    });
    if (decision.reason === 'live') continue;
    deleteActiveFile(info);
  }

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
