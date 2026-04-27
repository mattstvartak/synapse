// Tests for §4.10 recruitment + busy-state storage helpers.
// Standalone — run with `node tests/recruitment.test.mjs` from the
// synapse/ root after `npm run build`.
//
// Coverage:
//   - busy-state: set, clear, get, clear-all, prune-stale
//   - recruit insert + dedup + rate-limit
//   - prospect selection: any-of caps, requireAll caps, excludeCaps,
//     excludeIds, busy peer exclusion, stale heartbeat exclusion
//   - recruit expiry: TTL elapsed → expired_at set, returned;
//     already-expired not re-returned

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

import {
  getDb,
  upsertPeer,
  setPeerBusy, clearPeerBusy, getPeerBusyState,
  pruneStaleBusyState, clearAllPeerBusyState,
  appendPeerIdleEvent, getLatestPeerIdleEvents, pruneStaleIdleLog,
  insertRecruit, findRecentRecruit, countRecentRecruits,
  expireRecruits, fulfillRecruit, fulfillMatchingRecruit, selectRecruitProspects,
} from '../dist/storage.js';

const dataDir = mkdtempSync(join(tmpdir(), 'synapse-recruit-test-'));
const config = {
  dataDir,
  defaultTtlSeconds: 86_400,
  peerHeartbeatTimeoutSeconds: 600,
};

getDb(config);

function reset() {
  const db = getDb(config);
  db.exec(`DELETE FROM peer_busy_state`);
  db.exec(`DELETE FROM peer_idle_log`);
  db.exec(`DELETE FROM recruits`);
  db.exec(`DELETE FROM peers`);
  db.exec(`DELETE FROM messages`);
  db.exec(`DELETE FROM thread_participants`);
}

function addPeer(id, label, capabilities = null, lastSeenAt = null) {
  const now = lastSeenAt ?? new Date().toISOString();
  upsertPeer(config, {
    id,
    label,
    registeredAt: now,
    lastSeenAt: now,
    capabilities: capabilities ? JSON.stringify(capabilities) : null,
  });
}

function makeRecruit(overrides = {}) {
  const id = overrides.id ?? randomUUID();
  const description = overrides.description ?? 'help wanted';
  return {
    id,
    originatorId: overrides.originatorId ?? 'code-orig',
    threadId: overrides.threadId ?? randomUUID(),
    description,
    capabilities: overrides.capabilities ?? null,
    requireAll: overrides.requireAll ?? false,
    excludeCaps: overrides.excludeCaps ?? null,
    urgency: overrides.urgency ?? 'normal',
    originatorBusy: overrides.originatorBusy ?? true,
    workspace: overrides.workspace ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 300_000).toISOString(),
    fulfilledAt: overrides.fulfilledAt ?? null,
    expiredAt: overrides.expiredAt ?? null,
    descriptionHash: overrides.descriptionHash ?? createHash('sha256').update(description).digest('hex').slice(0, 16),
  };
}

// ── Busy-state ────────────────────────────────────────────────────

test('busy: set + get', () => {
  reset();
  addPeer('code-1', 'code');
  setPeerBusy(config, 'code-1', 'USER_DRIVEN');
  const row = getPeerBusyState(config, 'code-1');
  assert.equal(row.peerId, 'code-1');
  assert.equal(row.busyReason, 'USER_DRIVEN');
  assert.ok(row.busyAt);
});

test('busy: clear deletes row', () => {
  reset();
  addPeer('code-1', 'code');
  setPeerBusy(config, 'code-1', 'EXPLICIT_BUSY');
  clearPeerBusy(config, 'code-1');
  assert.equal(getPeerBusyState(config, 'code-1'), null);
});

test('busy: re-set updates reason', () => {
  reset();
  addPeer('code-1', 'code');
  setPeerBusy(config, 'code-1', 'USER_DRIVEN');
  setPeerBusy(config, 'code-1', 'DRAFTING');
  assert.equal(getPeerBusyState(config, 'code-1').busyReason, 'DRAFTING');
});

