// §1.6(c) cold-restart aliasing — daemon /identity endpoint behavior.
//
// Spawns the daemon, hits /identity with priorPeerId set, asserts the
// aliasing logic fires when (a) prior exists in peers table and
// (b) heartbeat is older than COLD_RESTART_STALE_SEC. Direct HTTP
// against the daemon (no shim) keeps the assertions tight.
//
// Run after `npm run build`: `node --test tests/daemon-cold-alias.test.mjs`

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'dist', 'cli.js');

function nowIso() { return new Date().toISOString(); }

async function spawnDaemon(dataDir, port, staleSec = '1') {
  const child = spawn(process.execPath, [CLI, 'daemon'], {
    env: {
      ...process.env,
      SYNAPSE_DAEMON_PORT: String(port),
      SYNAPSE_DATA_DIR: dataDir,
      SYNAPSE_COLD_RESTART_STALE_SEC: String(staleSec),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let token = null;
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', () => {}); // swallow
  // Daemon writes daemon.json with the auth token; read it after a short wait.
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100));
    try {
      const { readFileSync } = await import('node:fs');
      const state = JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf-8'));
      if (state?.token) { token = state.token; break; }
    } catch { /* not ready */ }
  }
  if (!token) {
    child.kill('SIGTERM');
    throw new Error('daemon did not write daemon.json in time');
  }
  return { child, token };
}

async function postIdentity(port, token, body) {
  const res = await fetch(`http://127.0.0.1:${port}/identity`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function withDaemon(staleSec, fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'synapse-cold-alias-'));
  const port = 19000 + Math.floor(Math.random() * 500);
  const daemon = await spawnDaemon(dataDir, port, staleSec);
  try {
    return await fn({ dataDir, port, token: daemon.token });
  } finally {
    try { daemon.child.kill('SIGTERM'); } catch { /* nothing */ }
    await new Promise(r => setTimeout(r, 150));
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* nothing */ }
  }
}

test('§1.6(c): no priorPeerId → no alias registered', async () => {
  await withDaemon('600', async ({ port, token }) => {
    const r = await postIdentity(port, token, {
      label: 'code',
      sessionFingerprint: randomUUID(),
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.peerId, 'peerId returned');
    assert.equal(r.body.coldAliasRegistered, undefined);
  });
});

test('§1.6(c): priorPeerId not in peers table → silently skip alias', async () => {
  await withDaemon('600', async ({ port, token }) => {
    const r = await postIdentity(port, token, {
      label: 'code',
      sessionFingerprint: randomUUID(),
      priorPeerId: 'code-doesnotexist-zzzzz',
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.peerId);
    assert.equal(r.body.coldAliasRegistered, undefined);
  });
});

test('§1.6(c): stale priorPeerId + new identityToken → alias registered', async () => {
  // staleSec=0 → any prior heartbeat is "stale" for the purpose of
  // this test; tighter than production default of 600s but exercises
  // the cold-rotation path immediately.
  await withDaemon('0', async ({ port, token, dataDir }) => {
    // First boot: mint id1 with token A.
    const tokenA = randomUUID();
    const r1 = await postIdentity(port, token, {
      label: 'code',
      identityToken: tokenA,
      sessionFingerprint: randomUUID(),
    });
    assert.equal(r1.status, 200);
    const id1 = r1.body.peerId;
    assert.ok(id1);

    // Cold restart simulation: brand-new identityToken (token B), pass
    // id1 as priorPeerId. Daemon mints id2 (different from id1), then
    // checks staleness → with staleSec=0, id1 is stale → alias.
    const tokenB = randomUUID();
    const r2 = await postIdentity(port, token, {
      label: 'code',
      identityToken: tokenB,
      sessionFingerprint: randomUUID(),
      priorPeerId: id1,
    });
    assert.equal(r2.status, 200);
    const id2 = r2.body.peerId;
    assert.ok(id2);
    assert.notEqual(id1, id2, 'fresh token should mint a fresh peerId');
    assert.deepEqual(r2.body.coldAliasRegistered, { from: id1, to: id2 });

    // Verify the alias landed in storage by importing the storage module
    // directly (it points at the same dataDir).
    const { resolvePeerAlias } = await import('../dist/storage.js');
    const config = {
      dataDir,
      defaultTtlSeconds: 86_400,
      peerHeartbeatTimeoutSeconds: 600,
    };
    assert.equal(resolvePeerAlias(config, id1), id2,
      'sending to dead id1 now canonicalizes to id2');
  });
});

test('§1.6(c): fresh priorPeerId (heartbeat within window) → no alias', async () => {
  // staleSec=600 → a peer that just heartbeat'd is NOT stale, so the
  // §1.11 contention path applies, not cold rotation. We reuse id1 as
  // priorPeerId on a back-to-back call — the touchPeer in resolveIdentity
  // refreshed last_seen_at within the 600s window.
  await withDaemon('600', async ({ port, token }) => {
    const tokenA = randomUUID();
    const r1 = await postIdentity(port, token, {
      label: 'code',
      identityToken: tokenA,
      sessionFingerprint: randomUUID(),
    });
    const id1 = r1.body.peerId;

    const tokenB = randomUUID();
    const r2 = await postIdentity(port, token, {
      label: 'code',
      identityToken: tokenB,
      sessionFingerprint: randomUUID(),
      priorPeerId: id1,
    });
    assert.equal(r2.status, 200);
    assert.notEqual(r2.body.peerId, id1, 'still mints fresh — different token');
    assert.equal(r2.body.coldAliasRegistered, undefined,
      'fresh prior heartbeat → no cold-rotation alias');
  });
});

test('§1.6(c): priorPeerId === resolvedPeerId → no alias (no-op identity)', async () => {
  await withDaemon('0', async ({ port, token }) => {
    const tokenA = randomUUID();
    const fp = randomUUID();
    const r1 = await postIdentity(port, token, {
      label: 'code',
      identityToken: tokenA,
      sessionFingerprint: fp,
    });
    const id1 = r1.body.peerId;

    // Same identityToken + same fingerprint → daemon returns the same
    // peerId. priorPeerId === resolvedPeerId → no alias.
    const r2 = await postIdentity(port, token, {
      label: 'code',
      identityToken: tokenA,
      sessionFingerprint: fp,
      priorPeerId: id1,
    });
    assert.equal(r2.body.peerId, id1, 'sticky-token boot returns same peerId');
    assert.equal(r2.body.coldAliasRegistered, undefined);
  });
});
