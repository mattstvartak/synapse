// Tests for peerLivenessSummary + suggestLivePeerForLabel in storage.ts.
// Standalone — run with `node tests/peer-liveness.test.mjs` from the
// synapse/ root after `npm run build`.
//
// Coverage (v7 auto-comms B + #2 — phantom-peer suppression):
//   - live              (shim active-file + alive mcpPid)
//   - phantom           (hook-fallback active-file only)
//   - stale             (shim active-file but mcpPid dead)
//   - stale (no pid)    (shim active-file with no mcpPid recorded)
//   - orphan            (peer row exists, no active-file at all)
//   - rotation          (multiple files, any single live one wins)
//   - suggest hit       (suggestLivePeerForLabel returns a live candidate)
//   - suggest exclude   (excludeIds filters out specific ids)
//   - suggest miss      (returns null when no live alternative)
//
// synapse_peers handler filter + synapse_send PEER_PHANTOM/PEER_STALE/
// PEER_ORPHAN guard are exercised at the smoke-test layer (scripts/smoke.mjs)
// rather than here — those need a live MCP server boot.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deleteActiveFile,
  getDb,
  listActiveFiles,
  peerLivenessSummary,
  suggestLivePeerForLabel,
  upsertPeer,
} from '../dist/storage.js';

// One temp dataDir for the whole file — storage.ts caches its DB
// connection module-globally, so a single dataDir lets every test
// share that connection cleanly.
const dataDir = mkdtempSync(join(tmpdir(), 'synapse-liveness-test-'));
const config = {
  dataDir,
  defaultTtlSeconds: 86_400,
  peerHeartbeatTimeoutSeconds: 600,
};

getDb(config);

function reset() {
  const db = getDb(config);
  db.exec(`DELETE FROM peers`);
  db.exec(`DELETE FROM thread_participants`);
  for (const info of listActiveFiles(config, 'code')) {
    deleteActiveFile(info);
  }
}

function writeActive({ name, payload }) {
  writeFileSync(join(dataDir, name), payload, 'utf-8');
}

function isoMinutesAgo(min) {
  return new Date(Date.now() - min * 60_000).toISOString();
}

test('live: shim active-file with alive mcpPid', () => {
  reset();
  upsertPeer(config, {
    id: 'code-live01',
    label: 'code',
    registeredAt: isoMinutesAgo(1),
    lastSeenAt: isoMinutesAgo(1),
    capabilities: null,
  });
  writeActive({
    name: 'active-code-live01.json',
    payload: JSON.stringify({
      id: 'code-live01',
      label: 'code',
      sessionId: 'sess-live',
      source: 'shim',
      mcpPid: process.pid, // current node process is alive
      registeredAt: isoMinutesAgo(1),
    }),
  });
  const summary = peerLivenessSummary(config, 'code-live01');
  assert.equal(summary.live, true);
  assert.equal(summary.reason, 'live');
});

test('phantom: only active-file is session-start-hook-fallback', () => {
  reset();
  upsertPeer(config, {
    id: 'code-phantom01',
    label: 'code',
    registeredAt: isoMinutesAgo(1),
    lastSeenAt: isoMinutesAgo(1),
    capabilities: null,
  });
  writeActive({
    name: 'active-code-phantom01.json',
    payload: JSON.stringify({
      id: 'code-phantom01',
      label: 'code',
      sessionId: 'sess-phantom',
      source: 'session-start-hook-fallback',
      // no mcpPid — hook fallback never has one
      registeredAt: isoMinutesAgo(1),
    }),
  });
  const summary = peerLivenessSummary(config, 'code-phantom01');
  assert.equal(summary.live, false);
  assert.equal(summary.reason, 'phantom');
  assert.match(summary.detail ?? '', /hook-fallback/);
});

test('stale: shim file but mcpPid dead', () => {
  reset();
  upsertPeer(config, {
    id: 'code-stale01',
    label: 'code',
    registeredAt: isoMinutesAgo(1),
    lastSeenAt: isoMinutesAgo(1),
    capabilities: null,
  });
  writeActive({
    name: 'active-code-stale01.json',
    payload: JSON.stringify({
      id: 'code-stale01',
      label: 'code',
      sessionId: 'sess-stale',
      source: 'shim',
      mcpPid: 999_999_999, // very unlikely to be alive
      registeredAt: isoMinutesAgo(1),
    }),
  });
  const summary = peerLivenessSummary(config, 'code-stale01');
  assert.equal(summary.live, false);
  assert.equal(summary.reason, 'stale');
  assert.match(summary.detail ?? '', /mcpPid 999999999 dead/);
});

test('stale (no pid): shim file with no mcpPid recorded', () => {
  reset();
  upsertPeer(config, {
    id: 'code-nopid01',
    label: 'code',
    registeredAt: isoMinutesAgo(1),
    lastSeenAt: isoMinutesAgo(1),
    capabilities: null,
  });
  writeActive({
    name: 'active-code-nopid01.json',
    payload: JSON.stringify({
      id: 'code-nopid01',
      label: 'code',
      sessionId: 'sess-nopid',
      source: 'shim',
      // mcpPid omitted
      registeredAt: isoMinutesAgo(1),
    }),
  });
  const summary = peerLivenessSummary(config, 'code-nopid01');
  assert.equal(summary.live, false);
  assert.equal(summary.reason, 'stale');
  assert.match(summary.detail ?? '', /no mcpPid/);
});