test('busy: clearAllPeerBusyState wipes table', () => {
  reset();
  addPeer('code-1', 'code');
  addPeer('code-2', 'code');
  setPeerBusy(config, 'code-1', 'USER_DRIVEN');
  setPeerBusy(config, 'code-2', 'EXPLICIT_BUSY');
  const cleared = clearAllPeerBusyState(config);
  assert.equal(cleared, 2);
  assert.equal(getPeerBusyState(config, 'code-1'), null);
  assert.equal(getPeerBusyState(config, 'code-2'), null);
});

test('busy: pruneStaleBusyState only clears stale rows', () => {
  reset();
  addPeer('code-fresh', 'code');
  addPeer('code-stale', 'code');
  setPeerBusy(config, 'code-fresh', 'USER_DRIVEN');
  // Manually backdate the stale row by writing directly.
  const db = getDb(config);
  const oldTime = new Date(Date.now() - 3600_000).toISOString(); // 1h ago
  db.prepare(`INSERT INTO peer_busy_state (peer_id, busy_at, busy_reason, shim_fingerprint) VALUES (?, ?, ?, ?)`)
    .run('code-stale', oldTime, 'USER_DRIVEN', null);
  const cleared = pruneStaleBusyState(config, 1800); // 30min cutoff
  assert.equal(cleared, 1);
  assert.equal(getPeerBusyState(config, 'code-fresh').peerId, 'code-fresh');
  assert.equal(getPeerBusyState(config, 'code-stale'), null);
});

// ── Recruit insert + dedup + rate-limit ────────────────────────────

test('recruit: insert + retrieve via dedup lookup', () => {
  reset();
  addPeer('code-orig', 'code');
  const r = makeRecruit();
  insertRecruit(config, r);
  const found = findRecentRecruit(config, r.originatorId, r.descriptionHash, 60);
  assert.equal(found, r.id);
});

test('recruit: dedup excludes recruits older than window', () => {
  reset();
  addPeer('code-orig', 'code');
  const oldRecruit = makeRecruit({
    createdAt: new Date(Date.now() - 120_000).toISOString(), // 2min ago
  });
  insertRecruit(config, oldRecruit);
  // Window 60s should NOT find the 2min-old recruit.
  const found = findRecentRecruit(config, oldRecruit.originatorId, oldRecruit.descriptionHash, 60);
  assert.equal(found, null);
});

test('recruit: countRecentRecruits respects window', () => {
  reset();
  addPeer('code-orig', 'code');
  for (let i = 0; i < 3; i++) insertRecruit(config, makeRecruit({ description: `r${i}` }));
  // Backdate one of the three.
  const oldRecruit = makeRecruit({
    description: 'old-r',
    createdAt: new Date(Date.now() - 120_000).toISOString(),
  });
  insertRecruit(config, oldRecruit);
  // Window 60s should count only the 3 fresh ones.
  assert.equal(countRecentRecruits(config, 'code-orig', 60), 3);
  // Window 300s should count all 4.
  assert.equal(countRecentRecruits(config, 'code-orig', 300), 4);
});

// ── Prospect selection ─────────────────────────────────────────────

test('prospect: any-of cap match', () => {
  reset();
  addPeer('code-1', 'code', ['typescript', 'node']);
  addPeer('code-2', 'code', ['rust']);
  addPeer('code-3', 'code', ['typescript']);
  const prospects = selectRecruitProspects(config, {
    capabilities: ['typescript'],
    excludeIds: [],
  });
  const ids = prospects.map(p => p.id).sort();
  assert.deepEqual(ids, ['code-1', 'code-3']);
});

test('prospect: requireAll cap match', () => {
  reset();
  addPeer('code-1', 'code', ['typescript', 'node']);
  addPeer('code-2', 'code', ['typescript']);
  const prospects = selectRecruitProspects(config, {
    capabilities: ['typescript', 'node'],
    requireAll: true,
    excludeIds: [],
  });
  const ids = prospects.map(p => p.id);
  assert.deepEqual(ids, ['code-1']);
});

