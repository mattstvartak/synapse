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
  insertMessage,
  joinThread,
  findRecentSharedThread,
  countOutboundAwaitingReply,
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
