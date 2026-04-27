// Verifies sticky identity across shim restart. Spawns daemon, runs
// shim 1, captures peerId. Kills shim 1. Runs shim 2 with same dataDir
// + same label. Asserts shim 2 gets the SAME peerId.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const cli = join(here, '..', '..', 'dist', 'cli.js');

const dataDir = mkdtempSync(join(tmpdir(), 'synapse-sticky-'));
const port = 18900 + Math.floor(Math.random() * 100);

const env = {
  ...process.env,
  SYNAPSE_DAEMON_PORT: String(port),
  SYNAPSE_DATA_DIR: dataDir,
  SYNAPSE_LABEL: 'sticky',
};

console.log(`dataDir = ${dataDir}, port = ${port}`);

let daemon = null;
const cleanup = () => {
  try { daemon?.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }, 200);
};
process.on('exit', cleanup);

daemon = spawn(process.execPath, [cli, 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
daemon.stderr.setEncoding('utf-8');
daemon.stderr.on('data', d => process.stdout.write(`[daemon] ${d}`));

await new Promise(r => setTimeout(r, 1500));

async function runShimSession(shimNum) {
  const shim = spawn(process.execPath, [cli, 'shim'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  shim.stdout.setEncoding('utf-8');
  shim.stderr.setEncoding('utf-8');
  let stdoutBuf = '';
  shim.stdout.on('data', d => { stdoutBuf += d; });
  shim.stderr.on('data', d => process.stdout.write(`[shim${shimNum}] ${d}`));

  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sticky-test', version: '1.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'synapse_whoami', arguments: {} } },
  ];
  for (const f of frames) {
    shim.stdin.write(JSON.stringify(f) + '\n');
    await new Promise(r => setTimeout(r, 400));
  }
  await new Promise(r => setTimeout(r, 700));
  shim.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 200));

  // Find the synapse_whoami response: id=2, result.content[0].text is JSON with id
  const lines = stdoutBuf.split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.id === 2 && msg.result?.content?.[0]?.text) {
        const inner = JSON.parse(msg.result.content[0].text);
        return inner.id;
      }
    } catch {}
  }
  return null;
}

console.log('--- shim 1 ---');
const peer1 = await runShimSession(1);
console.log(`peer1 = ${peer1}`);

// Confirm identity file written
const idPath = join(dataDir, 'sticky-identity.json');
const id = JSON.parse(readFileSync(idPath, 'utf-8'));
console.log(`identity file: token=${id.identityToken.slice(0,8)}... peerId=${id.peerId}`);

console.log('--- shim 2 (same dataDir, same label) ---');
const peer2 = await runShimSession(2);
console.log(`peer2 = ${peer2}`);

const ok = peer1 && peer2 && peer1 === peer2;
console.log(`\nMATCH: ${ok ? '✓ STICKY' : '✗ DIVERGED'} (peer1=${peer1}, peer2=${peer2})`);

cleanup();
process.exit(ok ? 0 : 1);