test('prospect: excludeCaps filter', () => {
  reset();
  addPeer('code-1', 'code', ['typescript', 'experimental']);
  addPeer('code-2', 'code', ['typescript']);
  const prospects = selectRecruitProspects(config, {
    capabilities: ['typescript'],
    excludeCaps: ['experimental'],
    excludeIds: [],
  });
  const ids = prospects.map(p => p.id);
  assert.deepEqual(ids, ['code-2']);
});

test('prospect: excludeIds filter', () => {
  reset();
  addPeer('code-orig', 'code', ['typescript']);
  addPeer('code-1', 'code', ['typescript']);
  const prospects = selectRecruitProspects(config, {
    capabilities: ['typescript'],
    excludeIds: ['code-orig'],
  });
  const ids = prospects.map(p => p.id);
  assert.deepEqual(ids, ['code-1']);
});

test('prospect: busy peers excluded', () => {
  reset();
  addPeer('code-1', 'code', ['typescript']);
  addPeer('code-2', 'code', ['typescript']);
  setPeerBusy(config, 'code-1', 'USER_DRIVEN');
  const prospects = selectRecruitProspects(config, {
    capabilities: ['typescript'],
    excludeIds: [],
  });
  const ids = prospects.map(p => p.id);
  assert.deepEqual(ids, ['code-2']);
});

test('prospect: stale heartbeat excluded', () => {
  reset();
  const stale = new Date(Date.now() - 3600_000).toISOString();
  addPeer('code-fresh', 'code', ['typescript']);
  addPeer('code-stale', 'code', ['typescript'], stale);
  const prospects = selectRecruitProspects(config, {
    capabilities: ['typescript'],
    excludeIds: [],
    freshnessSec: 600,
  });
  const ids = prospects.map(p => p.id);
  assert.deepEqual(ids, ['code-fresh']);
});

test('prospect: empty caps returns all idle peers', () => {
  reset();
  addPeer('code-1', 'code', ['typescript']);
  addPeer('code-2', 'code', ['rust']);
  addPeer('code-3', 'code', null);
  const prospects = selectRecruitProspects(config, { excludeIds: [] });
  assert.equal(prospects.length, 3);
});

// ── Recruit expiry ─────────────────────────────────────────────────

test('expireRecruits: TTL elapsed → returned + expired_at set', () => {
  reset();
  addPeer('code-orig', 'code');
  const r = makeRecruit({
    expiresAt: new Date(Date.now() - 1000).toISOString(), // already past
  });
  insertRecruit(config, r);
  const expired = expireRecruits(config);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].id, r.id);
  // Subsequent call returns nothing (expired_at is now set).
  const expiredAgain = expireRecruits(config);
  assert.equal(expiredAgain.length, 0);
});

test('expireRecruits: future TTL not returned', () => {
  reset();
  addPeer('code-orig', 'code');
  insertRecruit(config, makeRecruit({
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }));
  const expired = expireRecruits(config);
  assert.equal(expired.length, 0);
});

test('fulfillRecruit: sets fulfilled_at; idempotent on double-call', () => {
  reset();
  addPeer('code-orig', 'code');
  const r = makeRecruit();
  insertRecruit(config, r);
  fulfillRecruit(config, r.id);
  fulfillRecruit(config, r.id); // no-op second call
  // Verify by reading row directly.
  const row = getDb(config).prepare(`SELECT fulfilled_at FROM recruits WHERE id = ?`).get(r.id);
  assert.ok(row.fulfilled_at, 'fulfilled_at should be set');
});

