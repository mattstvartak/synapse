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
`;
