#!/usr/bin/env node

import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { loadConfig } from './config.js';
import { logAudit } from './storage.js';
import type { AuditEntry } from './types.js';
import { buildIdentityPaths } from './types.js';

const HELP = `synapse-mcp — cross-client bridge

Usage:
  synapse-mcp                                              run MCP stdio server
  synapse-mcp daemon                                       run as long-lived HTTP daemon (multi-client)
  synapse-mcp shim                                         run as stdio→HTTP shim (connects to daemon)
  synapse-mcp audit-log <toolName> <result> [reason]       record a hook-side audit entry
  synapse-mcp help                                         this message

audit-log:
  toolName    Tool that was about to be invoked (e.g. "Bash", "Edit")
  result      "allowed" | "blocked"
  reason      optional — required when result=blocked

  Reads SYNAPSE_LABEL to derive caller, plus the matching active session file
  to derive caller peer ID, plus auto-state-<label>.json for thread context.
  Writes to the audit_log table. Always exits 0; never crashes the hook.

Environment:
  SYNAPSE_DATA_DIR              data directory (default ~/.claude/synapse)
  SYNAPSE_LABEL                 client label (required for audit-log + shim)
  SYNAPSE_TTL_SECONDS           default message TTL (default 86400 = 24h)
  SYNAPSE_PEER_TIMEOUT_SECONDS  peer heartbeat window (default 600 = 10 min)
  SYNAPSE_DAEMON_PORT           daemon listen port (default 8765)
  SYNAPSE_DAEMON_URL            shim target URL (default http://127.0.0.1:8765)
`;

// Returns the absolute path of the most-recently modified file in `dir`
// whose basename starts with `prefix` and ends with .json, modified within
// `maxAgeMs`. Returns null if no candidate found. Used to locate the
// active session file when neither session_id env nor ppid-keyed path
// matches — the SessionStart hook always writes a fresh file before MCP
// or hook-side audit calls execute, so freshest-within-window is reliable
// for the single-window-per-label case.
function pickFreshestFile(dir: string, prefix: string, maxAgeMs: number): string | null {
  const filenamePrefix = basename(prefix);
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return null; }
  const cutoff = Date.now() - maxAgeMs;
  let bestPath: string | null = null;
  let bestMtime = -Infinity;
  for (const name of entries) {
    if (!name.startsWith(filenamePrefix) || !name.endsWith('.json')) continue;
    const full = `${dir}/${name}`;
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;
    if (stat.mtimeMs > bestMtime) {
      bestMtime = stat.mtimeMs;
      bestPath = full;
    }
  }
  return bestPath;
}

function runAuditLog(args: string[]): void {
  // Best-effort: any failure exits 0 — hook callers must not be broken.
  try {
    const [toolName, result, ...reasonParts] = args;
    if (!toolName || (result !== 'allowed' && result !== 'blocked')) {
      process.stderr.write(`synapse-mcp audit-log: usage: <toolName> <allowed|blocked> [reason]\n`);
      return;
    }
    const reason = reasonParts.length > 0 ? reasonParts.join(' ') : null;

    const label = process.env.SYNAPSE_LABEL;
    if (!label) {
      process.stderr.write(`synapse-mcp audit-log: SYNAPSE_LABEL not set; skipping\n`);
      return;
    }

    const config = loadConfig();
    const paths = buildIdentityPaths(config.dataDir);
    const ppid = process.ppid;

    // Adoption order matches MCP server:
    //   1. CLAUDE_SESSION_ID env (cheapest if Claude Code exposes it)
    //   2. Freshest active-<label>-*.json modified within heartbeat window
    //   3. Legacy active-<label>-<ppid>.json
    //   4. Legacy unscoped active-<label>.json
    let activePath: string | null = null;
    const envSession = process.env.CLAUDE_SESSION_ID;
    if (envSession) {
      const candidate = paths.active(label, envSession);
      if (existsSync(candidate)) activePath = candidate;
    }
    if (!activePath) {
      activePath = pickFreshestFile(config.dataDir, paths.activePrefix(label), config.peerHeartbeatTimeoutSeconds * 1000);
    }
    if (!activePath) {
      const candidate = paths.activeByPpid(label, ppid);
      if (existsSync(candidate)) activePath = candidate;
    }
    if (!activePath) {
      const candidate = `${config.dataDir}/active-${label}.json`;
      if (existsSync(candidate)) activePath = candidate;
    }

    let callerId = `unknown-${label}`;
    let sessionId: string | null = null;
    if (activePath) {
      try {
        const parsed = JSON.parse(readFileSync(activePath, 'utf-8')) as { id?: string; sessionId?: string };
        if (parsed.id) callerId = parsed.id;
        if (parsed.sessionId) sessionId = parsed.sessionId;
      } catch { /* fall through */ }
    }

    let threadId: string | null = null;
    let autoStatePath: string | null = null;
    if (sessionId) {
      const candidate = paths.autoState(label, sessionId);
      if (existsSync(candidate)) autoStatePath = candidate;
    }
    if (!autoStatePath) {
      autoStatePath = pickFreshestFile(config.dataDir, paths.autoStatePrefix(label), config.peerHeartbeatTimeoutSeconds * 1000);
    }
    if (!autoStatePath) {
      const candidate = paths.autoStateByPpid(label, ppid);
      if (existsSync(candidate)) autoStatePath = candidate;
    }
    if (!autoStatePath) {
      const candidate = `${config.dataDir}/auto-state-${label}.json`;
      if (existsSync(candidate)) autoStatePath = candidate;
    }
    if (autoStatePath) {
      try {
        const parsed = JSON.parse(readFileSync(autoStatePath, 'utf-8')) as { threadId?: string };
        if (parsed.threadId) threadId = parsed.threadId;
      } catch { /* fall through */ }
    }

    const entry: AuditEntry = {
      id: randomUUID(),
      toolName,
      callerId,
      threadId,
      originThreadId: threadId,
      originMessageId: null,
      argsHash: createHash('sha256').update(toolName).digest('hex').slice(0, 16),
      result,
      reason,
      calledAt: new Date().toISOString(),
    };
    logAudit(config, entry);
  } catch (err) {
    process.stderr.write(`synapse-mcp audit-log: ${(err as Error).message}\n`);
    // never re-throw
  }
}

async function main(): Promise<void> {
  const [, , sub, ...rest] = process.argv;

  if (!sub || sub.startsWith('-')) {
    await import('./server.js');
    return;
  }

  switch (sub) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;
    case 'audit-log':
      runAuditLog(rest);
      return;
    case 'daemon': {
      const { runDaemon } = await import('./daemon.js');
      await runDaemon();
      return;
    }
    case 'shim': {
      const { runShim } = await import('./shim.js');
      await runShim();
      return;
    }
    default:
      process.stderr.write(`synapse-mcp: unknown subcommand "${sub}"\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch(err => {
  process.stderr.write(`synapse-mcp: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});

// Suppress unused-import lints when the dataDir path is computed inline.
void homedir;
