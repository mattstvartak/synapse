// ── Config ──────────────────────────────────────────────────────────

export interface SynapseConfig {
  dataDir: string;
  defaultTtlSeconds: number;
  peerHeartbeatTimeoutSeconds: number;
}

export const DEFAULT_CONFIG: SynapseConfig = {
  dataDir: '',
  defaultTtlSeconds: 86_400,         // 24h
  peerHeartbeatTimeoutSeconds: 600,  // 10 min
};

// ── Peer ────────────────────────────────────────────────────────────

export interface Peer {
  id: string;            // e.g. "code-a3f9b2c1"
  label: string;         // human-friendly, e.g. "code"
  registeredAt: string;
  lastSeenAt: string;
  capabilities: string | null;  // JSON-serialized string array
}

// ── Message ─────────────────────────────────────────────────────────

export interface Message {
  id: string;
  fromId: string;
  toId: string;          // peer id, or "broadcast"
  threadId: string;
  parentId: string | null;
  body: string;
  workspace: string | null;
  createdAt: string;
  expiresAt: string;
  readAt: string | null;
}

export const BROADCAST = 'broadcast' as const;
export const THREAD_PREFIX = 'thread:' as const;

// Address resolution: a `to` field can be a peer ID, "broadcast", or
// "thread:<threadId>". The thread variant fans out to all participants
// (excluding sender), enabling clean group splits across many sessions.
export function isThreadAddress(to: string): boolean {
  return to.startsWith(THREAD_PREFIX);
}

export function threadIdFromAddress(to: string): string | null {
  return to.startsWith(THREAD_PREFIX) ? to.slice(THREAD_PREFIX.length) : null;
}

// ── Per-Code-window state file paths ───────────────────────────────
// v1.2: state files are keyed on Claude Code's `session_id` (passed to
// SessionStart hooks via stdin). This survives the Windows-native ppid
// divergence where Claude Code spawns hook vs MCP through different
// intermediate processes. Legacy ppid-keyed paths kept for backward
// compatibility — written alongside session-keyed files for one release
// and read as a fallback when no session_id is available.

export interface IdentityPaths {
  // Session-keyed (preferred): UUID matches Claude Code's hook session_id.
  active(label: string, sessionId: string): string;
  autoState(label: string, sessionId: string): string;
  // PID-keyed (legacy fallback for sessions started before v1.2 hooks).
  activeByPpid(label: string, ppid: number): string;
  autoStateByPpid(label: string, ppid: number): string;
  // Filename prefixes used by the MCP server to scan for the freshest
  // active file when no session_id env var is exposed by Claude Code.
  // Returned strings are absolute paths up to (but not including) the
  // discriminator suffix — caller globs `${prefix}*.json`.
  activePrefix(label: string): string;
  autoStatePrefix(label: string): string;
  // Data directory itself, exposed so callers can readdirSync without
  // duplicating the dataDir reference.
  dataDir: string;
}

export function buildIdentityPaths(dataDir: string): IdentityPaths {
  return {
    active: (label, sessionId) => `${dataDir}/active-${label}-${sessionId}.json`,
    autoState: (label, sessionId) => `${dataDir}/auto-state-${label}-${sessionId}.json`,
    activeByPpid: (label, ppid) => `${dataDir}/active-${label}-${ppid}.json`,
    autoStateByPpid: (label, ppid) => `${dataDir}/auto-state-${label}-${ppid}.json`,
    activePrefix: (label) => `${dataDir}/active-${label}-`,
    autoStatePrefix: (label) => `${dataDir}/auto-state-${label}-`,
    dataDir,
  };
}

// ── Thread state (autonomous mode) ─────────────────────────────────

export type ThreadMode = 'review' | 'auto';

export type ThreadCloseReason =
  | 'paused'           // synapse_pause
  | 'turn_cap'         // hit maxTurns
  | 'wall_clock'       // hit maxWallClockSec
  | 'token_cap'        // hit maxTokensPerSide on either side
  | 'goal_reached'     // explicit declare-done
  | 'convergence';     // 3x agreement on next step (v2)

export interface Thread {
  threadId: string;
  // Per-side mode — supports asymmetric autonomy ("Cowork drives, Code reviews").
  modeBySide: Record<string, ThreadMode>;  // peerId -> mode
  goal: string | null;
  openedBy: string | null;           // peerId who called synapse_open_auto
  openedAt: string | null;
  closedAt: string | null;
  closeReason: ThreadCloseReason | null;
  maxTurns: number;
  maxWallClockSec: number;
  maxTokensPerSide: number;
  // Per-side counters (peerId -> count). Persisted as JSON.
  turnCounts: Record<string, number>;
  tokenCounts: Record<string, number>;
}

export const DEFAULT_AUTO_CAPS = {
  maxTurns: 8,
  maxWallClockSec: 600,        // 10 min
  maxTokensPerSide: 50_000,
} as const;

// ── Thread participation roster ────────────────────────────────────

export interface ThreadParticipant {
  threadId: string;
  peerId: string;
  joinedAt: string;
}

// ── Provenance audit log ───────────────────────────────────────────

export interface AuditEntry {
  id: string;
  toolName: string;
  callerId: string;            // peer id that invoked the tool
  threadId: string | null;     // thread context, if any
  originThreadId: string | null;
  originMessageId: string | null;
  argsHash: string;            // sha256 of args, truncated
  result: 'allowed' | 'blocked';
  reason: string | null;       // why blocked (if blocked)
  calledAt: string;
}
