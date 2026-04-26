// Smoke test the storage + identity layer end-to-end against a temp DB.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  upsertPeer, touchPeer, listActivePeers,
  insertMessage, pollInbox, ackMessage, getMessage, getThread,
  pruneExpired,
} from '../dist/storage.js';
import { generateClientId } from '../dist/identity.js';

const dataDir = mkdtempSync(join(tmpdir(), 'synapse-smoke-'));
const config = {
  dataDir,
  defaultTtlSeconds: 86_400,
  peerHeartbeatTimeoutSeconds: 600,
};

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok  ${msg}`);
}

try {
  // Two peers register.
  const codeId = generateClientId('code');
  const desktopId = generateClientId('desktop');
  const now = new Date().toISOString();
  upsertPeer(config, { id: codeId,    label: 'code',    registeredAt: now, lastSeenAt: now, capabilities: null });
  upsertPeer(config, { id: desktopId, label: 'desktop', registeredAt: now, lastSeenAt: now, capabilities: JSON.stringify(['filesystem', 'browser']) });

  const peers = listActivePeers(config);
  assert(peers.length === 2, 'two active peers after register');

  // Code sends a direct message to desktop.
  const msgId = randomUUID();
  const threadId = randomUUID();
  const ttl = new Date(Date.now() + 86_400_000).toISOString();
  insertMessage(config, {
    id: msgId, fromId: codeId, toId: desktopId, threadId, parentId: null,
    body: 'hello from code', workspace: 'onenomad',
    createdAt: now, expiresAt: ttl, readAt: null,
  });

  // Desktop polls — sees one unread.
  let inbox = pollInbox(config, desktopId);
  assert(inbox.length === 1 && inbox[0].body === 'hello from code', 'desktop sees code\'s message');

  // Code polls — sees zero (sender, not recipient).
  let codeInbox = pollInbox(config, codeId);
  assert(codeInbox.length === 0, 'sender does not see own message');

  // Desktop acks.
  const acked = ackMessage(config, msgId);
  assert(acked === true, 'first ack succeeds');
  const reAcked = ackMessage(config, msgId);
  assert(reAcked === false, 'second ack returns false (idempotent)');

  // Desktop polls again — empty (read).
  inbox = pollInbox(config, desktopId);
  assert(inbox.length === 0, 'no unread after ack');

  // Desktop replies on the thread.
  const replyId = randomUUID();
  const parent = getMessage(config, msgId);
  insertMessage(config, {
    id: replyId, fromId: desktopId, toId: parent.fromId, threadId: parent.threadId,
    parentId: parent.id, body: 'hi back', workspace: parent.workspace,
    createdAt: new Date().toISOString(), expiresAt: ttl, readAt: null,
  });

  codeInbox = pollInbox(config, codeId);
  assert(codeInbox.length === 1 && codeInbox[0].body === 'hi back', 'code sees reply');

  const thread = getThread(config, threadId);
  assert(thread.length === 2, 'thread has 2 messages');
  assert(thread[0].body === 'hello from code' && thread[1].body === 'hi back', 'thread chronological');

  // Broadcast: a third peer sends to broadcast.
  const otherId = generateClientId('ipad');
  upsertPeer(config, { id: otherId, label: 'ipad', registeredAt: now, lastSeenAt: now, capabilities: null });
  insertMessage(config, {
    id: randomUUID(), fromId: otherId, toId: 'broadcast', threadId: randomUUID(), parentId: null,
    body: 'ping all', workspace: null,
    createdAt: new Date().toISOString(), expiresAt: ttl, readAt: null,
  });

  const broadcastSeenByCode = pollInbox(config, codeId);
  const broadcastSeenByDesktop = pollInbox(config, desktopId);
  const broadcastSeenBySender = pollInbox(config, otherId);
  assert(broadcastSeenByCode.some(m => m.body === 'ping all'),    'code receives broadcast');
  assert(broadcastSeenByDesktop.some(m => m.body === 'ping all'), 'desktop receives broadcast');
  assert(broadcastSeenBySender.length === 0,                       'broadcast sender does not receive own broadcast');

  // Expiry: insert a message with an already-past expiry, prune.
  insertMessage(config, {
    id: randomUUID(), fromId: codeId, toId: desktopId, threadId: randomUUID(), parentId: null,
    body: 'expired',
    workspace: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2020-01-02T00:00:00.000Z',
    readAt: null,
  });
  const removed = pruneExpired(config);
  assert(removed >= 1, `prune removed ${removed} expired messages`);

  // Workspace filter.
  const filteredInbox = pollInbox(config, desktopId, { workspace: 'onenomad', unreadOnly: false });
  assert(filteredInbox.every(m => m.workspace === 'onenomad'), 'workspace filter works');

  console.log('\nALL SMOKE TESTS PASSED');
  process.exit(0);
} finally {
  // Cleanup (best-effort; SQLite may hold the file briefly on Windows).
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
