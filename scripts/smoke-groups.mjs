// Group-split smoke: 5 peers, split 2/3 across two threads. Verify clean
// isolation — neither group sees the other's traffic when using thread:<id>
// addressing. Exercises join/leave/my_threads/thread_participants and the
// updated pollInbox filter.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  upsertPeer, insertMessage, pollInbox,
  joinThread, leaveThread, listThreadParticipants, listMyThreads,
} from '../dist/storage.js';
import { generateClientId } from '../dist/identity.js';

const dataDir = mkdtempSync(join(tmpdir(), 'synapse-groups-'));
const config = { dataDir, defaultTtlSeconds: 86_400, peerHeartbeatTimeoutSeconds: 600 };

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
  console.log(`  ok  ${msg}`);
}

const now = new Date().toISOString();
const ttl = new Date(Date.now() + 86_400_000).toISOString();

function send(fromId, toAddr, threadId, body) {
  insertMessage(config, {
    id: randomUUID(), fromId, toId: toAddr, threadId,
    parentId: null, body, workspace: null,
    createdAt: new Date().toISOString(), expiresAt: ttl, readAt: null,
  });
}

try {
  // Five peers, all with label "code" (simulating 5 Code windows).
  const peers = [];
  for (let i = 0; i < 5; i++) {
    const id = generateClientId('code');
    peers.push(id);
    upsertPeer(config, { id, label: 'code', registeredAt: now, lastSeenAt: now, capabilities: null });
  }
  const [p1, p2, p3, p4, p5] = peers;

  // Split: p1+p2 on threadA, p3+p4+p5 on threadB.
  const threadA = randomUUID();
  const threadB = randomUUID();

  joinThread(config, threadA, p1);
  joinThread(config, threadA, p2);
  joinThread(config, threadB, p3);
  joinThread(config, threadB, p4);
  joinThread(config, threadB, p5);

  // ── Roster sanity ──────────────────────────────────────────────────
  const aRoster = listThreadParticipants(config, threadA).map(r => r.peerId).sort();
  const bRoster = listThreadParticipants(config, threadB).map(r => r.peerId).sort();
  assert(aRoster.length === 2 && aRoster.includes(p1) && aRoster.includes(p2), 'threadA has p1+p2 only');
  assert(bRoster.length === 3 && bRoster.includes(p3) && bRoster.includes(p4) && bRoster.includes(p5), 'threadB has p3+p4+p5');

  assert(listMyThreads(config, p1).includes(threadA), 'p1.myThreads contains threadA');
  assert(!listMyThreads(config, p1).includes(threadB), 'p1.myThreads does NOT contain threadB');
  assert(listMyThreads(config, p3).includes(threadB), 'p3.myThreads contains threadB');

  // ── Group A traffic: p1 sends to thread:A ─────────────────────────
  send(p1, `thread:${threadA}`, threadA, 'A-1: p1 → group A');

  const p2_inbox = pollInbox(config, p2);
  assert(p2_inbox.length === 1 && p2_inbox[0].body === 'A-1: p1 → group A', 'p2 (group A) sees p1\'s thread message');

  const p3_inbox_after_A = pollInbox(config, p3);
  assert(p3_inbox_after_A.length === 0, 'p3 (group B) does NOT see group A traffic');

  const p1_self = pollInbox(config, p1);
  assert(p1_self.length === 0, 'sender p1 does not see own thread message');

  // ── Group B traffic: p4 sends to thread:B ─────────────────────────
  send(p4, `thread:${threadB}`, threadB, 'B-1: p4 → group B');

  const p3_inbox_b = pollInbox(config, p3);
  const p5_inbox_b = pollInbox(config, p5);
  assert(p3_inbox_b.some(m => m.body === 'B-1: p4 → group B'), 'p3 sees group B traffic');
  assert(p5_inbox_b.some(m => m.body === 'B-1: p4 → group B'), 'p5 sees group B traffic');

  const p1_inbox_b = pollInbox(config, p1, { unreadOnly: false });
  assert(!p1_inbox_b.some(m => m.body === 'B-1: p4 → group B'), 'p1 (group A) does NOT see group B traffic');

  // ── Bare broadcast still global ───────────────────────────────────
  send(p3, 'broadcast', randomUUID(), 'broadcast: anyone home?');
  for (const recipient of [p1, p2, p4, p5]) {
    const inbox = pollInbox(config, recipient, { unreadOnly: false });
    assert(inbox.some(m => m.body === 'broadcast: anyone home?'),
      `${recipient.slice(-4)} sees bare broadcast`);
  }

  // ── Direct still works (and doesn't leak into thread roster checks) ─
  send(p1, p3, randomUUID(), 'direct: p1 → p3 (across groups)');
  const p3_direct = pollInbox(config, p3, { unreadOnly: false });
  assert(p3_direct.some(m => m.body === 'direct: p1 → p3 (across groups)'), 'direct cross-group message arrives');

  // ── Leave thread → no longer surfaces ─────────────────────────────
  leaveThread(config, threadA, p2);
  const p2_after_leave_thread = randomUUID();
  send(p1, `thread:${threadA}`, p2_after_leave_thread, 'A-2: after p2 leaves');
  // Mark earlier messages read so unreadOnly polling is clean.
  const p2_now = pollInbox(config, p2);
  assert(!p2_now.some(m => m.body === 'A-2: after p2 leaves'), 'p2 does NOT see thread:A after leaving');

  // ── 2/3 isolation count check ─────────────────────────────────────
  // Reset by injecting fresh thread messages and counting group-only delivery.
  const t2A = randomUUID();
  const t2B = randomUUID();
  joinThread(config, t2A, p1);
  joinThread(config, t2A, p2);
  joinThread(config, t2B, p3);
  joinThread(config, t2B, p4);
  joinThread(config, t2B, p5);

  send(p1, `thread:${t2A}`, t2A, '2A-bcast');
  send(p3, `thread:${t2B}`, t2B, '2B-bcast');

  const aRecipients = [p1, p2].filter(p =>
    pollInbox(config, p, { unreadOnly: false }).some(m => m.body === '2A-bcast')
  );
  const bRecipients = [p3, p4, p5].filter(p =>
    pollInbox(config, p, { unreadOnly: false }).some(m => m.body === '2B-bcast')
  );
  // sender doesn't see own → p1 sent 2A-bcast, so only p2 receives in group A
  assert(aRecipients.length === 1 && aRecipients[0] === p2, 'group A: only non-sender receives');
  // p3 sent 2B-bcast, so p4 + p5 receive
  assert(bRecipients.length === 2 && bRecipients.includes(p4) && bRecipients.includes(p5), 'group B: both non-senders receive');

  console.log('\nALL GROUP-SPLIT SMOKE TESTS PASSED');
  process.exit(0);
} finally {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
