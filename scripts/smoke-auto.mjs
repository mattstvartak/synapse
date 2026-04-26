// Smoke test the autonomous-mode primitives: thread state, caps, audit.
// Skips the MCP wire — exercises the storage layer + cap helpers directly.
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  upsertPeer, insertMessage,
  upsertThread, getThreadState, closeThread, listOpenAutoThreads,
  logAudit, listAudit,
} from '../dist/storage.js';
import { generateClientId } from '../dist/identity.js';
import { DEFAULT_AUTO_CAPS } from '../dist/types.js';

const dataDir = mkdtempSync(join(tmpdir(), 'synapse-auto-smoke-'));
const config = {
  dataDir,
  defaultTtlSeconds: 86_400,
  peerHeartbeatTimeoutSeconds: 600,
};

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
  console.log(`  ok  ${msg}`);
}

try {
  const codeId    = generateClientId('code');
  const desktopId = generateClientId('desktop');
  const now = new Date().toISOString();
  upsertPeer(config, { id: codeId,    label: 'code',    registeredAt: now, lastSeenAt: now, capabilities: null });
  upsertPeer(config, { id: desktopId, label: 'desktop', registeredAt: now, lastSeenAt: now, capabilities: null });

  // Open an auto thread from code's side.
  const threadId = randomUUID();
  upsertThread(config, {
    threadId,
    modeBySide: { [codeId]: 'auto' },
    goal: 'smoke test',
    openedBy: codeId,
    openedAt: now,
    closedAt: null,
    closeReason: null,
    maxTurns: 3,
    maxWallClockSec: 600,
    maxTokensPerSide: 100,    // tiny — easy to hit
    turnCounts: { [codeId]: 0 },
    tokenCounts: { [codeId]: 0 },
  });

  let thread = getThreadState(config, threadId);
  assert(thread !== null && thread.modeBySide[codeId] === 'auto', 'thread opens with code in auto');
  assert(thread.modeBySide[desktopId] === undefined, 'asymmetric: desktop side unset');

  // List open auto threads.
  const open = listOpenAutoThreads(config);
  assert(open.length === 1 && open[0].threadId === threadId, 'listOpenAutoThreads returns the thread');

  // Audit log entries.
  logAudit(config, {
    id: randomUUID(), toolName: 'synapse_open_auto', callerId: codeId,
    threadId, originThreadId: threadId, originMessageId: null,
    argsHash: 'abc123', result: 'allowed', reason: null,
    calledAt: new Date().toISOString(),
  });
  logAudit(config, {
    id: randomUUID(), toolName: 'Bash', callerId: codeId,
    threadId, originThreadId: threadId, originMessageId: null,
    argsHash: 'def456', result: 'blocked', reason: 'external side effect in auto mode',
    calledAt: new Date().toISOString(),
  });

  const audit = listAudit(config, { threadId });
  assert(audit.length === 2, 'audit log has 2 entries');
  assert(audit.some(e => e.result === 'blocked' && e.toolName === 'Bash'), 'block entry present with reason');

  const filtered = listAudit(config, { callerId: codeId });
  assert(filtered.length === 2, 'filter by caller works');

  // Close on turn cap simulation: bump turn count past max.
  thread.turnCounts[codeId] = thread.maxTurns;
  upsertThread(config, thread);
  closeThread(config, threadId, 'turn_cap');
  thread = getThreadState(config, threadId);
  assert(thread.closedAt !== null, 'thread closes on turn cap');
  assert(thread.closeReason === 'turn_cap', 'close reason recorded');

  // Idempotent close — second call shouldn't change closeReason.
  closeThread(config, threadId, 'paused');
  thread = getThreadState(config, threadId);
  assert(thread.closeReason === 'turn_cap', 'closeThread is no-op on already-closed');

  // Open thread should be empty after close.
  const stillOpen = listOpenAutoThreads(config);
  assert(stillOpen.length === 0, 'no open threads after close');

  // Asymmetric: open second thread with both sides in different modes.
  const sym = randomUUID();
  upsertThread(config, {
    threadId: sym,
    modeBySide: { [codeId]: 'auto', [desktopId]: 'review' },
    goal: 'asymmetric test',
    openedBy: codeId,
    openedAt: new Date().toISOString(),
    closedAt: null, closeReason: null,
    maxTurns: DEFAULT_AUTO_CAPS.maxTurns,
    maxWallClockSec: DEFAULT_AUTO_CAPS.maxWallClockSec,
    maxTokensPerSide: DEFAULT_AUTO_CAPS.maxTokensPerSide,
    turnCounts: { [codeId]: 0, [desktopId]: 0 },
    tokenCounts: { [codeId]: 0, [desktopId]: 0 },
  });
  const symT = getThreadState(config, sym);
  assert(symT.modeBySide[codeId] === 'auto' && symT.modeBySide[desktopId] === 'review', 'asymmetric mode persisted');

  // Auto-state file roundtrip (mimicking what synapse_open_auto does).
  const stateFile = join(dataDir, 'auto-state-code.json');
  writeFileSync(stateFile, JSON.stringify({
    threadId: sym, goal: 'asymmetric test',
    openedAt: symT.openedAt, maxTurns: symT.maxTurns, maxWallClockSec: symT.maxWallClockSec,
  }), 'utf-8');
  assert(existsSync(stateFile), 'auto-state file written');
  const parsed = JSON.parse(readFileSync(stateFile, 'utf-8'));
  assert(parsed.threadId === sym, 'auto-state file roundtrips');
  unlinkSync(stateFile);
  assert(!existsSync(stateFile), 'auto-state file removable for pause');

  console.log('\nALL AUTO-MODE SMOKE TESTS PASSED');
  process.exit(0);
} finally {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
