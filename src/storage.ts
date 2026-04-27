import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  SynapseConfig, Peer, Message, Thread, ThreadMode, ThreadCloseReason, AuditEntry,
  ThreadParticipant,
} from './types.js';
import { buildIdentityPaths } from './types.js';
import { INIT_SCHEMA_SQL, COLUMN_MIGRATIONS } from './schema.js';

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
  // Apply additive column migrations for dbs initialized against older
  // schema versions. PRAGMA table_info returns one row per column; if
  // the target column isn't present, run the ALTER. ALTER ADD COLUMN is
  // safe under concurrent readers in WAL mode (sqlite acquires a brief
  // exclusive lock; ongoing reads see the old shape until commit).
  for (const m of COLUMN_MIGRATIONS) {
    const cols = d.prepare(`PRAGMA table_info(${m.table})`).all() as Array<{ name: string }>;
    if (cols.length === 0) continue; // table itself doesn't exist yet — CREATE will have handled it above
    const has = cols.some(c => c.name === m.column);
    if (!has) {
      try { d.exec(m.alterSql); }
      catch (err) {
        // Best-effort. If migration fails (e.g. concurrent migrator),
        // log and continue — the column may already be present and a
        // double-add is the most likely error.
        process.stderr.write(`synapse: schema migration ${m.table}.${m.column} failed: ${(err as Error).message}\n`);
      }
    }
  }
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

export interface InboxHead {
  count: number;
  oldestUnreadAgeSec: number | null;
  fromPeerIds: string[];
}