// v7.1 #2 — fulfillMatchingRecruit closes the freshest open recruit
// on a thread when a peer's caps satisfy the criteria.
test('v7.1 #2 fulfillMatchingRecruit: any-of caps match', () => {
  reset();
  addPeer('code-orig', 'code');
  addPeer('code-joiner', 'code', ['typescript']);
  const tid = randomUUID();
  const r = makeRecruit({ threadId: tid, capabilities: ['typescript', 'rust'] });
  insertRecruit(config, r);
  const matched = fulfillMatchingRecruit(config, tid, 'code-joiner');
  assert.equal(matched, r.id);
  const row = getDb(config).prepare(`SELECT fulfilled_at FROM recruits WHERE id = ?`).get(r.id);
  assert.ok(row.fulfilled_at, 'fulfilled_at set after match');
});

test('v7.1 #2 fulfillMatchingRecruit: empty recruit caps matches any peer', () => {
  reset();
  addPeer('code-orig', 'code');
  addPeer('code-joiner', 'code'); // no caps
  const tid = randomUUID();
  const r = makeRecruit({ threadId: tid, capabilities: null });
  insertRecruit(config, r);
  const matched = fulfillMatchingRecruit(config, tid, 'code-joiner');
  assert.equal(matched, r.id);
});

test('v7.1 #2 fulfillMatchingRecruit: requireAll caps mismatch returns null', () => {
  reset();
  addPeer('code-orig', 'code');
  addPeer('code-joiner', 'code', ['typescript']);
  const tid = randomUUID();
  const r = makeRecruit({ threadId: tid, capabilities: ['typescript', 'rust'], requireAll: true });
  insertRecruit(config, r);
  const matched = fulfillMatchingRecruit(config, tid, 'code-joiner');
  assert.equal(matched, null);
  const row = getDb(config).prepare(`SELECT fulfilled_at FROM recruits WHERE id = ?`).get(r.id);
  assert.equal(row.fulfilled_at, null, 'recruit stays open on mismatch');
});

test('v7.1 #2 fulfillMatchingRecruit: excludeCaps disqualifies', () => {
  reset();
  addPeer('code-orig', 'code');
  addPeer('code-joiner', 'code', ['typescript', 'experimental']);
  const tid = randomUUID();
  const r = makeRecruit({
    threadId: tid,
    capabilities: ['typescript'],
    excludeCaps: ['experimental'],
  });
  insertRecruit(config, r);
  const matched = fulfillMatchingRecruit(config, tid, 'code-joiner');
  assert.equal(matched, null, 'excludeCaps overrides positive cap match');
});

