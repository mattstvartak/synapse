// Tests for classifyActiveFile + supporting helpers in storage.ts.
// Standalone — run with `node tests/classifier.test.mjs` from the
// synapse/ root after `npm run build`.
//
// Coverage:
//   - parse-error      (malformed JSON on disk)
//   - missing-id       (parsed but no id field)
//   - orphan-no-peer   (id present, no peers row)
//   - peer-silent      (peer row past cushion × multiplier)
//   - mcp-pid-dead     (mcpPid recorded, process gone)
//   - duplicate-session (caller passes duplicateOf)
//   - live             (fresh peer, no mcpPid, classifier OK with legacy file)
//   - live (mcpPid OK) (fresh peer + alive mcpPid)
//   - keepIds          (selfId short-circuit)
//
// Plus a smoke test of getPeerGcMultiplier env parsing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyActiveFile,
  deleteActiveFile,
  findActiveFileDuplicates,
  getDb,
  getPeerGcMultiplier,
  isPidAlive,
  isSessionIdKeyedActiveFile,
  listActiveFiles,
  upsertPeer,
} from '../dist/storage.js';

// One temp dataDir for the whole file — storage.ts caches its DB
// connection module-globally, so a single dataDir lets every test
// share that connection cleanly.
const dataDir = mkdtempSync(join(tmpdir(), 'synapse-test-'));
const config = {
  dataDir,
  defaultTtlSeconds: 86_400,
  peerHeartbeatTimeoutSeconds: 600,
};

// Touch the cached DB so the schema gets initialized once.
getDb(config);

// Drop everything that survives between tests; storage.ts caches the
// connection so we share one db across all `test()` blocks.
function reset() {
  const db = getDb(config);
  db.exec(`DELETE FROM peers`);
  db.exec(`DELETE FROM thread_participants`);
  // Wipe any active files left from a previous case.
  for (const info of listActiveFiles(config, 'code')) {
    deleteActiveFile(info);
  }
}

function writeActive({ name, payload }) {
  const path = join(dataDir, name);
  writeFileSync(path, payload, 'utf-8');
}

function isoMinutesAgo(min) {
  return new Date(Date.now() - min * 60_000).toISOString();
}

// node:test runs in-order with a single config (no parallelism issues).

test('parse-error: malformed JSON unlinks', () => {
  reset();
  writeActive({
    name: 'active-code-broken.json',
    payload: '{not json',
  });
  const [info] = listActiveFiles(config, 'code');
  assert.equal(classifyActiveFile(config, info).reason, 'parse-error');
});

test('missing-id: parsed but no id field', () => {
  reset();
  writeActive({
    name: 'active-code-noid.json',
    payload: JSON.stringify({ label: 'code', sessionId: 'x' }),
  });
  const [info] = listActiveFiles(config, 'code');
  assert.equal(classifyActiveFile(config, info).reason, 'missing-id');
});

test('orphan-no-peer: id stamped but peers row missing', () => {
  reset();
  writeActive({
    name: 'active-code-orphan.json',
    payload: JSON.stringify({
      id: 'code-deadbeef',
      label: 'code',
      sessionId: 'sess-orphan',
      registeredAt: isoMinutesAgo(1),
    }),
  });
  const [info] = listActiveFiles(config, 'code');
  assert.equal(classifyActiveFile(config, info).reason, 'orphan-no-peer');
});

test('peer-silent: peer row exists but stale past cushion', () => {
  reset();
  // Heartbeat 600s × multiplier 2 (default) = 20min cushion.
  // 30min ago is well past the cushion.
  upsertPeer(config, {
    id: 'code-silent01',
    label: 'code',
    registeredAt: isoMinutesAgo(60),
    lastSeenAt: isoMinutesAgo(30),
    capabilities: null,
  });
  writeActive({
    name: 'active-code-silent.json',
    payload: JSON.stringify({
      id: 'code-silent01',
      label: 'code',
      sessionId: 'sess-silent',
      registeredAt: isoMinutesAgo(60),
    }),
  });
  const [info] = listActiveFiles(config, 'code');
  const decision = classifyActiveFile(config, info);
  assert.equal(decision.reason, 'peer-silent');
  assert.match(decision.detail ?? '', /silent \d+s/);
});

