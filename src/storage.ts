import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  SynapseConfig, Peer, Message, Thread, ThreadMode, ThreadCloseReason, AuditEntry,
  ThreadParticipant,
} from './types.js';
import { buildIdentityPaths } from './types.js';
import { INIT_SCHEMA_SQL } from './schema.js';

let db: DatabaseSync | null = null;

export function getDb(config: SynapseConfig): DatabaseSync {
  if (db) return db;
  mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(join(config.dataDir, 'synapse.db'));
  db.exec(`PRAGMA journal_mode = WAL`);
  db.exec(`PRAGMA synchronous = NORMAL`);
  db.exec(`PRAGMA foreign_keys = ON`);
  initSchema(db);
  return db;
}

function initSchema(d: DatabaseSync): void {
  d.exec(INIT_SCHEMA_SQL);
}

// node:sqlite uses $name for named params (vs better-sqlite3's @name).
// All binders below pass plain objects keyed by camelCase property names.

// ── Peers ──────────────────────────────────────────────────────────

export function upsertPeer(config: SynapseConfig, peer: Peer): void {
  getDb(config).prepare(`
    INSERT INTO peers (id, label, registered_at, last_seen_at, capabilities)
    VALUES ($id, $label, $registeredAt, $lastSeenAt, $capabilities)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      last_seen_at = excluded.last_seen_at,
      capabilities = excluded.capabilities
  `).run(peer as unknown as Record<string, string | null>);
}

