// Spawns daemon + shim child processes, sends a fake MCP initialize +
// tools/list through the shim's stdin, verifies the daemon's response
// flows back over stdout. Cleans up everything on exit.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const cli = join(here, '..', '..', 'dist', 'cli.js');

const dataDir = mkdtempSync(join(tmpdir(), 'synapse-e2e-'));
const port = 18770 + Math.floor(Math.random() * 100);

const baseEnv = {
  ...process.env,
  SYNAPSE_DAEMON_PORT: String(port),
  SYNAPSE_DATA_DIR: dataDir,
  SYNAPSE_LABEL: 'smoke',
};

console.log(`dataDir = ${dataDir}, port = ${port}`);

let daemon = null;
let shim = null;

const cleanup = () => {
  try { shim?.kill('SIGTERM'); } catch {}
  try { daemon?.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }, 200);
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

daemon = spawn(process.execPath, [cli, 'daemon'], { env: baseEnv, stdio: ['ignore', 'ignore', 'pipe'] });
daemon.stderr.setEncoding('utf-8');
daemon.stderr.on('data', d => process.stdout.write(`[daemon] ${d}`));

await new Promise(r => setTimeout(r, 1500));

shim = spawn(process.execPath, [cli, 'shim'], { env: baseEnv, stdio: ['pipe', 'pipe', 'pipe'] });
shim.stdout.setEncoding('utf-8');
shim.stderr.setEncoding('utf-8');

let stdoutBuf = '';
shim.stdout.on('data', d => { stdoutBuf += d; });
shim.stderr.on('data', d => process.stdout.write(`[shim] ${d}`));

const frames = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
];

for (const f of frames) {
  shim.stdin.write(JSON.stringify(f) + '\n');
  await new Promise(r => setTimeout(r, 400));
}

await new Promise(r => setTimeout(r, 1000));

console.log('\n--- shim stdout (full) ---');
console.log(stdoutBuf);

const lines = stdoutBuf.split('\n').filter(l => l.trim());
let initOk = false;
let toolCount = 0;
for (const line of lines) {
  try {
    const msg = JSON.parse(line);
    if (msg.id === 1 && msg.result?.protocolVersion) initOk = true;
    if (msg.id === 2 && Array.isArray(msg.result?.tools)) toolCount = msg.result.tools.length;
  } catch {}
}

console.log(`\nresults: initialize=${initOk}, tools/list=${toolCount} tools`);

cleanup();
process.exit(initOk && toolCount >= 18 ? 0 : 1);