test('mcp-pid-dead: mcpPid recorded but process gone', () => {
  reset();
  upsertPeer(config, {
    id: 'code-deadpid01',
    label: 'code',
    registeredAt: isoMinutesAgo(1),
    lastSeenAt: isoMinutesAgo(1),
    capabilities: null,
  });
  writeActive({
    name: 'active-code-deadpid.json',
    payload: JSON.stringify({
      id: 'code-deadpid01',
      label: 'code',
      sessionId: 'sess-deadpid',
      mcpPid: 999_999_999, // very unlikely to be a live pid
      registeredAt: isoMinutesAgo(1),
    }),
  });
  const [info] = listActiveFiles(config, 'code');
  const decision = classifyActiveFile(config, info);
  assert.equal(decision.reason, 'mcp-pid-dead');
  assert.match(decision.detail ?? '', /pid 999999999/);
});

test('duplicate-session: caller passes duplicateOf', () => {
  reset();
  upsertPeer(config, {
    id: 'code-dup01',
    label: 'code',
    registeredAt: isoMinutesAgo(1),
    lastSeenAt: isoMinutesAgo(1),
    capabilities: null,
  });
  writeActive({
    name: 'active-code-dup-old.json',
    payload: JSON.stringify({ id: 'code-dup01', label: 'code', sessionId: 'sess-dup' }),
  });
  writeActive({
    name: 'active-code-dup-new.json',
    payload: JSON.stringify({ id: 'code-dup01', label: 'code', sessionId: 'sess-dup' }),
  });
  const files = listActiveFiles(config, 'code');
  // Pick whichever; we're just verifying the duplicate-of branch fires.
  const decision = classifyActiveFile(config, files[0], { duplicateOf: files[1] });
  assert.equal(decision.reason, 'duplicate-session');
  assert.match(decision.detail ?? '', /superseded by/);
});

test('live (legacy, no mcpPid): fresh peer + missing mcpPid is live', () => {
  reset();
  upsertPeer(config, {
    id: 'code-legacy01',
    label: 'code',
    registeredAt: isoMinutesAgo(1),
    lastSeenAt: isoMinutesAgo(1),
    capabilities: null,
  });
  writeActive({
    name: 'active-code-legacy.json',
    payload: JSON.stringify({
      id: 'code-legacy01',
      label: 'code',
      sessionId: 'sess-legacy',
      // no mcpPid field — pre-v1.2 active file
    }),
  });
  const [info] = listActiveFiles(config, 'code');
  assert.equal(classifyActiveFile(config, info).reason, 'live');
});

test('live (mcpPid alive): fresh peer + this process pid is live', () => {
  reset();
  upsertPeer(config, {
    id: 'code-alive01',
    label: 'code',
    registeredAt: isoMinutesAgo(1),
    lastSeenAt: isoMinutesAgo(1),
    capabilities: null,
  });
  writeActive({
    name: 'active-code-alive.json',
    payload: JSON.stringify({
      id: 'code-alive01',
      label: 'code',
      sessionId: 'sess-alive',
      mcpPid: process.pid,
    }),
  });
  const [info] = listActiveFiles(config, 'code');
  assert.equal(classifyActiveFile(config, info).reason, 'live');
});

test('keepIds: short-circuits even if peer would be silent', () => {
  reset();
  // Peer is silent past cushion — would normally be reaped.
  upsertPeer(config, {
    id: 'code-keep01',
    label: 'code',
    registeredAt: isoMinutesAgo(60),
    lastSeenAt: isoMinutesAgo(60),
    capabilities: null,
  });
  writeActive({
    name: 'active-code-keep.json',
    payload: JSON.stringify({
      id: 'code-keep01',
      label: 'code',
      sessionId: 'sess-keep',
    }),
  });
  const [info] = listActiveFiles(config, 'code');
  const decision = classifyActiveFile(config, info, {
    keepIds: new Set(['code-keep01']),
  });
  assert.equal(decision.reason, 'live');
  assert.equal(decision.detail, 'kept by caller');
});

test('listActiveFiles: filters by label prefix', () => {
  reset();
  writeActive({ name: 'active-code-1.json', payload: JSON.stringify({ id: 'code-x' }) });
  writeActive({ name: 'active-desktop-1.json', payload: JSON.stringify({ id: 'desktop-y' }) });
  writeActive({ name: 'unrelated.json', payload: '{}' });
  const codeOnly = listActiveFiles(config, 'code');
  assert.equal(codeOnly.length, 1);
  assert.equal(codeOnly[0].name, 'active-code-1.json');
  const all = listActiveFiles(config);
  // Both active-code and active-desktop have the 'active-' prefix.
  // 'unrelated.json' is excluded.
  assert.equal(all.length, 2);
});

test('isPidAlive: own pid is alive, fake pid is not', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999_999_999), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(null), false);
  assert.equal(isPidAlive(undefined), false);
});

