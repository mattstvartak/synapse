/**
 * Synapse shim — stdio→HTTP proxy that bridges a Claude client's stdio
 * MCP transport to a long-lived synapse daemon over localhost HTTP.
 *
 * Responsibilities:
 *   - Read/write identity token at <dataDir>/<label>-identity.json so the
 *     daemon resolves the same peer ID on every reconnect (sticky identity).
 *   - Auto-spawn the daemon (detached) if no `daemon.json` is present or
 *     the recorded pid is dead.
 *   - Forward each JSON-RPC line on stdin to the daemon's POST /mcp,
 *     echo the JSON response on stdout. Mcp-Session-Id round-trips so the
 *     daemon can route subsequent requests to the right per-session
 *     transport.
 *   - On daemon crash mid-session, emit a JSON-RPC error reply for the
 *     in-flight request and exit non-zero so Claude reconnects fresh.
 *
 * Env:
 *   SYNAPSE_LABEL          required
 *   SYNAPSE_DATA_DIR       default ~/.claude/synapse
 *   SYNAPSE_DAEMON_URL     default http://127.0.0.1:8765
 *   SYNAPSE_DAEMON_PORT    used during auto-spawn (default 8765)
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

interface DaemonState {
  port: number;
  pid: number;
  token: string;
  startedAt: string;
}

interface IdentityFile {
  identityToken: string;
  // peerId is informational; daemon is authoritative.
  peerId?: string;
}

function dataDir(): string {
  return process.env.SYNAPSE_DATA_DIR ?? join(homedir(), '.claude', 'synapse');
}

function daemonStatePath(): string {
  return join(dataDir(), 'daemon.json');
}

function identityPath(label: string): string {
  return join(dataDir(), `${label}-identity.json`);
}

function readDaemonState(): DaemonState | null {
  if (!existsSync(daemonStatePath())) return null;
  try { return JSON.parse(readFileSync(daemonStatePath(), 'utf-8')) as DaemonState; }
  catch { return null; }
}

function isPidAlive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function readIdentity(label: string): IdentityFile {
  const path = identityPath(label);
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, 'utf-8')) as IdentityFile; }
    catch { /* fall through and mint */ }
  }
  // Mint a fresh token. Daemon will bind it to a peer on first /identity
  // call, and the response writes the peerId back via writeIdentity.
  const fresh: IdentityFile = { identityToken: randomUUID() };
  writeIdentity(label, fresh);
  return fresh;
}

function writeIdentity(label: string, identity: IdentityFile): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(identityPath(label), JSON.stringify(identity, null, 2), 'utf-8');
}

async function probeDaemon(state: DaemonState): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/health`, {
      headers: { Authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch { return false; }
}

async function spawnDaemon(): Promise<DaemonState> {
  // Spawn detached so the daemon outlives this shim. Stdio piped to
  // /dev/null-equivalent (ignore) so node doesn't keep refs alive.
  const here = fileURLToPath(import.meta.url);
  const cliPath = join(here, '..', 'cli.js');
  const child = spawn(process.execPath, [cliPath, 'daemon'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  // Poll daemon.json until the new daemon writes its state.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
    const state = readDaemonState();
    if (state && state.pid === child.pid && isPidAlive(state.pid)) {
      const healthy = await probeDaemon(state);
      if (healthy) return state;
    }
  }
  throw new Error('synapse-shim: failed to spawn daemon (timeout waiting for daemon.json)');
}

async function ensureDaemon(): Promise<DaemonState> {
  const state = readDaemonState();
  if (state && isPidAlive(state.pid)) {
    if (await probeDaemon(state)) return state;
  }
  return spawnDaemon();
}

async function negotiateIdentity(
  state: DaemonState,
  label: string,
  identity: IdentityFile,
): Promise<IdentityFile> {
  const url = (process.env.SYNAPSE_DAEMON_URL ?? `http://127.0.0.1:${state.port}`).replace(/\/$/, '');
  const res = await fetch(`${url}/identity`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.token}`,
    },
    body: JSON.stringify({ label, identityToken: identity.identityToken }),
  });
  if (!res.ok) {
    throw new Error(`synapse-shim: /identity returned ${res.status} ${res.statusText}`);
  }
  const body = await res.json() as { peerId?: string; identityToken?: string };
  const updated: IdentityFile = {
    identityToken: body.identityToken ?? identity.identityToken,
    peerId: body.peerId,
  };
  if (
    updated.identityToken !== identity.identityToken ||
    updated.peerId !== identity.peerId
  ) {
    writeIdentity(label, updated);
  }
  return updated;
}

export async function runShim(): Promise<void> {
  const label = process.env.SYNAPSE_LABEL;
  if (!label) {
    process.stderr.write('synapse-shim: SYNAPSE_LABEL is required\n');
    process.exit(2);
  }

  const state = await ensureDaemon();
  const identity = readIdentity(label);
  // Confirm identity with daemon before forwarding any frames so the very
  // first MCP call already has a stable peer ID.
  await negotiateIdentity(state, label, identity);

  const url = (process.env.SYNAPSE_DAEMON_URL ?? `http://127.0.0.1:${state.port}`).replace(/\/$/, '');
  let mcpSessionId: string | null = null;

  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let body: unknown;
    try { body = JSON.parse(line); }
    catch (err) {
      process.stderr.write(`synapse-shim: drop malformed stdin frame: ${(err as Error).message}\n`);
      return;
    }
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        // The MCP Streamable HTTP transport rejects requests that don't
        // advertise BOTH content types in Accept, even when the server
        // is configured to return plain JSON (enableJsonResponse=true).
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${state.token}`,
        'X-Synapse-Label': label,
        'X-Synapse-Identity-Token': identity.identityToken,
      };
      if (mcpSessionId) headers['Mcp-Session-Id'] = mcpSessionId;

      const res = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const sid = res.headers.get('mcp-session-id');
      if (sid) mcpSessionId = sid;

      if (res.status === 202) {
        // Notification accepted, no body.
        return;
      }

      const text = await res.text();
      if (!text) return;
      // Daemon returned plain JSON (enableJsonResponse=true on transport).
      process.stdout.write(text);
      if (!text.endsWith('\n')) process.stdout.write('\n');
    } catch (err) {
      process.stderr.write(`synapse-shim: forward error: ${(err as Error).message}\n`);
      // Best-effort JSON-RPC error reply if the inbound frame had an id.
      const inbound = body as { id?: string | number; jsonrpc?: string };
      if (inbound && typeof inbound === 'object' && inbound.id !== undefined) {
        const errReply = {
          jsonrpc: '2.0',
          id: inbound.id,
          error: { code: -32603, message: `synapse-shim: ${(err as Error).message}` },
        };
        process.stdout.write(JSON.stringify(errReply) + '\n');
      }
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });
}