// HEAD-style inbox check — same WHERE shape as pollInbox but returns
// only counts + sender list, no message bodies. Used by synapse_poll_head
// to give the agent a cheap "is there anything?" check (~50 tokens vs
// ~300-1500 for full poll). Paired with full poll only when count > 0.
export function pollInboxHead(
  config: SynapseConfig,
  selfId: string,
  opts: PollOptions = {},
): InboxHead {
  pruneExpired(config);
  const { since, unreadOnly = true, workspace } = opts;

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

  const whereSql = where.join(' AND ');
  const db = getDb(config);

  const aggRow = db.prepare(`
    SELECT COUNT(*) AS n,
           MIN(created_at) AS oldest
    FROM messages
    WHERE ${whereSql}
  `).get(...params) as { n: number; oldest: string | null } | undefined;

  const count = Number(aggRow?.n ?? 0);
  const oldest = aggRow?.oldest ?? null;
  const oldestUnreadAgeSec = oldest
    ? Math.floor((Date.now() - new Date(oldest).getTime()) / 1000)
    : null;

  if (count === 0) return { count: 0, oldestUnreadAgeSec: null, fromPeerIds: [] };

  const senderRows = db.prepare(`
    SELECT DISTINCT from_id AS fromId
    FROM messages
    WHERE ${whereSql}
    LIMIT 20
  `).all(...params) as Array<{ fromId: string }>;
  const fromPeerIds = senderRows.map(r => r.fromId);

  return { count, oldestUnreadAgeSec, fromPeerIds };
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

// §1.6 sub-bug — peer-id alias table. When a shim's peer-id rotates
// (token resolved to A pre-restart, B post-restart, or hook-minted A
// vs daemon-minted B), we record the old → new mapping here so messages
// addressed to the stale id can be transparently auto-redirected to
// the current one in synapse_send/reply. Closes the "ghost-peer
// attribution" gap.

export function writePeerAlias(
  config: SynapseConfig,
  aliasId: string,
  currentPeerId: string,
): void {
  if (aliasId === currentPeerId) return; // self-pointing alias is meaningless
  const now = new Date().toISOString();
  // If the alias already points somewhere else, update to the new
  // current_peer_id (rotation chain collapses to latest).
  getDb(config).prepare(`
    INSERT INTO peer_aliases (alias_id, current_peer_id, rotated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(alias_id) DO UPDATE SET
      current_peer_id = excluded.current_peer_id,
      rotated_at      = excluded.rotated_at
  `).run(aliasId, currentPeerId, now);
  // If currentPeerId itself is in the alias table (i.e. someone earlier
  // rotated to currentPeerId, but it has since rotated again), follow
  // the chain by updating the OLD alias too. Single SQL pass.
  getDb(config).prepare(`
    UPDATE peer_aliases SET current_peer_id = ?, rotated_at = ?
    WHERE current_peer_id = ?
  `).run(currentPeerId, now, aliasId);
}

// Resolve a peer-id to its CURRENT id following any aliases. Returns
// the input unchanged if no alias exists. Single lookup; aliases are
// stored already-collapsed (writePeerAlias updates the chain) so we
// don't recurse here.
export function resolvePeerAlias(
  config: SynapseConfig,
  peerId: string,
): string {
  const row = getDb(config).prepare(
    `SELECT current_peer_id AS currentId FROM peer_aliases WHERE alias_id = ?`,
  ).get(peerId) as { currentId: string } | undefined;
  return row?.currentId ?? peerId;
}

// §4.7 capability advertising — peer announces what kinds of work it
// can route. Stored as a JSON array on peers.capabilities. Senders use
// it to disambiguate when multiple peers share a label, and §4.8/§5.5
// gate behaviors on specific capability tags (e.g. supports_drafting_signal,
// dialect_v0).
export function setPeerCapabilities(
  config: SynapseConfig,
  peerId: string,
  tags: string[],
): void {
  // Dedupe + sort for stable comparisons across peers.
  const cleaned = Array.from(new Set(tags.filter(t => typeof t === 'string' && t.length > 0))).sort();
  const json = cleaned.length > 0 ? JSON.stringify(cleaned) : null;
  getDb(config).prepare(
    `UPDATE peers SET capabilities = ? WHERE id = ?`,
  ).run(json, peerId);
}

// Helper used by add/remove tools — read current capabilities as a parsed
// array, return [] for null / parse-error.
export function getPeerCapabilities(
  config: SynapseConfig,
  peerId: string,
): string[] {
  const row = getDb(config).prepare(
    `SELECT capabilities FROM peers WHERE id = ?`,
  ).get(peerId) as { capabilities: string | null } | undefined;
  if (!row || !row.capabilities) return [];
  try {
    const parsed = JSON.parse(row.capabilities);
    return Array.isArray(parsed) ? parsed.filter(t => typeof t === 'string') : [];
  } catch { return []; }
}

// §4.7 additive tool — merges new tags into existing set without
// stomping. Sender registers a fresh capability without having to
// re-list everything they already advertised. Idempotent: adding a
// tag already present is a no-op.
export function addPeerCapabilities(
  config: SynapseConfig,
  peerId: string,
  tagsToAdd: string[],
): string[] {
  const current = getPeerCapabilities(config, peerId);
  const merged = Array.from(new Set([
    ...current,
    ...tagsToAdd.filter(t => typeof t === 'string' && t.length > 0),
  ])).sort();
  setPeerCapabilities(config, peerId, merged);
  return merged;
}

// §4.7 additive tool — removes specific tags from the existing set.
// Idempotent: removing a tag not present is a no-op.
export function removePeerCapabilities(
  config: SynapseConfig,
  peerId: string,
  tagsToRemove: string[],
): string[] {
  const current = getPeerCapabilities(config, peerId);
  const removeSet = new Set(tagsToRemove);
  const remaining = current.filter(t => !removeSet.has(t)).sort();
  setPeerCapabilities(config, peerId, remaining);
  return remaining;
}

// §4.8 typing presence. A peer announces "I'm drafting on thread X, ETA Ys"
// so wait_reply callers know whether to keep waiting. Auto-cleared by the
// next synapse_send/reply from the same peer on the same thread (the act
// of sending IS the "done drafting" signal).

export type DraftingSource = 'voluntary' | 'implicit';

export interface DraftingState {
  threadId: string;
  peerId: string;
  startedAt: string;
  etaAt: string | null;
  source: DraftingSource;
  startedAgeSec: number;
  etaInSec: number | null;
}

// Voluntary set — explicit synapse_set_drafting call. Always overwrites
// any prior row for this (thread, peer), including implicit ones.
export function setDrafting(
  config: SynapseConfig,
  threadId: string,
  peerId: string,
  etaSec: number | null,
): void {
  const now = new Date();
  const etaAt = etaSec !== null && Number.isFinite(etaSec) && etaSec > 0
    ? new Date(now.getTime() + etaSec * 1000).toISOString()
    : null;
  getDb(config).prepare(`
    INSERT INTO drafting_state (thread_id, peer_id, started_at, eta_at, source)
    VALUES (?, ?, ?, ?, 'voluntary')
    ON CONFLICT(thread_id, peer_id) DO UPDATE SET
      started_at = excluded.started_at,
      eta_at     = excluded.eta_at,
      source     = 'voluntary'
  `).run(threadId, peerId, now.toISOString(), etaAt);
}

// §4.8 implicit drafting — peer touched a thread-read tool. Tagged so
// consumers know it's heuristic-grade. Default TTL is short (60s) since
// "looked at thread" is a weak signal. Does NOT downgrade an existing
// voluntary row — voluntary always wins.
export function markImplicitDrafting(
  config: SynapseConfig,
  threadId: string,
  peerId: string,
  ttlSec = 60,
): void {
  const now = new Date();
  const etaAt = new Date(now.getTime() + ttlSec * 1000).toISOString();
  getDb(config).prepare(`
    INSERT INTO drafting_state (thread_id, peer_id, started_at, eta_at, source)
    VALUES (?, ?, ?, ?, 'implicit')
    ON CONFLICT(thread_id, peer_id) DO UPDATE SET
      started_at = excluded.started_at,
      eta_at     = excluded.eta_at
      WHERE drafting_state.source = 'implicit'
  `).run(threadId, peerId, now.toISOString(), etaAt);
}

export function clearDrafting(
  config: SynapseConfig,
  threadId: string,
  peerId: string,
): boolean {
  const result = getDb(config).prepare(
    `DELETE FROM drafting_state WHERE thread_id = ? AND peer_id = ?`,
  ).run(threadId, peerId);
  return Number(result.changes) > 0;
}

// Drafting state for all peers currently drafting on a thread, EXCLUDING
// the caller. The caller's own drafting state isn't useful to itself.
// Filters expired rows (eta_at past) so consumers don't see ghost flags
// from agents that polled-and-then-walked-away. Implicit-source flags
// always carry an eta_at so this filter cleans them up automatically.
export function getOtherPeersDrafting(
  config: SynapseConfig,
  threadId: string,
  excludePeerId: string,
): DraftingState[] {
  const nowIso = new Date().toISOString();
  const rows = getDb(config).prepare(`
    SELECT thread_id  AS threadId,
           peer_id    AS peerId,
           started_at AS startedAt,
           eta_at     AS etaAt,
           source     AS source
    FROM drafting_state
    WHERE thread_id = ? AND peer_id != ?
      AND (eta_at IS NULL OR eta_at >= ?)
  `).all(threadId, excludePeerId, nowIso) as Array<{
    threadId: string; peerId: string; startedAt: string;
    etaAt: string | null; source: string;
  }>;

  const now = Date.now();
  return rows.map(r => ({
    threadId: r.threadId,
    peerId: r.peerId,
    startedAt: r.startedAt,
    etaAt: r.etaAt,
    source: (r.source === 'implicit' ? 'implicit' : 'voluntary') as DraftingSource,
    startedAgeSec: Math.floor((now - new Date(r.startedAt).getTime()) / 1000),
    etaInSec: r.etaAt
      ? Math.max(0, Math.floor((new Date(r.etaAt).getTime() - now) / 1000))
      : null,
  }));
}

// §2.4 — Threads where any peer I've messaged is participating, but I'm
// NOT already on the roster. Read-only discovery surface; agents call
// synapse_join_thread explicitly to opt in. Returns per-thread metadata
// only (no message bodies) so the agent can decide whether the thread
// is worth joining without fetching content.
export interface VisibleThread {
  threadId: string;
  participantCount: number;
  participantLabels: string[];
  lastMessageAt: string | null;
  lastMessageAgeSec: number | null;
}

export function listVisibleThreads(
  config: SynapseConfig,
  selfId: string,
  limit = 50,
): VisibleThread[] {
  pruneExpired(config);
  const db = getDb(config);

  // Rows: threadId + participantCount + lastMessageAt for threads that
  //   - have at least one participant matching a peer I've messaged
  //     (direct send or direct receive — broadcasts and thread-fanouts
  //     don't count because they're not relationship-establishing)
  //   - I'm NOT on the roster of
  //   - have at least one non-expired message (filters dead/empty threads)
  const rows = db.prepare(`
    WITH my_known_peers AS (
      SELECT DISTINCT to_id AS peer_id
      FROM messages
      WHERE from_id = ?
        AND to_id != 'broadcast'
        AND to_id NOT LIKE 'thread:%'
        AND to_id != ?
      UNION
      SELECT DISTINCT from_id AS peer_id
      FROM messages
      WHERE to_id = ?
        AND from_id != ?
    )
    SELECT v.thread_id AS threadId,
           (SELECT COUNT(*) FROM thread_participants WHERE thread_id = v.thread_id) AS participantCount,
           (SELECT MAX(created_at) FROM messages WHERE thread_id = v.thread_id AND expires_at >= ?) AS lastMessageAt
    FROM (
      SELECT DISTINCT tp.thread_id
      FROM thread_participants tp
      WHERE tp.peer_id IN (SELECT peer_id FROM my_known_peers)
        AND tp.thread_id NOT IN (
          SELECT thread_id FROM thread_participants WHERE peer_id = ?
        )
    ) v
    WHERE (SELECT MAX(created_at) FROM messages WHERE thread_id = v.thread_id AND expires_at >= ?) IS NOT NULL
    ORDER BY lastMessageAt DESC
    LIMIT ?
  `).all(
    selfId, selfId,
    selfId, selfId,
    new Date().toISOString(),
    selfId,
    new Date().toISOString(),
    limit,
  ) as Array<{ threadId: string; participantCount: number; lastMessageAt: string | null }>;

  if (rows.length === 0) return [];

  // Fetch participant labels per thread in one round trip.
  const threadIds = rows.map(r => r.threadId);
  const placeholders = threadIds.map(() => '?').join(',');
  const labelRows = db.prepare(`
    SELECT tp.thread_id AS threadId,
           p.label AS label
    FROM thread_participants tp
    JOIN peers p ON p.id = tp.peer_id
    WHERE tp.thread_id IN (${placeholders})
  `).all(...threadIds) as Array<{ threadId: string; label: string }>;

  const labelsByThread = new Map<string, Set<string>>();
  for (const row of labelRows) {
    if (!labelsByThread.has(row.threadId)) labelsByThread.set(row.threadId, new Set());
    labelsByThread.get(row.threadId)!.add(row.label);
  }

  const now = Date.now();
  return rows.map(r => ({
    threadId: r.threadId,
    participantCount: r.participantCount,
    participantLabels: Array.from(labelsByThread.get(r.threadId) ?? []).sort(),
    lastMessageAt: r.lastMessageAt,
    lastMessageAgeSec: r.lastMessageAt
      ? Math.floor((now - new Date(r.lastMessageAt).getTime()) / 1000)
      : null,
  }));
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