test('v7.1 #2 fulfillMatchingRecruit: only freshest matching recruit fulfilled', () => {
  reset();
  addPeer('code-orig', 'code');
  addPeer('code-joiner', 'code', ['typescript']);
  const tid = randomUUID();
  const oldR = makeRecruit({
    threadId: tid,
    capabilities: ['typescript'],
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const newR = makeRecruit({
    threadId: tid,
    capabilities: ['typescript'],
    createdAt: new Date().toISOString(),
  });
  insertRecruit(config, oldR);
  insertRecruit(config, newR);
  const matched = fulfillMatchingRecruit(config, tid, 'code-joiner');
  assert.equal(matched, newR.id, 'most recent matching recruit closed');
  const oldRow = getDb(config).prepare(`SELECT fulfilled_at FROM recruits WHERE id = ?`).get(oldR.id);
  assert.equal(oldRow.fulfilled_at, null, 'older recruit stays open — its originator may have given up + re-recruited');
});

test('v7.1 #2 fulfillMatchingRecruit: skips already-fulfilled recruits', () => {
  reset();
  addPeer('code-orig', 'code');
  addPeer('code-joiner', 'code', ['typescript']);
  const tid = randomUUID();
  const fulfilled = makeRecruit({
    threadId: tid,
    capabilities: ['typescript'],
    fulfilledAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });
  const open = makeRecruit({
    threadId: tid,
    capabilities: ['typescript'],
    createdAt: new Date(Date.now() - 30_000).toISOString(),
  });
  insertRecruit(config, fulfilled);
  insertRecruit(config, open);
  const matched = fulfillMatchingRecruit(config, tid, 'code-joiner');
  // Should pick the older-but-open one since the freshest is already fulfilled.
  assert.equal(matched, open.id);
});

test('v7.1 #2 fulfillMatchingRecruit: skips expired recruits', () => {
  reset();
  addPeer('code-orig', 'code');
  addPeer('code-joiner', 'code', ['typescript']);
  const tid = randomUUID();
  const expired = makeRecruit({
    threadId: tid,
    capabilities: ['typescript'],
    expiredAt: new Date().toISOString(),
  });
  insertRecruit(config, expired);
  const matched = fulfillMatchingRecruit(config, tid, 'code-joiner');
  assert.equal(matched, null);
});

test('v7.1 #2 fulfillMatchingRecruit: returns null when no recruits on thread', () => {
  reset();
  addPeer('code-joiner', 'code', ['typescript']);
  const matched = fulfillMatchingRecruit(config, randomUUID(), 'code-joiner');
  assert.equal(matched, null);
});

// v7.1 #3 — selectRecruitProspects must include CRON_ONLY busy peers
// (treats them as ranked-idle) so cron-loop poll jobs don't mask peers
// from auto-join consideration.
test('v7.1 #3 selectRecruitProspects: CRON_ONLY busy peer included as prospect', () => {
  reset();
  addPeer('code-cron-peer', 'code', ['code']);
  // Mark the peer busy with reason='CRON_ONLY' (as the user_prompt hook
  // would on a cron-pattern prompt).
  setPeerBusy(config, 'code-cron-peer', 'CRON_ONLY');
  const prospects = selectRecruitProspects(config, {
    capabilities: ['code'],
    excludeIds: [],
  });
  assert.equal(prospects.length, 1);
  assert.equal(prospects[0].id, 'code-cron-peer');
});

test('v7.1 #3 selectRecruitProspects: USER_DRIVEN busy peer excluded', () => {
  reset();
  addPeer('code-user-peer', 'code', ['code']);
  setPeerBusy(config, 'code-user-peer', 'USER_DRIVEN');
  const prospects = selectRecruitProspects(config, {
    capabilities: ['code'],
    excludeIds: [],
  });
  assert.equal(prospects.length, 0, 'USER_DRIVEN still excludes (regression guard)');
});

test('expireRecruits: deserializes JSON cap arrays correctly', () => {
  reset();
  addPeer('code-orig', 'code');
  const r = makeRecruit({
    capabilities: ['typescript', 'node'],
    excludeCaps: ['experimental'],
    requireAll: true,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  insertRecruit(config, r);
  const expired = expireRecruits(config);
  assert.equal(expired.length, 1);
  assert.deepEqual(expired[0].capabilities, ['typescript', 'node']);
  assert.deepEqual(expired[0].excludeCaps, ['experimental']);
  assert.equal(expired[0].requireAll, true);
});

// ── Idle log + sort precedence ─────────────────────────────────────

test('idle log: append + getLatest returns most recent reason', () => {
  reset();
  addPeer('code-1', 'code');
  appendPeerIdleEvent(config, 'code-1', 'CRON_ONLY');
  appendPeerIdleEvent(config, 'code-1', 'USER_DONE');
  const events = getLatestPeerIdleEvents(config, ['code-1']);
  assert.equal(events.size, 1);
  assert.equal(events.get('code-1').idleReason, 'USER_DONE');
});

test('idle log: pruneStaleIdleLog drops old rows only', () => {
  reset();
  addPeer('code-1', 'code');
  // Insert old row directly
  const db = getDb(config);
  const oldTime = new Date(Date.now() - 3600_000).toISOString();
  db.prepare(`INSERT INTO peer_idle_log (peer_id, idle_at, idle_reason) VALUES (?, ?, ?)`)
    .run('code-1', oldTime, 'USER_DONE');
  // Fresh row
  appendPeerIdleEvent(config, 'code-1', 'EXPLICIT_IDLE');
  const dropped = pruneStaleIdleLog(config, 1800);
  assert.equal(dropped, 1);
  const events = getLatestPeerIdleEvents(config, ['code-1']);
  assert.equal(events.get('code-1').idleReason, 'EXPLICIT_IDLE');
});

test('prospect sort: USER_DONE precedes CRON_ONLY precedes EXPLICIT_IDLE', () => {
  reset();
  addPeer('code-explicit', 'code', ['typescript']);
  addPeer('code-cron', 'code', ['typescript']);
  addPeer('code-userdone', 'code', ['typescript']);
  appendPeerIdleEvent(config, 'code-explicit', 'EXPLICIT_IDLE');
  appendPeerIdleEvent(config, 'code-cron', 'CRON_ONLY');
  appendPeerIdleEvent(config, 'code-userdone', 'USER_DONE');
  const prospects = selectRecruitProspects(config, {
    capabilities: ['typescript'],
    excludeIds: [],
  });
  assert.deepEqual(prospects.map(p => p.id), ['code-userdone', 'code-cron', 'code-explicit']);
});

test('prospect sort: tiebreak by older idleAt within same reason', () => {
  reset();
  addPeer('code-recent', 'code', ['typescript']);
  addPeer('code-rested', 'code', ['typescript']);
  // code-rested has been idle longer (older idleAt → wins tiebreak)
  const db = getDb(config);
  db.prepare(`INSERT INTO peer_idle_log (peer_id, idle_at, idle_reason) VALUES (?, ?, ?)`)
    .run('code-rested', new Date(Date.now() - 5000).toISOString(), 'USER_DONE');
  db.prepare(`INSERT INTO peer_idle_log (peer_id, idle_at, idle_reason) VALUES (?, ?, ?)`)
    .run('code-recent', new Date().toISOString(), 'USER_DONE');
  const prospects = selectRecruitProspects(config, {
    capabilities: ['typescript'],
    excludeIds: [],
  });
  assert.deepEqual(prospects.map(p => p.id), ['code-rested', 'code-recent']);
});

test('prospect: EXPLICIT_AWAY excluded by default', () => {
  reset();
  addPeer('code-1', 'code', ['typescript']);
  addPeer('code-2', 'code', ['typescript']);
  appendPeerIdleEvent(config, 'code-1', 'USER_DONE');
  appendPeerIdleEvent(config, 'code-2', 'EXPLICIT_AWAY');
  const prospects = selectRecruitProspects(config, {
    capabilities: ['typescript'],
    excludeIds: [],
    // urgency unset → default normal → EXPLICIT_AWAY filtered
  });
  assert.deepEqual(prospects.map(p => p.id), ['code-1']);
});

test('prospect: EXPLICIT_AWAY included when urgency=high', () => {
  reset();
  addPeer('code-1', 'code', ['typescript']);
  addPeer('code-2', 'code', ['typescript']);
  appendPeerIdleEvent(config, 'code-1', 'USER_DONE');
  appendPeerIdleEvent(config, 'code-2', 'EXPLICIT_AWAY');
  const prospects = selectRecruitProspects(config, {
    capabilities: ['typescript'],
    excludeIds: [],
    urgency: 'high',
  });
  // Both included; USER_DONE sorts first, EXPLICIT_AWAY last.
  assert.deepEqual(prospects.map(p => p.id), ['code-1', 'code-2']);
});

test('prospect: peer with no idle event treated as NEVER_BUSY', () => {
  reset();
  addPeer('code-fresh', 'code', ['typescript']);
  addPeer('code-userdone', 'code', ['typescript']);
  appendPeerIdleEvent(config, 'code-userdone', 'USER_DONE');
  // code-fresh has no idle event, treated as NEVER_BUSY (weight 1).
  const prospects = selectRecruitProspects(config, {
    capabilities: ['typescript'],
    excludeIds: [],
  });
  // USER_DONE (0) sorts before NEVER_BUSY (1).
  assert.deepEqual(prospects.map(p => p.id), ['code-userdone', 'code-fresh']);
});
