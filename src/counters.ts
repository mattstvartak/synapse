// §7 observability counters. Per-process in-memory metric store. Counts
// reset on daemon restart by design — they're a "since this daemon last
// started" view, not a historical record. Pair with the audit_log table
// in the SQLite store for persistent provenance and the optional
// jsonl audit log (SYNAPSE_AUDIT_LOG=1) for offline analysis.
//
// In daemon mode this module is loaded once per daemon process; in
// stdio mode (one MCP per Claude session) it's loaded once per session
// and resets every /mcp reconnect. That's fine — counters are a
// real-time signal, not durable.
//
// Bumps are simple integer increments. ~50 bumps per turn worst-case
// is trivially cheap. Snapshot reads are O(keys).

const counters = new Map<string, number>();
const startedAt = new Date().toISOString();
const startedAtMs = Date.now();

export function inc(key: string, by = 1): void {
  counters.set(key, (counters.get(key) ?? 0) + by);
}

export function get(key: string): number {
  return counters.get(key) ?? 0;
}

export function snapshot(): {
  counters: Record<string, number>;
  startedAt: string;
  uptimeSec: number;
} {
  const obj: Record<string, number> = {};
  // Sort keys for stable cross-call comparison.
  const keys = Array.from(counters.keys()).sort();
  for (const k of keys) obj[k] = counters.get(k)!;
  return {
    counters: obj,
    startedAt,
    uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
  };
}

// Test-only — never call in production code.
export function _resetForTests(): void {
  counters.clear();
}