test('orphan: peer row exists, no active-file on disk', () => {
  reset();
  upsertPeer(config, {
    id: 'code-orphan01',
    label: 'code',
    registeredAt: isoMinutesAgo(1),
    lastSeenAt: isoMinutesAgo(1),
    capabilities: null,
  });
  // No active-file written.
  const summary = peerLivenessSummary(config, 'code-orphan01');
  assert.equal(summary.live, false);
  assert.equal(summary.reason, 'orphan');
});

test('rotation: multiple files, any single live one wins', () => {
  reset();
  upsertPeer(config, {
    id: 'code-rotate01',
    label: 'code',
    registeredAt: isoMinutesAgo(5),
    lastSeenAt: isoMinutesAgo(1),
    capabilities: null,
  });
  // Stale file (older).
  writeActive({
    name: 'active-code-rotate01-old.json',
    payload: JSON.stringify({
      id: 'code-rotate01',
      label: 'code',
      sessionId: 'sess-old',
      source: 'shim',
      mcpPid: 999_999_999,
      registeredAt: isoMinutesAgo(5),
    }),
  });
  // Live file (current).
  writeActive({
    name: 'active-code-rotate01-new.json',
    payload: JSON.stringify({
      id: 'code-rotate01',
      label: 'code',
      sessionId: 'sess-new',
      source: 'shim',
      mcpPid: process.pid,
      registeredAt: isoMinutesAgo(1),
    }),
  });
  const summary = peerLivenessSummary(config, 'code-rotate01');
  assert.equal(summary.live, true);
  assert.equal(summary.reason, 'live');
});

test('suggest hit: returns a live candidate sharing the label', () => {
  reset();
  // Phantom target.
  upsertPeer(config, {
    id: 'code-target',
    label: 'code',
    registeredAt: isoMinutesAgo(1),
    lastSeenAt: isoMinutesAgo(1),
    capabilities: null,
  });
  writeActive({
    name: 'active-code-target.json',
    payload: JSON.stringify({
      id: 'code-target',
      label: 'code',
      sessionId: 'sess-target',
      source: 'session-start-hook-fallback',
    }),
  });
  // Live alternative.
  upsertPeer(config, {
    id: 'code-alt',
    label: 'code',
    registeredAt: isoMinutesAgo(1),
    lastSeenAt: isoMinutesAgo(1),
    capabilities: null,
  });
  writeActive({
    name: 'active-code-alt.json',
    payload: JSON.stringify({
      id: 'code-alt',
      label: 'code',
      sessionId: 'sess-alt',
      source: 'shim',
      mcpPid: process.pid,
    }),
  });
  const candidate = suggestLivePeerForLabel(config, 'code', ['code-target']);
  assert.equal(candidate, 'code-alt');
});

test('suggest exclude: filters out ids in excludeIds', () => {
  reset();
  // Caller (would be self-suggested if not excluded).
  upsertPeer(config, {
    id: 'code-caller',
    label: 'code',
    registeredAt: isoMinutesAgo(1),
    lastSeenAt: isoMinutesAgo(1),
    capabilities: null,
  });
  writeActive({
    name: 'active-code-caller.json',
    payload: JSON.stringify({
      id: 'code-caller',
      label: 'code',
      sessionId: 'sess-caller',
      source: 'shim',
      mcpPid: process.pid,
    }),
  });
  // Phantom target.
  upsertPeer(config, {
    id: 'code-phantom-tgt',
    label: 'code',
    registeredAt: isoMinutesAgo(1),
    lastSeenAt: isoMinutesAgo(1),
    capabilities: null,
  });
  writeActive({
    name: 'active-code-phantom-tgt.json',
    payload: JSON.stringify({
      id: 'code-phantom-tgt',
      label: 'code',
      sessionId: 'sess-phantom-tgt',
      source: 'session-start-hook-fallback',
    }),
  });
  // Suggest excluding both target AND caller — should return null because
  // the only live peer is the caller and we asked to exclude them.
  const candidate = suggestLivePeerForLabel(
    config, 'code',
    ['code-phantom-tgt', 'code-caller'],
  );
  assert.equal(candidate, null);
});

test('suggest miss: returns null when no live alternative exists', () => {
  reset();
  upsertPeer(config, {
    id: 'code-only-phantom',
    label: 'code',
    registeredAt: isoMinutesAgo(1),
    lastSeenAt: isoMinutesAgo(1),
    capabilities: null,
  });
  writeActive({
    name: 'active-code-only-phantom.json',
    payload: JSON.stringify({
      id: 'code-only-phantom',
      label: 'code',
      sessionId: 'sess-only-phantom',
      source: 'session-start-hook-fallback',
    }),
  });
  const candidate = suggestLivePeerForLabel(config, 'code', ['code-other']);
  assert.equal(candidate, null);
});
