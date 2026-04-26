import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SynapseConfig, Peer, Message, Thread, ThreadMode, ThreadCloseReason, AuditEntry,
  ThreadParticipant,
} from './types.js';

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
  d.exec(`
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

    CREATE TABLE IF NOT EXISTS threads (
      thread_id           TEXT PRIMARY KEY,
      mode_by_side        TEXT NOT NULL,         -- JSON: { peerId: "review"|"auto" }
      goal                TEXT,
      opened_by           TEXT,
      opened_at           TEXT,
      closed_at           TEXT,
      close_reason        TEXT,
      max_turns           INTEGER NOT NULL,
      max_wall_clock_sec  INTEGER NOT NULL,
      max_tokens_per_side INTEGER NOT NULL,
      turn_counts         TEXT NOT NULL,         -- JSON: { peerId: count }
      token_counts        TEXT NOT NULL          -- JSON: { peerId: count }
    );

    CREATE INDEX IF NOT EXISTS idx_threads_open ON threads(closed_at) WHERE closed_at IS NULL;

    CREATE TABLE IF NOT EXISTS audit_log (
      id                 TEXT PRIMARY KEY,
      tool_name          TEXT NOT NULL,
      caller_id          TEXT NOT NULL,
      thread_id          TEXT,
      origin_thread_id   TEXT,
      origin_message_id  TEXT,
      args_hash          TEXT NOT NULL,
      result             TEXT NOT NULL,           -- 'allowed' | 'blocked'
      reason             TEXT,
      called_at          TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_called    ON audit_log(called_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_caller    ON audit_log(caller_id, called_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_thread    ON audit_log(thread_id, called_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_origin    ON audit_log(origin_thread_id, called_at DESC);

    -- thread_participants: who is "in" a thread for fan-out routing.
    -- Joining is explicit (synapse_join_thread) or implicit (sending/replying
    -- on a thread:<id>, opening auto on the thread). Inbox surfaces messages
    -- where to_id = "thread:<id>" only to peers in this table for that thread.
    CREATE TABLE IF NOT EXISTS thread_participants (
      thread_id  TEXT NOT NULL,
      peer_id    TEXT NOT NULL,
      joined_at  TEXT NOT NULL,
      PRIMARY KEY (thread_id, peer_id)
    );

    CREATE INDEX IF NOT EXISTS idx_participants_peer ON thread_participants(peer_id);
  `);
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

export function pruneStalePeers(config: SynapseConfig): number {
  // Hard-prune peers silent for 6× the heartbeat window.
  const cutoff = new Date(Date.now() - config.peerHeartbeatTimeoutSeconds * 6_000).toISOString();
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