export function touchPeer(config: SynapseConfig, peerId: string): void {
  getDb(config).prepare(
    `UPDATE peers SET last_seen_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), peerId);
}

export function getPeer(config: SynapseConfig, peerId: string): Peer | null {
  const row = getDb(config).prepare(`
    SELECT id, label,
           registered_at AS registeredAt,
           last_seen_at  AS lastSeenAt,
           capabilities
    FROM peers WHERE id = ?
  `).get(peerId);
  return (row as Peer | undefined) ?? null;
}

export function listActivePeers(config: SynapseConfig): Peer[] {
  const cutoff = new Date(Date.now() - config.peerHeartbeatTimeoutSeconds * 1000).toISOString();
  return getDb(config).prepare(`
    SELECT id, label,
           registered_at AS registeredAt,
           last_seen_at  AS lastSeenAt,
           capabilities
    FROM peers WHERE last_seen_at >= ?
    ORDER BY last_seen_at DESC
  `).all(cutoff) as unknown as Peer[];
}

// Multiplier on top of the heartbeat window before a silent peer is
// hard-pruned. 2 = 20min at the default 600s heartbeat. Bump via env on
// a flaky link. Synapse_cleanup with `purgeAll` ignores this cushion.
export function getPeerGcMultiplier(): number {
  const raw = process.env.SYNAPSE_PEER_GC_MULTIPLIER;
  if (!raw) return 2;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 2;
}

// Drop every peer row except the caller. Used by synapse_cleanup with
// purgeAll. Bypasses the heartbeat cushion entirely.
export function dropPeersExcept(config: SynapseConfig, keepId: string): number {
  return Number(getDb(config).prepare(
    `DELETE FROM peers WHERE id != ?`,
  ).run(keepId).changes);
}

export function pruneStalePeers(config: SynapseConfig): number {
  // Hard-prune peers silent for >Nx the heartbeat window.
  const cushionMs = config.peerHeartbeatTimeoutSeconds * 1000 * getPeerGcMultiplier();
  const cutoff = new Date(Date.now() - cushionMs).toISOString();
  return Number(getDb(config).prepare(
    `DELETE FROM peers WHERE last_seen_at < ?`,
  ).run(cutoff).changes);
}

// ── Messages ───────────────────────────────────────────────────────

export function insertMessage(config: SynapseConfig, msg: Message): void {
  getDb(config).prepare(`
    INSERT INTO messages
      (id, from_id, to_id, thread_id, parent_id, body, workspace,
       created_at, expires_at, read_at)
    VALUES
      ($id, $fromId, $toId, $threadId, $parentId, $body, $workspace,
       $createdAt, $expiresAt, $readAt)
  `).run(msg as unknown as Record<string, string | null>);
}

export function getMessage(config: SynapseConfig, messageId: string): Message | null {
  const row = getDb(config).prepare(`
    SELECT id,
           from_id    AS fromId,
           to_id      AS toId,
           thread_id  AS threadId,
           parent_id  AS parentId,
           body, workspace,
           created_at AS createdAt,
           expires_at AS expiresAt,
           read_at    AS readAt
    FROM messages WHERE id = ?
  `).get(messageId);
  return (row as Message | undefined) ?? null;
}

export interface PollOptions {
  since?: string;
  unreadOnly?: boolean;
  workspace?: string;
}

export function pollInbox(
  config: SynapseConfig,
  selfId: string,
  opts: PollOptions = {},
): Message[] {
  pruneExpired(config);
  const { since, unreadOnly = true, workspace } = opts;

  // Inbox visibility:
  //   1. Direct: to_id = self
  //   2. Bare broadcast: to_id = 'broadcast' AND from != self (global discoverability)
  //   3. Thread-scoped: to_id starts with 'thread:' AND I'm a participant of that thread
  //
  // The thread variant uses a correlated EXISTS subquery against
  // thread_participants so group splits don't leak across roster.
  const where: string[] = [
    `(
       to_id = ?
       OR (to_id = 'broadcast' AND from_id != ?)
       OR (
         to_id LIKE 'thread:%'
         AND from_id != ?
         AND EXISTS (
           SELECT 1 FROM thread_participants tp
           WHERE tp.thread_id = messages.thread_id
             AND tp.peer_id   = ?
         )
       )
     )`,
    `expires_at >= ?`,
  ];
  const params: (string | number)[] = [
    selfId, selfId, selfId, selfId, new Date().toISOString(),
  ];

  if (unreadOnly) where.push(`read_at IS NULL`);
  if (since) {
    where.push(`created_at > ?`);
    params.push(since);
  }
  if (workspace) {
    where.push(`workspace = ?`);
    params.push(workspace);
  }

  return getDb(config).prepare(`
    SELECT id,
           from_id    AS fromId,
           to_id      AS toId,
           thread_id  AS threadId,
           parent_id  AS parentId,
           body, workspace,
           created_at AS createdAt,
           expires_at AS expiresAt,
           read_at    AS readAt
    FROM messages
    WHERE ${where.join(' AND ')}
    ORDER BY created_at ASC
  `).all(...params) as unknown as Message[];
}

export function ackMessage(config: SynapseConfig, messageId: string): boolean {
  const result = getDb(config).prepare(
    `UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL`,
  ).run(new Date().toISOString(), messageId);
  return Number(result.changes) > 0;
}

export function getThread(config: SynapseConfig, threadId: string): Message[] {
  return getDb(config).prepare(`
    SELECT id,
           from_id    AS fromId,
           to_id      AS toId,
           thread_id  AS threadId,
           parent_id  AS parentId,
           body, workspace,
           created_at AS createdAt,
           expires_at AS expiresAt,
           read_at    AS readAt
    FROM messages WHERE thread_id = ?
    ORDER BY created_at ASC
  `).all(threadId) as unknown as Message[];
}

export function pruneExpired(config: SynapseConfig): number {
  return Number(getDb(config).prepare(
    `DELETE FROM messages WHERE expires_at < ?`,
  ).run(new Date().toISOString()).changes);
}

// ── Threads (autonomous mode) ──────────────────────────────────────

interface ThreadRow {
  threadId: string;
  modeBySide: string;        // JSON
  goal: string | null;
  openedBy: string | null;
  openedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  maxTurns: number;
  maxWallClockSec: number;
  maxTokensPerSide: number;
  turnCounts: string;        // JSON
  tokenCounts: string;       // JSON
}

function rowToThread(row: ThreadRow): Thread {
  return {
    threadId: row.threadId,
    modeBySide: JSON.parse(row.modeBySide) as Record<string, ThreadMode>,
    goal: row.goal,
    openedBy: row.openedBy,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    closeReason: row.closeReason as ThreadCloseReason | null,
    maxTurns: row.maxTurns,
    maxWallClockSec: row.maxWallClockSec,
    maxTokensPerSide: row.maxTokensPerSide,
    turnCounts: JSON.parse(row.turnCounts) as Record<string, number>,
    tokenCounts: JSON.parse(row.tokenCounts) as Record<string, number>,
  };
}

export function getThreadState(config: SynapseConfig, threadId: string): Thread | null {
  const row = getDb(config).prepare(`
    SELECT thread_id           AS threadId,
           mode_by_side         AS modeBySide,
           goal,
           opened_by            AS openedBy,
           opened_at            AS openedAt,
           closed_at            AS closedAt,
           close_reason         AS closeReason,
           max_turns            AS maxTurns,
           max_wall_clock_sec   AS maxWallClockSec,
           max_tokens_per_side  AS maxTokensPerSide,
           turn_counts          AS turnCounts,
           token_counts         AS tokenCounts
    FROM threads WHERE thread_id = ?
  `).get(threadId);
  return row ? rowToThread(row as unknown as ThreadRow) : null;
}

export function upsertThread(config: SynapseConfig, t: Thread): void {
  getDb(config).prepare(`
    INSERT INTO threads (thread_id, mode_by_side, goal, opened_by, opened_at,
                         closed_at, close_reason, max_turns, max_wall_clock_sec,
                         max_tokens_per_side, turn_counts, token_counts)
    VALUES ($threadId, $modeBySide, $goal, $openedBy, $openedAt,
            $closedAt, $closeReason, $maxTurns, $maxWallClockSec,
            $maxTokensPerSide, $turnCounts, $tokenCounts)
    ON CONFLICT(thread_id) DO UPDATE SET
      mode_by_side        = excluded.mode_by_side,
      goal                = excluded.goal,
      opened_by           = excluded.opened_by,
      opened_at           = excluded.opened_at,
      closed_at           = excluded.closed_at,
      close_reason        = excluded.close_reason,
      max_turns           = excluded.max_turns,
      max_wall_clock_sec  = excluded.max_wall_clock_sec,
      max_tokens_per_side = excluded.max_tokens_per_side,
      turn_counts         = excluded.turn_counts,
      token_counts        = excluded.token_counts
  `).run({
    threadId: t.threadId,
    modeBySide: JSON.stringify(t.modeBySide),
    goal: t.goal,
    openedBy: t.openedBy,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    closeReason: t.closeReason,
    maxTurns: t.maxTurns,
    maxWallClockSec: t.maxWallClockSec,
    maxTokensPerSide: t.maxTokensPerSide,
    turnCounts: JSON.stringify(t.turnCounts),
    tokenCounts: JSON.stringify(t.tokenCounts),
  } as unknown as Record<string, string | number | null>);
}

export function closeThread(
  config: SynapseConfig,
  threadId: string,
  reason: ThreadCloseReason,
): void {
  getDb(config).prepare(`
    UPDATE threads
    SET closed_at = ?, close_reason = ?
    WHERE thread_id = ? AND closed_at IS NULL
  `).run(new Date().toISOString(), reason, threadId);
}

export function listOpenAutoThreads(config: SynapseConfig): Thread[] {
  const rows = getDb(config).prepare(`
    SELECT thread_id           AS threadId,
           mode_by_side         AS modeBySide,
           goal,
           opened_by            AS openedBy,
           opened_at            AS openedAt,
           closed_at            AS closedAt,
           close_reason         AS closeReason,
           max_turns            AS maxTurns,
           max_wall_clock_sec   AS maxWallClockSec,
           max_tokens_per_side  AS maxTokensPerSide,
           turn_counts          AS turnCounts,
           token_counts         AS tokenCounts
    FROM threads WHERE closed_at IS NULL
  `).all();
  return (rows as unknown as ThreadRow[]).map(rowToThread);
}

// ── Audit log (provenance) ─────────────────────────────────────────

export function logAudit(config: SynapseConfig, entry: AuditEntry): void {
  getDb(config).prepare(`
    INSERT INTO audit_log
      (id, tool_name, caller_id, thread_id, origin_thread_id, origin_message_id,
       args_hash, result, reason, called_at)
    VALUES
      ($id, $toolName, $callerId, $threadId, $originThreadId, $originMessageId,
       $argsHash, $result, $reason, $calledAt)
  `).run(entry as unknown as Record<string, string | null>);
}

// ── Thread participation roster ────────────────────────────────────

export function joinThread(
  config: SynapseConfig,
  threadId: string,
  peerId: string,
): boolean {
  const result = getDb(config).prepare(`
    INSERT OR IGNORE INTO thread_participants (thread_id, peer_id, joined_at)
    VALUES (?, ?, ?)
  `).run(threadId, peerId, new Date().toISOString());
  return Number(result.changes) > 0;
}

export function leaveThread(
  config: SynapseConfig,
  threadId: string,
  peerId: string,
): boolean {
  const result = getDb(config).prepare(`
    DELETE FROM thread_participants WHERE thread_id = ? AND peer_id = ?
  `).run(threadId, peerId);
  return Number(result.changes) > 0;
}

export function listThreadParticipants(
  config: SynapseConfig,
  threadId: string,
): ThreadParticipant[] {
  return getDb(config).prepare(`
    SELECT thread_id AS threadId,
           peer_id   AS peerId,
           joined_at AS joinedAt
    FROM thread_participants WHERE thread_id = ?
    ORDER BY joined_at ASC
  `).all(threadId) as unknown as ThreadParticipant[];
}

export function listMyThreads(
  config: SynapseConfig,
  peerId: string,
): string[] {
  const rows = getDb(config).prepare(`
    SELECT thread_id AS threadId
    FROM thread_participants WHERE peer_id = ?
    ORDER BY joined_at DESC
  `).all(peerId);
  return (rows as Array<{ threadId: string }>).map(r => r.threadId);
}

// Return the most recent thread (by latest non-expired message) where
// both peers are participants. Used by synapse_send to detect when a
// caller is about to silently fragment an active conversation by
// omitting threadId — see §1.2 in the PR-readiness proposal.
export function findRecentSharedThread(
  config: SynapseConfig,
  peerA: string,
  peerB: string,
): string | null {
  const row = getDb(config).prepare(`
    SELECT m.thread_id AS threadId
    FROM messages m
    WHERE m.expires_at >= ?
      AND m.thread_id IN (
        SELECT thread_id FROM thread_participants WHERE peer_id = ?
        INTERSECT
        SELECT thread_id FROM thread_participants WHERE peer_id = ?
      )
    ORDER BY m.created_at DESC
    LIMIT 1
  `).get(new Date().toISOString(), peerA, peerB);
  return row ? (row as { threadId: string }).threadId : null;
}

// Count outbound messages from selfId that have NOT received a reply
// (i.e. no message exists with parent_id pointing at any of self's sent
// messages on the same thread). Returns the count and oldest_age in
// seconds. Used by hooks to surface "you have unreplied outbound" so
// agents don't go idle waiting on a peer that's still drafting.
export interface OutboundAwaitingReply {
  count: number;
  oldestAgeSec: number | null;
}

export function countOutboundAwaitingReply(
  config: SynapseConfig,
  selfId: string,
): OutboundAwaitingReply {
  const now = new Date().toISOString();
  const row = getDb(config).prepare(`
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
  if (!row) return { count: 0, oldestAgeSec: null };
  const count = Number((row as { n: number }).n ?? 0);
  const oldest = (row as { oldest: string | null }).oldest;
  const oldestAgeSec = oldest
    ? Math.floor((Date.now() - new Date(oldest).getTime()) / 1000)
    : null;
  return { count, oldestAgeSec };
}

// ── Active-file scan + staleness ───────────────────────────────────
// Source-of-truth predicates for the synapse_cleanup tool, the
// SessionStart hook GC, and any future tooling that has to reason
// about which active-<label>-*.json files are zombies. Keep all of
// "what is stale?" logic here so callers can't drift.

export interface ActiveFileInfo {
  path: string;
  name: string;
  mtimeMs: number;
  parsed: {
    id?: string;
    label?: string;
    sessionId?: string;
    ppid?: number;
    mcpPid?: number;
    registeredAt?: string;
    source?: string;
  } | null;
  parseError: boolean;
}

export function listActiveFiles(
  config: SynapseConfig,
  label?: string,
): ActiveFileInfo[] {
  const paths = buildIdentityPaths(config.dataDir);
  const prefix = label ? basename(paths.activePrefix(label)) : 'active-';
  let entries: string[] = [];
  try { entries = readdirSync(paths.dataDir); } catch { return []; }

  const out: ActiveFileInfo[] = [];
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const full = join(paths.dataDir, name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    let parsed: ActiveFileInfo['parsed'] = null;
    let parseError = false;
    try { parsed = JSON.parse(readFileSync(full, 'utf-8')); }
    catch { parseError = true; }
    out.push({ path: full, name, mtimeMs: stat.mtimeMs, parsed, parseError });
  }
  return out;
}

// Liveness check for an MCP process. Uses process.kill(pid, 0) — POSIX-ish
// no-op signal that returns true if the pid is owned by us and alive.
// Required for cross-platform reliability: on Windows-native, ppid in the
// active file is the SessionStart hook's parent (not the MCP server), so
// only mcpPid is a reliable liveness signal.
export function isPidAlive(pid: number | undefined | null): boolean {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

export interface StalenessReason {
  reason:
    | 'parse-error'
    | 'missing-id'
    | 'orphan-no-peer'
    | 'peer-silent'
    | 'mcp-pid-dead'
    | 'duplicate-session'
    | 'live';
  detail?: string;
}

// Decide whether an active file is stale relative to peers DB and config.
// `liveSessions` is the set of (label, sessionId) pairs we just confirmed
// live (e.g. the calling session) — never reaped regardless of other signals.
// Reasons in priority order: malformed file, no peer row, peer silent past
// cushion, MCP pid recorded but process dead, duplicate sessionId for the
// same label (newest mtime wins).
export function classifyActiveFile(
  config: SynapseConfig,
  info: ActiveFileInfo,
  opts: {
    keepIds?: Set<string>;
    duplicateOf?: ActiveFileInfo;
  } = {},
): StalenessReason {
  if (info.parseError || !info.parsed) {
    return { reason: 'parse-error' };
  }
  if (!info.parsed.id) {
    return { reason: 'missing-id' };
  }
  if (opts.keepIds?.has(info.parsed.id)) {
    return { reason: 'live', detail: 'kept by caller' };
  }
  if (opts.duplicateOf) {
    return {
      reason: 'duplicate-session',
      detail: `superseded by ${opts.duplicateOf.name}`,
    };
  }
  const peer = getPeer(config, info.parsed.id);
  if (!peer) {
    return { reason: 'orphan-no-peer' };
  }
  const cushionMs =
    config.peerHeartbeatTimeoutSeconds * 1000 * getPeerGcMultiplier();
  const ageMs = Date.now() - new Date(peer.lastSeenAt).getTime();
  if (ageMs > cushionMs) {
    return { reason: 'peer-silent', detail: `silent ${Math.round(ageMs / 1000)}s` };
  }
  if (info.parsed.mcpPid && !isPidAlive(info.parsed.mcpPid)) {
    return { reason: 'mcp-pid-dead', detail: `pid ${info.parsed.mcpPid}` };
  }
  return { reason: 'live' };
}

// Best-effort delete; never throws.
export function deleteActiveFile(info: ActiveFileInfo): boolean {
  try { unlinkSync(info.path); return true; }
  catch { return false; }
}

// True when the active file's name matches the v1.2+ canonical pattern
// `active-<label>-<sessionId>.json` where the discriminator is a UUID
// (not a small integer ppid). Used to prefer sessionId-keyed files over
// legacy ppid-keyed files that may share the same `id` and `sessionId`
// payload but were written by an older SessionStart hook.
export function isSessionIdKeyedActiveFile(info: ActiveFileInfo): boolean {
  const label = info.parsed?.label;
  const sid = info.parsed?.sessionId;
  if (!label || !sid) return false;
  return info.name === `active-${label}-${sid}.json`;
}

// Compute which active files are duplicates of which canonical file.
// Returns a map: stale path -> canonical info that supersedes it.
// Tiebreak rules (in order):
//   1. sessionId-keyed filename beats ppid-keyed filename.
//   2. Newer mtime wins.
// This is the single source of truth for "given two files claiming the
// same (label, sessionId), which one do we keep?" so synapse_cleanup and
// the SessionStart hook GC never disagree.
export function findActiveFileDuplicates(
  infos: ActiveFileInfo[],
): Map<string, ActiveFileInfo> {
  const winnerByKey = new Map<string, ActiveFileInfo>();
  const dupOf = new Map<string, ActiveFileInfo>();
  for (const f of infos) {
    const sid = f.parsed?.sessionId;
    const lbl = f.parsed?.label;
    if (!sid || !lbl) continue;
    const key = `${lbl}::${sid}`;
    const incumbent = winnerByKey.get(key);
    if (!incumbent) {
      winnerByKey.set(key, f);
      continue;
    }
    const challenger = preferActiveFile(incumbent, f);
    if (challenger === f) {
      dupOf.set(incumbent.path, f);
      winnerByKey.set(key, f);
    } else {
      dupOf.set(f.path, incumbent);
    }
  }
  return dupOf;
}

function preferActiveFile(a: ActiveFileInfo, b: ActiveFileInfo): ActiveFileInfo {
  const aSession = isSessionIdKeyedActiveFile(a);
  const bSession = isSessionIdKeyedActiveFile(b);
  if (aSession && !bSession) return a;
  if (bSession && !aSession) return b;
  return a.mtimeMs >= b.mtimeMs ? a : b;
}

export function listAudit(
  config: SynapseConfig,
  opts: { threadId?: string; callerId?: string; limit?: number } = {},
): AuditEntry[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.threadId) { where.push(`thread_id = ?`); params.push(opts.threadId); }
  if (opts.callerId) { where.push(`caller_id = ?`); params.push(opts.callerId); }
  const limit = opts.limit ?? 100;
  return getDb(config).prepare(`
    SELECT id,
           tool_name         AS toolName,
           caller_id         AS callerId,
           thread_id         AS threadId,
           origin_thread_id  AS originThreadId,
           origin_message_id AS originMessageId,
           args_hash         AS argsHash,
           result, reason,
           called_at         AS calledAt
    FROM audit_log
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY called_at DESC
    LIMIT ?
  `).all(...params, limit) as unknown as AuditEntry[];
}
