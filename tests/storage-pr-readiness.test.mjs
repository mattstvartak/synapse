// Tests for the storage helpers added to support the PR-readiness P0
// patches: findRecentSharedThread (§1.2 thread-fragmentation guard) and
// countOutboundAwaitingReply (§2.3 outbound surfacing in hooks).
//
// storage.ts caches its DB connection module-globally, so all tests
// share one dataDir. Each test uses unique IDs to avoid collisions.
//
// Run with `node --test tests/storage-pr-readiness.test.mjs` from the
// synapse/ root after `npm run build`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  upsertPeer,
  getPeer,
  insertMessage,
  joinThread,
  findRecentSharedThread,
  countOutboundAwaitingReply,
  pollInboxHead,
  listVisibleThreads,
  setDrafting,
  markImplicitDrafting,
  clearDrafting,
  getOtherPeersDrafting,
  setPeerCapabilities,
} from '../dist/storage.js';

const dataDir = mkdtempSync(join(tmpdir(), 'synapse-pr-test-'));
const config = {
  dataDir,
  defaultTtlSeconds: 86400,
  peerHeartbeatTimeoutSeconds: 600,
};

const PEER_A = 'code-aaaaaaaa';
const PEER_B = 'cowork-bbbbbbbb';
const PEER_C = 'desktop-cccccccc';
const PEER_D = 'code-dddddddd';
const PEER_E = 'cowork-eeeeeeee';
const PEER_F = 'code-ffffffff';
const PEER_G = 'cowork-gggggggg';

function nowIso() { return new Date().toISOString(); }
function futureIso(secsAhead = 3600) {
  return new Date(Date.now() + secsAhead * 1000).toISOString();
}
function pastIso(secsAgo = 60) {
  return new Date(Date.now() - secsAgo * 1000).toISOString();
}

