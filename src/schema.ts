// Single source of truth for the synapse SQLite schema. Both the
// MCP server (storage.ts) and the SessionStart hook (.mjs, runs before
// MCP) need to ensure the schema exists. Both must call EXACTLY this
// SQL so adding/altering a column happens in one place.

export const INIT_SCHEMA_SQL = `
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
    mode_by_side        TEXT NOT NULL,
    goal                TEXT,
    opened_by           TEXT,
    opened_at           TEXT,
    closed_at           TEXT,
    close_reason        TEXT,
    max_turns           INTEGER NOT NULL,
    max_wall_clock_sec  INTEGER NOT NULL,
    max_tokens_per_side INTEGER NOT NULL,
    turn_counts         TEXT NOT NULL,
    token_counts        TEXT NOT NULL
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
    result             TEXT NOT NULL,
    reason             TEXT,
    called_at          TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_audit_called    ON audit_log(called_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_caller    ON audit_log(caller_id, called_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_thread    ON audit_log(thread_id, called_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_origin    ON audit_log(origin_thread_id, called_at DESC);

  CREATE TABLE IF NOT EXISTS thread_participants (
    thread_id  TEXT NOT NULL,
    peer_id    TEXT NOT NULL,
    joined_at  TEXT NOT NULL,
    PRIMARY KEY (thread_id, peer_id)
  );

  CREATE INDEX IF NOT EXISTS idx_participants_peer ON thread_participants(peer_id);

  -- §4.8 typing presence. A peer can announce "I'm drafting a reply on
  -- thread X, ETA Y seconds" so wait_reply callers know whether to keep
  -- waiting or assume the peer is idle. Rows are short-lived; auto-cleared
  -- on next synapse_send/reply by the same peer on the same thread, or
  -- explicitly via synapse_clear_drafting, or by TTL.
  --
  -- The 'source' column tags origin: 'voluntary' (synapse_set_drafting
  -- explicit call) vs 'implicit' (inferred from a thread-read tool —
  -- synapse_thread / synapse_thread_state / synapse_thread_participants —
  -- with short TTL). Consumers see source in the wait_reply payload and
  -- can weight trust. Voluntary overrides implicit on conflict.
  -- §1.6 sub-bug fix (ghost-peer attribution / outbound-to-stale-id).
  -- When a shim's peer-id rotates (e.g. SessionStart hook minted A but
  -- daemon resolved to B for the same identity-token), we record A → B
  -- here. Outbound to A then auto-redirects to B with an audit entry.
  -- alias_id is the OLD peer-id; current_peer_id is the active one.
  -- One row per stale id; if a peer rotates again (B → C), we update
  -- alias_id=A's row to current=C and add a new row alias_id=B → C.
  CREATE TABLE IF NOT EXISTS peer_aliases (
    alias_id        TEXT PRIMARY KEY,
    current_peer_id TEXT NOT NULL,
    rotated_at      TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_peer_aliases_current ON peer_aliases(current_peer_id);

  CREATE TABLE IF NOT EXISTS drafting_state (
    thread_id  TEXT NOT NULL,
    peer_id    TEXT NOT NULL,
    started_at TEXT NOT NULL,
    eta_at     TEXT,
    source     TEXT NOT NULL DEFAULT 'voluntary',
    PRIMARY KEY (thread_id, peer_id)
  );

  -- §4.10 recruitment + auto-join. Recruiter calls synapse_recruit; daemon
  -- inserts a row here, broadcasts a [RECRUIT] marker message to matching
  -- prospects, and emits a [RECRUIT_EXPIRED] synthetic inbound message
  -- back to the originator on TTL expiry. Joiners are tracked via
  -- thread_participants (auto-joined to the recruit's threadId).
  --
  -- description_hash backs the 60s dedup window: recruiter retransmits the
  -- same description within 60s = suppress at daemon (counter
  -- recruit.dedupe_blocks).
  --
  -- Capabilities + exclude_caps are JSON arrays; require_all flips any-of
  -- vs all-of matching. Urgency ('low' | 'normal' | 'high') drives expiry
  -- TTL: low=10min, normal=5min, high=2min.
  CREATE TABLE IF NOT EXISTS recruits (
    id               TEXT PRIMARY KEY,
    originator_id    TEXT NOT NULL,
    thread_id        TEXT NOT NULL,
    description      TEXT NOT NULL,
    capabilities     TEXT,
    require_all      INTEGER NOT NULL DEFAULT 0,
    exclude_caps     TEXT,
    urgency          TEXT NOT NULL,
    originator_busy  INTEGER NOT NULL DEFAULT 1,
    workspace        TEXT,
    created_at       TEXT NOT NULL,
    expires_at       TEXT NOT NULL,
    fulfilled_at     TEXT,
    expired_at       TEXT,
    description_hash TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_recruits_expires    ON recruits(expires_at) WHERE expired_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_recruits_originator ON recruits(originator_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_recruits_dedup      ON recruits(originator_id, description_hash, created_at);

  -- §4.10 busy-state tracking. Idle = no row. Set busy = INSERT/REPLACE.
  -- Set idle = DELETE row (the IdleReason is recorded in audit_log only,
  -- not in this table — recruit-prospect sort consults the most recent
  -- idle audit entry per peer rather than a stored column).
  --
  -- Daemon-restart sweep clears all rows on startup so concurrent-binding
  -- restarts don't leak stale busy state. Stale-busy GC also removes rows
  -- where busy_at is older than 30min (configurable via
  -- SYNAPSE_BUSY_STALE_SEC, default 1800).
  --
  -- busy_reason is the BusyReason enum (free-form TEXT to keep schema
  -- forward-compatible with future reason codes); known values today:
  -- USER_DRIVEN, DRAFTING, EXPLICIT_BUSY, RECRUIT_ENGAGED.
  CREATE TABLE IF NOT EXISTS peer_busy_state (
    peer_id           TEXT PRIMARY KEY REFERENCES peers(id) ON DELETE CASCADE,
    busy_at           TEXT NOT NULL,
    busy_reason       TEXT NOT NULL,
    shim_fingerprint  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_busy_at ON peer_busy_state(busy_at);
`;

// Schema migrations for databases initialized against an older
// INIT_SCHEMA_SQL. CREATE TABLE IF NOT EXISTS is idempotent for FRESH
// dbs but won't add columns to existing tables. Each migration entry is
// a column-add probe via PRAGMA table_info + an ALTER TABLE if missing.
// Run after the initial schema execution in initSchema().
export interface ColumnMigration {
  table: string;
  column: string;
  alterSql: string;
}

export const COLUMN_MIGRATIONS: ColumnMigration[] = [
  {
    table: 'drafting_state',
    column: 'source',
    alterSql: `ALTER TABLE drafting_state ADD COLUMN source TEXT NOT NULL DEFAULT 'voluntary'`,
  },
];