test('getPeerGcMultiplier: env override + default', () => {
  const original = process.env.SYNAPSE_PEER_GC_MULTIPLIER;
  try {
    delete process.env.SYNAPSE_PEER_GC_MULTIPLIER;
    assert.equal(getPeerGcMultiplier(), 2);
    process.env.SYNAPSE_PEER_GC_MULTIPLIER = '5';
    assert.equal(getPeerGcMultiplier(), 5);
    process.env.SYNAPSE_PEER_GC_MULTIPLIER = '0';
    assert.equal(getPeerGcMultiplier(), 2, 'sub-1 multiplier falls back to default');
    process.env.SYNAPSE_PEER_GC_MULTIPLIER = 'not-a-number';
    assert.equal(getPeerGcMultiplier(), 2, 'unparseable value falls back to default');
  } finally {
    if (original === undefined) delete process.env.SYNAPSE_PEER_GC_MULTIPLIER;
    else process.env.SYNAPSE_PEER_GC_MULTIPLIER = original;
  }
});

test('isSessionIdKeyedActiveFile: filename pattern detection', () => {
  reset();
  // Canonical sessionId-keyed file.
  writeActive({
    name: 'active-code-7f3a2b1c-aaaa-bbbb-cccc-ddddeeeeffff.json',
    payload: JSON.stringify({
      id: 'code-x',
      label: 'code',
      sessionId: '7f3a2b1c-aaaa-bbbb-cccc-ddddeeeeffff',
    }),
  });
  // Legacy ppid-keyed file with the same payload sessionId.
  writeActive({
    name: 'active-code-50860.json',
    payload: JSON.stringify({
      id: 'code-x',
      label: 'code',
      sessionId: '7f3a2b1c-aaaa-bbbb-cccc-ddddeeeeffff',
    }),
  });
  const files = listActiveFiles(config, 'code');
  const sessionFile = files.find(f => f.name.includes('7f3a2b1c'));
  const ppidFile   = files.find(f => f.name.endsWith('50860.json'));
  assert.equal(isSessionIdKeyedActiveFile(sessionFile), true);
  assert.equal(isSessionIdKeyedActiveFile(ppidFile), false);
});

test('findActiveFileDuplicates: sessionId-keyed beats ppid-keyed regardless of mtime', async () => {
  reset();
  // Write the sessionId-keyed copy FIRST (older mtime — would lose under
  // a pure mtime tiebreak), then the ppid-keyed copy. This mirrors what
  // the v1.1 SessionStart hook produced on disk.
  writeActive({
    name: 'active-code-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json',
    payload: JSON.stringify({
      id: 'code-dup01',
      label: 'code',
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    }),
  });
  // Force a measurable mtime gap so the older-mtime tiebreak would
  // otherwise pick the ppid-keyed file.
  await new Promise(r => setTimeout(r, 20));
  writeActive({
    name: 'active-code-50860.json',
    payload: JSON.stringify({
      id: 'code-dup01',
      label: 'code',
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    }),
  });

  const files = listActiveFiles(config, 'code');
  const dupOf = findActiveFileDuplicates(files);

  const ppidFile = files.find(f => f.name.endsWith('50860.json'));
  const sessionFile = files.find(f => f.name.includes('aaaaaaaa-'));

  // The ppid-keyed file is the duplicate; the sessionId-keyed file is
  // the canonical winner.
  assert.equal(dupOf.has(ppidFile.path), true, 'ppid-keyed file should be flagged as duplicate');
  assert.equal(dupOf.get(ppidFile.path).path, sessionFile.path);
  assert.equal(dupOf.has(sessionFile.path), false, 'sessionId-keyed file should NOT be flagged as duplicate');
});

test('findActiveFileDuplicates: same naming scheme falls back to mtime', async () => {
  reset();
  // Two ppid-keyed files for the same sessionId — newer mtime wins.
  writeActive({
    name: 'active-code-11111.json',
    payload: JSON.stringify({
      id: 'code-tie01',
      label: 'code',
      sessionId: 'tie-session-id',
    }),
  });
  await new Promise(r => setTimeout(r, 20));
  writeActive({
    name: 'active-code-22222.json',
    payload: JSON.stringify({
      id: 'code-tie01',
      label: 'code',
      sessionId: 'tie-session-id',
    }),
  });
  const files = listActiveFiles(config, 'code');
  const dupOf = findActiveFileDuplicates(files);
  const older = files.find(f => f.name.endsWith('11111.json'));
  const newer = files.find(f => f.name.endsWith('22222.json'));
  assert.equal(dupOf.get(older.path)?.path, newer.path,
    'older ppid-keyed file should be superseded by the newer one');
  assert.equal(dupOf.has(newer.path), false);
});

test.after(() => {
  // node:sqlite holds the file open via the cached storage.ts handle.
  // Best-effort cleanup; on Windows the unlink may race so swallow.
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
});