const setupNow = nowIso();
upsertPeer(config, { id: PEER_A, label: 'code', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
upsertPeer(config, { id: PEER_B, label: 'cowork', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
upsertPeer(config, { id: PEER_C, label: 'desktop', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
upsertPeer(config, { id: PEER_D, label: 'code', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
upsertPeer(config, { id: PEER_E, label: 'cowork', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
upsertPeer(config, { id: PEER_F, label: 'code', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
upsertPeer(config, { id: PEER_G, label: 'cowork', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });

test('findRecentSharedThread: returns null when no shared thread exists', () => {
  // PEER_C and PEER_D have never been on a thread together.
  const result = findRecentSharedThread(config, PEER_C, PEER_D);
  assert.equal(result, null);
});

test('findRecentSharedThread: returns thread when both peers participate + non-expired message exists', () => {
  const threadId = 'thread-shared-AB';
  joinThread(config, threadId, PEER_A);
  joinThread(config, threadId, PEER_B);
  insertMessage(config, {
    id: 'msg-AB-1',
    fromId: PEER_A,
    toId: PEER_B,
    threadId,
    parentId: null,
    body: 'hi',
    workspace: null,
    createdAt: nowIso(),
    expiresAt: futureIso(3600),
    readAt: null,
  });
  const result = findRecentSharedThread(config, PEER_A, PEER_B);
  assert.equal(result, threadId);
});

test('findRecentSharedThread: ignores threads where only one peer participates', () => {
  const threadId = 'thread-solo-A';
  joinThread(config, threadId, PEER_A);
  // PEER_E never joins
  insertMessage(config, {
    id: 'msg-soloA-1',
    fromId: PEER_A,
    toId: PEER_E,
    threadId,
    parentId: null,
    body: 'hi E',
    workspace: null,
    createdAt: nowIso(),
    expiresAt: futureIso(3600),
    readAt: null,
  });
  const result = findRecentSharedThread(config, PEER_A, PEER_E);
  assert.equal(result, null);
});

test('findRecentSharedThread: ignores expired messages', () => {
  // Use peers that haven't been used elsewhere in shared threads.
  // PEER_C and PEER_E share an expired-only thread.
  const threadId = 'thread-expired-CE';
  joinThread(config, threadId, PEER_C);
  joinThread(config, threadId, PEER_E);
  insertMessage(config, {
    id: 'msg-expired-CE-1',
    fromId: PEER_C,
    toId: PEER_E,
    threadId,
    parentId: null,
    body: 'old',
    workspace: null,
    createdAt: pastIso(86400 * 2),
    expiresAt: pastIso(60), // already expired
    readAt: null,
  });
  const result = findRecentSharedThread(config, PEER_C, PEER_E);
  assert.equal(result, null);
});

test('findRecentSharedThread: returns most recent thread when multiple shared exist', () => {
  // Use a fresh peer pair (D, B) so we don't conflict with the AB thread above.
  const oldThread = 'thread-old-DB';
  joinThread(config, oldThread, PEER_D);
  joinThread(config, oldThread, PEER_B);
  insertMessage(config, {
    id: 'msg-old-DB-1',
    fromId: PEER_D,
    toId: PEER_B,
    threadId: oldThread,
    parentId: null,
    body: 'old chat',
    workspace: null,
    createdAt: pastIso(3600),
    expiresAt: futureIso(3600),
    readAt: null,
  });
  const newThread = 'thread-new-DB';
  joinThread(config, newThread, PEER_D);
  joinThread(config, newThread, PEER_B);
  insertMessage(config, {
    id: 'msg-new-DB-1',
    fromId: PEER_B,
    toId: PEER_D,
    threadId: newThread,
    parentId: null,
    body: 'fresh chat',
    workspace: null,
    createdAt: nowIso(),
    expiresAt: futureIso(3600),
    readAt: null,
  });
  const result = findRecentSharedThread(config, PEER_D, PEER_B);
  assert.equal(result, newThread);
});

test('countOutboundAwaitingReply: counts outbound with no reply on thread', () => {
  // PEER_C sends to PEER_E with no reply. PEER_C hasn't sent anything else.
  insertMessage(config, {
    id: 'm-out-CE-1',
    fromId: PEER_C,
    toId: PEER_E,
    threadId: 't-out-CE',
    parentId: null,
    body: 'asking',
    workspace: null,
    createdAt: pastIso(120),
    expiresAt: futureIso(),
    readAt: null,
  });
  const result = countOutboundAwaitingReply(config, PEER_C);
  assert.equal(result.count, 1);
  assert.ok(result.oldestAgeSec !== null);
  assert.ok(result.oldestAgeSec >= 119);
  assert.ok(result.oldestAgeSec <= 130);
});

test('countOutboundAwaitingReply: excludes messages where peer has replied on same thread', () => {
  // PEER_E sends to PEER_C. PEER_C replies on the same thread.
  insertMessage(config, {
    id: 'm-out-EC-1',
    fromId: PEER_E,
    toId: PEER_C,
    threadId: 't-replied-EC',
    parentId: null,
    body: 'q',
    workspace: null,
    createdAt: pastIso(300),
    expiresAt: futureIso(),
    readAt: null,
  });
  insertMessage(config, {
    id: 'm-out-EC-2',
    fromId: PEER_C,
    toId: PEER_E,
    threadId: 't-replied-EC',
    parentId: 'm-out-EC-1',
    body: 'a',
    workspace: null,
    createdAt: pastIso(120),
    expiresAt: futureIso(),
    readAt: null,
  });
  const result = countOutboundAwaitingReply(config, PEER_E);
  // PEER_E's outbound on t-replied-EC has been replied to. No other E outbound exists.
  assert.equal(result.count, 0);
});

// Regression test for §1.4 (post-tool-use hook count saturation). The
// fix in commit 5ab4c7d added `read_at IS NULL` to the COUNT query and
// removed the LIMIT 50 clamp. This test exercises the post-tool-use
// hook's COUNT semantics against pollInbox to confirm they agree once
// messages are acked.
test('§1.4 regression: COUNT query agrees with pollInbox after ack', async () => {
  const { ackMessage, pollInbox } = await import('../dist/storage.js');
  // PEER_A receives 3 direct messages from PEER_C (use fresh thread to
  // avoid contaminating the findRecentSharedThread tests above).
  const sharedThread = 'thread-145-AC';
  joinThread(config, sharedThread, PEER_A);
  joinThread(config, sharedThread, PEER_C);
  for (let i = 1; i <= 3; i++) {
    insertMessage(config, {
      id: `m-145-${i}`, fromId: PEER_C, toId: PEER_A, threadId: sharedThread,
      parentId: null, body: `m${i}`, workspace: null,
      createdAt: nowIso(), expiresAt: futureIso(), readAt: null,
    });
  }
  // pollInbox returns 3 unread.
  const before = pollInbox(config, PEER_A, { unreadOnly: true });
  const beforeFor145 = before.filter(m => m.id.startsWith('m-145-'));
  assert.equal(beforeFor145.length, 3);
  // Ack one. The hook's COUNT query should now agree (see post-tool-use
  // implementation: same WHERE shape, plus read_at IS NULL).
  ackMessage(config, 'm-145-1');
  const after = pollInbox(config, PEER_A, { unreadOnly: true });
  const afterFor145 = after.filter(m => m.id.startsWith('m-145-'));
  assert.equal(afterFor145.length, 2);
});

test('countOutboundAwaitingReply: counts only outbound after most recent peer reply', () => {
  // Use a fresh peer pair (F, G) so prior-test residue doesn't bleed in.
  // F → G, G → F (reply), F → G (no reply since).
  insertMessage(config, {
    id: 'm-mixed-FG-1', fromId: PEER_F, toId: PEER_G, threadId: 't-mixed-FG',
    parentId: null, body: 'q1', workspace: null,
    createdAt: pastIso(300), expiresAt: futureIso(), readAt: null,
  });
  insertMessage(config, {
    id: 'm-mixed-FG-2', fromId: PEER_G, toId: PEER_F, threadId: 't-mixed-FG',
    parentId: 'm-mixed-FG-1', body: 'r1', workspace: null,
    createdAt: pastIso(200), expiresAt: futureIso(), readAt: null,
  });
  insertMessage(config, {
    id: 'm-mixed-FG-3', fromId: PEER_F, toId: PEER_G, threadId: 't-mixed-FG',
    parentId: 'm-mixed-FG-2', body: 'q2', workspace: null,
    createdAt: pastIso(60), expiresAt: futureIso(), readAt: null,
  });
  // m-mixed-FG-1 was replied to by m-mixed-FG-2 → not counted.
  // m-mixed-FG-3 has no reply after → counted.
  const result = countOutboundAwaitingReply(config, PEER_F);
  assert.equal(result.count, 1);
  assert.ok(result.oldestAgeSec >= 59 && result.oldestAgeSec <= 80);
});

// §5.4(b) pollInboxHead — same filter shape as pollInbox but no bodies.
test('pollInboxHead: returns count + fromPeerIds + oldestUnreadAgeSec, no bodies', async () => {
  const head = pollInboxHead(config, PEER_F);
  // PEER_F has m-mixed-FG-2 unread on its inbox (G's reply to F).
  assert.ok(head.count >= 1);
  assert.ok(head.fromPeerIds.includes(PEER_G));
  assert.ok(head.oldestUnreadAgeSec !== null);
  // No bodies in payload.
  assert.equal(head.messages, undefined);
  assert.equal(head.body, undefined);
});

test('pollInboxHead: returns zeroed shape when nothing pending', () => {
  // PEER_C in this test file has only sent messages, no unread inbound.
  // (cross-checked by inspecting earlier setup: PEER_C never received
  // a direct un-acked message.)
  const head = pollInboxHead(config, 'code-zzzzzzzz-no-inbox');
  upsertPeer(config, { id: 'code-zzzzzzzz-no-inbox', label: 'code', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
  const head2 = pollInboxHead(config, 'code-zzzzzzzz-no-inbox');
  assert.equal(head2.count, 0);
  assert.equal(head2.oldestUnreadAgeSec, null);
  assert.deepEqual(head2.fromPeerIds, []);
});

// §2.4 listVisibleThreads — discovery for threads with peers I've messaged.
test('listVisibleThreads: shows thread where known peer is on roster, I am not', () => {
  // Create peers H (me) and I (a peer I'll message), and J (third party).
  const PEER_H = 'code-hhhhhhhh';
  const PEER_I = 'cowork-iiiiiiii';
  const PEER_J = 'desktop-jjjjjjjj';
  upsertPeer(config, { id: PEER_H, label: 'code', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
  upsertPeer(config, { id: PEER_I, label: 'cowork', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
  upsertPeer(config, { id: PEER_J, label: 'desktop', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });

  // I directly message I — this establishes "I'm a peer H has messaged."
  insertMessage(config, {
    id: 'm-vis-HI-1', fromId: PEER_H, toId: PEER_I, threadId: 't-vis-HI',
    parentId: null, body: 'hi I', workspace: null,
    createdAt: pastIso(10), expiresAt: futureIso(), readAt: null,
  });
  joinThread(config, 't-vis-HI', PEER_H);
  joinThread(config, 't-vis-HI', PEER_I);

  // I and J converse on a separate thread H is NOT on. Should be visible to H.
  joinThread(config, 't-vis-IJ', PEER_I);
  joinThread(config, 't-vis-IJ', PEER_J);
  insertMessage(config, {
    id: 'm-vis-IJ-1', fromId: PEER_I, toId: PEER_J, threadId: 't-vis-IJ',
    parentId: null, body: 'hi J', workspace: null,
    createdAt: pastIso(5), expiresAt: futureIso(), readAt: null,
  });

  const visible = listVisibleThreads(config, PEER_H);
  const tIJ = visible.find(t => t.threadId === 't-vis-IJ');
  assert.ok(tIJ, 't-vis-IJ should be visible to H');
  assert.equal(tIJ.participantCount, 2);
  assert.ok(tIJ.participantLabels.includes('cowork'));
  assert.ok(tIJ.participantLabels.includes('desktop'));
  // Threads H is already on must NOT show in visible.
  const tHI = visible.find(t => t.threadId === 't-vis-HI');
  assert.equal(tHI, undefined);
});

test('listVisibleThreads: empty when peer has no relationships', () => {
  const PEER_LONE = 'code-lonelone';
  upsertPeer(config, { id: PEER_LONE, label: 'code', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
  const visible = listVisibleThreads(config, PEER_LONE);
  assert.equal(visible.length, 0);
});

// §4.8 drafting state — set/clear/get round trip.
test('setDrafting + getOtherPeersDrafting: peer A sees peer B drafting, not self', () => {
  const PEER_K = 'code-kkkkkkkk';
  const PEER_L = 'cowork-llllllll';
  upsertPeer(config, { id: PEER_K, label: 'code', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
  upsertPeer(config, { id: PEER_L, label: 'cowork', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });

  setDrafting(config, 't-draft-KL', PEER_L, 60);
  setDrafting(config, 't-draft-KL', PEER_K, 30); // self also drafting

  // From K's perspective: only L drafting (self excluded).
  const fromK = getOtherPeersDrafting(config, 't-draft-KL', PEER_K);
  assert.equal(fromK.length, 1);
  assert.equal(fromK[0].peerId, PEER_L);
  assert.ok(fromK[0].etaInSec !== null);
  assert.ok(fromK[0].etaInSec <= 60 && fromK[0].etaInSec >= 50);

  // From L's perspective: only K drafting.
  const fromL = getOtherPeersDrafting(config, 't-draft-KL', PEER_L);
  assert.equal(fromL.length, 1);
  assert.equal(fromL[0].peerId, PEER_K);
});

test('clearDrafting: removes the row', () => {
  const PEER_M = 'cowork-mmmmmmmm';
  upsertPeer(config, { id: PEER_M, label: 'cowork', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
  setDrafting(config, 't-clear-M', PEER_M, null);
  const beforeClear = getOtherPeersDrafting(config, 't-clear-M', 'code-x');
  assert.equal(beforeClear.length, 1);
  const cleared = clearDrafting(config, 't-clear-M', PEER_M);
  assert.equal(cleared, true);
  const afterClear = getOtherPeersDrafting(config, 't-clear-M', 'code-x');
  assert.equal(afterClear.length, 0);
});

test('clearDrafting: returns false when nothing to clear', () => {
  const cleared = clearDrafting(config, 't-nonexistent', 'cowork-nope');
  assert.equal(cleared, false);
});

// §4.7 capability advertising
test('setPeerCapabilities: dedupes + sorts + persists', () => {
  const PEER = 'code-cap1';
  upsertPeer(config, { id: PEER, label: 'code', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
  setPeerCapabilities(config, PEER, ['fs', 'git', 'fs', 'browser']);
  const peer = getPeer(config, PEER);
  assert.equal(peer.capabilities, JSON.stringify(['browser', 'fs', 'git']));
});

test('setPeerCapabilities: empty array clears to NULL', () => {
  const PEER = 'code-cap2';
  upsertPeer(config, { id: PEER, label: 'code', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
  setPeerCapabilities(config, PEER, ['x']);
  setPeerCapabilities(config, PEER, []);
  const peer = getPeer(config, PEER);
  assert.equal(peer.capabilities, null);
});

// §4.8 implicit drafting
test('markImplicitDrafting: visible to other peer with source=implicit', () => {
  const PEER_DRAFT = 'cowork-impl1';
  upsertPeer(config, { id: PEER_DRAFT, label: 'cowork', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
  markImplicitDrafting(config, 't-impl-1', PEER_DRAFT, 60);
  const fromOther = getOtherPeersDrafting(config, 't-impl-1', 'code-other');
  assert.equal(fromOther.length, 1);
  assert.equal(fromOther[0].peerId, PEER_DRAFT);
  assert.equal(fromOther[0].source, 'implicit');
  assert.ok(fromOther[0].etaInSec !== null);
  assert.ok(fromOther[0].etaInSec <= 60);
});

test('markImplicitDrafting: expired rows filtered out', () => {
  const PEER_DRAFT = 'cowork-impl2';
  upsertPeer(config, { id: PEER_DRAFT, label: 'cowork', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
  // ttlSec=0 → eta_at = now → already expired
  markImplicitDrafting(config, 't-impl-2', PEER_DRAFT, 0);
  // Tiny sleep to push eta_at into the past for sure.
  const start = Date.now();
  while (Date.now() - start < 50) { /* spin briefly */ }
  const fromOther = getOtherPeersDrafting(config, 't-impl-2', 'code-other');
  assert.equal(fromOther.length, 0);
});

test('voluntary setDrafting overrides implicit on same (thread, peer)', () => {
  const PEER = 'cowork-impl3';
  upsertPeer(config, { id: PEER, label: 'cowork', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
  markImplicitDrafting(config, 't-impl-3', PEER, 60);
  setDrafting(config, 't-impl-3', PEER, 120);
  const fromOther = getOtherPeersDrafting(config, 't-impl-3', 'code-other');
  assert.equal(fromOther.length, 1);
  assert.equal(fromOther[0].source, 'voluntary');
  assert.ok(fromOther[0].etaInSec >= 110);
});

// §7 observability counters
test('counters: inc + snapshot round-trip', async () => {
  const { inc, get, snapshot, _resetForTests } = await import('../dist/counters.js');
  _resetForTests();
  inc('test.foo');
  inc('test.foo');
  inc('test.bar', 5);
  assert.equal(get('test.foo'), 2);
  assert.equal(get('test.bar'), 5);
  assert.equal(get('test.unset'), 0);
  const snap = snapshot();
  assert.equal(snap.counters['test.foo'], 2);
  assert.equal(snap.counters['test.bar'], 5);
  assert.equal(typeof snap.startedAt, 'string');
  assert.ok(snap.uptimeSec >= 0);
  // Keys are sorted in the snapshot.
  const keys = Object.keys(snap.counters);
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted);
});

test('implicit markImplicitDrafting does NOT downgrade voluntary', () => {
  const PEER = 'cowork-impl4';
  upsertPeer(config, { id: PEER, label: 'cowork', registeredAt: setupNow, lastSeenAt: setupNow, capabilities: null });
  setDrafting(config, 't-impl-4', PEER, 300);
  // Now an implicit signal arrives — should NOT downgrade.
  markImplicitDrafting(config, 't-impl-4', PEER, 30);
  const fromOther = getOtherPeersDrafting(config, 't-impl-4', 'code-other');
  assert.equal(fromOther.length, 1);
  assert.equal(fromOther[0].source, 'voluntary');
  // ETA should still be ~300s, not the implicit's 30s.
  assert.ok(fromOther[0].etaInSec >= 250);
});
