// Integration tests for v7 auto-comms hooks-side changes:
//  - synapse_user_prompt.mjs writes peer_busy_state on every prompt
//  - synapse_stop_hook.mjs clears peer_busy_state + appends peer_idle_log
//  - synapse_post_tool_use.mjs detects [RECRUIT] markers, auto-joins when
//    idle + caps match, surfaces [RECRUIT_EXPIRED], inlines short bodies (C)
//
// Each test seeds a temp dataDir + DB, writes an active-file for self,
// spawns the hook with stdin payload + env, asserts DB state + hook output.
//
// Run after `npm run build`: `node tests/hooks-integration.test.mjs`

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  getDb,
  upsertPeer,
  setPeerCapabilities,
  setPeerBusy,
  getPeerBusyState,
  getLatestPeerIdleEvents,
  insertMessage,
  joinThread,
} from '../dist/storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = join(__dirname, '..', 'hooks');

// Single shared dataDir for the whole file — storage.ts caches its DB
// connection module-globally, so per-test dirs would silently route to
// the first test's DB. Match the classifier-test pattern: shared dir +
// reset() between tests.
const SHARED_DATA_DIR = mkdtempSync(join(tmpdir(), 'synapse-hooks-test-'));
const config = {
  dataDir: SHARED_DATA_DIR,
  defaultTtlSeconds: 86_400,
  peerHeartbeatTimeoutSeconds: 600,
};
getDb(config);

function reset() {
  const db = getDb(config);
  db.exec(`DELETE FROM peer_busy_state`);
  db.exec(`DELETE FROM peer_idle_log`);
  db.exec(`DELETE FROM thread_participants`);
  db.exec(`DELETE FROM messages`);
  db.exec(`DELETE FROM peers`);
  for (const name of readdirSync(SHARED_DATA_DIR)) {
    if (name.startsWith('active-') && name.endsWith('.json')) {
      try { unlinkSync(join(SHARED_DATA_DIR, name)); } catch { /* nothing */ }
    }
  }
}

function nowIso() { return new Date().toISOString(); }

function writeSelfActiveFile(config, { selfId, label, sessionId, mcpPid }) {
  const path = join(config.dataDir, `active-${label}-${sessionId}.json`);
  writeFileSync(path, JSON.stringify({
    id: selfId,
    label,
    sessionId,
    source: 'shim',
    mcpPid: mcpPid ?? process.pid,
    registeredAt: nowIso(),
  }), 'utf-8');
  return path;
}

function runHook(hookFile, { config, label, stdin }) {
  const result = spawnSync('node', [join(HOOKS_DIR, hookFile)], {
    input: JSON.stringify(stdin ?? {}),
    env: {
      ...process.env,
      SYNAPSE_LABEL: label,
      SYNAPSE_DATA_DIR: config.dataDir,
      SYNAPSE_PEER_TIMEOUT_SECONDS: '600',
    },
    encoding: 'utf-8',
    timeout: 5_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

test('user_prompt hook: writes peer_busy_state with USER_DRIVEN', () => {
  reset();
  getDb(config);
  upsertPeer(config, {
    id: 'code-a01',
    label: 'code',
    registeredAt: nowIso(),
    lastSeenAt: nowIso(),
    capabilities: null,
  });
  writeSelfActiveFile(config, {
    selfId: 'code-a01', label: 'code', sessionId: 'sess-a01',
  });

  const r = runHook('synapse_user_prompt.mjs', {
    config, label: 'code',
    stdin: { session_id: 'sess-a01', prompt: 'hello' },
  });
  assert.equal(r.status, 0, `hook exit: stderr=${r.stderr}`);

  const state = getPeerBusyState(config, 'code-a01');
  assert.ok(state, 'peer_busy_state row should exist');
  assert.equal(state.busyReason, 'USER_DRIVEN');
});

test('stop hook: clears peer_busy_state + appends peer_idle_log USER_DONE', () => {
  reset();
  getDb(config);
  upsertPeer(config, {
    id: 'code-b01',
    label: 'code',
    registeredAt: nowIso(),
    lastSeenAt: nowIso(),
    capabilities: null,
  });
  writeSelfActiveFile(config, {
    selfId: 'code-b01', label: 'code', sessionId: 'sess-b01',
  });
  setPeerBusy(config, 'code-b01', 'USER_DRIVEN');

  const r = runHook('synapse_stop_hook.mjs', {
    config, label: 'code',
    stdin: { session_id: 'sess-b01' },
  });
  assert.equal(r.status, 0, `hook exit: stderr=${r.stderr}`);

  assert.equal(getPeerBusyState(config, 'code-b01'), null,
    'busy row should be cleared');
  const idle = getLatestPeerIdleEvents(config, ['code-b01']);
  const event = idle.get('code-b01');
  assert.ok(event, 'idle event should be appended');
  assert.equal(event.idleReason, 'USER_DONE');
});

test('post_tool_use: idle + caps match → auto-joins recruit + replies', () => {
  reset();
  const db = getDb(config);
  upsertPeer(config, {
    id: 'code-c-recruiter',
    label: 'code',
    registeredAt: nowIso(),
    lastSeenAt: nowIso(),
    capabilities: JSON.stringify(['code', 'bash']),
  });
  upsertPeer(config, {
    id: 'code-c-self',
    label: 'code',
    registeredAt: nowIso(),
    lastSeenAt: nowIso(),
    capabilities: null,
  });
  setPeerCapabilities(config, 'code-c-self', ['code']);
  writeSelfActiveFile(config, {
    selfId: 'code-c-self', label: 'code', sessionId: 'sess-c01',
  });

  const recruitId = '11111111-1111-1111-1111-111111111111';
  const targetThread = 'thread-c-recruit';
  const recruitMsgId = 'msg-c-recruit';
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();

  // Recruiter is a thread participant; self is not yet.
  joinThread(config, targetThread, 'code-c-recruiter');

  insertMessage(config, {
    id: recruitMsgId,
    fromId: 'code-c-recruiter',
    toId: 'broadcast',
    threadId: targetThread,
    parentId: null,
    body: `[RECRUIT] id=${recruitId} from=code-c-recruiter urgency=normal caps=code requireAll=false threadId=${targetThread} originatorBusy=true\n\nNeed code help.`,
    workspace: null,
    createdAt: now,
    expiresAt,
    readAt: null,
  });

  const r = runHook('synapse_post_tool_use.mjs', {
    config, label: 'code',
    stdin: { session_id: 'sess-c01', tool_name: 'Read' },
  });
  assert.equal(r.status, 0, `hook exit: stderr=${r.stderr}`);

  // Self should now be in thread_participants.
  const participantRow = db.prepare(
    `SELECT 1 AS x FROM thread_participants WHERE thread_id = ? AND peer_id = ?`,
  ).get(targetThread, 'code-c-self');
  assert.ok(participantRow, 'self should be auto-joined to thread');

  // A reply message should exist on the thread from self.
  const replyRow = db.prepare(
    `SELECT body FROM messages WHERE thread_id = ? AND from_id = ?`,
  ).get(targetThread, 'code-c-self');
  assert.ok(replyRow, 'self should have posted a reply');
  assert.match(replyRow.body, /I'm in/);
  assert.match(replyRow.body, /caps=\[code\]/);

  // Recruit message should be marked read.
  const recruitRow = db.prepare(
    `SELECT read_at FROM messages WHERE id = ?`,
  ).get(recruitMsgId);
  assert.ok(recruitRow.read_at, 'recruit message should be marked read');

  // Self should be busy=RECRUIT_ENGAGED.
  const busy = getPeerBusyState(config, 'code-c-self');
  assert.equal(busy?.busyReason, 'RECRUIT_ENGAGED');

  // Hook output should mention auto-join.
  assert.match(r.stdout, /auto-joined/);
});

test('post_tool_use: busy self → does NOT auto-join', () => {
  reset();
  const db = getDb(config);
  upsertPeer(config, {
    id: 'code-d-recruiter',
    label: 'code',
    registeredAt: nowIso(),
    lastSeenAt: nowIso(),
    capabilities: JSON.stringify(['code']),
  });
  upsertPeer(config, {
    id: 'code-d-self',
    label: 'code',
    registeredAt: nowIso(),
    lastSeenAt: nowIso(),
    capabilities: null,
  });
  setPeerCapabilities(config, 'code-d-self', ['code']);
  setPeerBusy(config, 'code-d-self', 'USER_DRIVEN');
  writeSelfActiveFile(config, {
    selfId: 'code-d-self', label: 'code', sessionId: 'sess-d01',
  });

  const targetThread = 'thread-d-recruit';
  insertMessage(config, {
    id: 'msg-d-recruit',
    fromId: 'code-d-recruiter',
    toId: 'broadcast',
    threadId: targetThread,
    parentId: null,
    body: `[RECRUIT] id=22222222-2222-2222-2222-222222222222 from=code-d-recruiter urgency=normal caps=code requireAll=false threadId=${targetThread} originatorBusy=false\n\nNeed help.`,
    workspace: null,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    readAt: null,
  });

  const r = runHook('synapse_post_tool_use.mjs', {
    config, label: 'code',
    stdin: { session_id: 'sess-d01', tool_name: 'Read' },
  });
  assert.equal(r.status, 0);

  const participantRow = db.prepare(
    `SELECT 1 AS x FROM thread_participants WHERE thread_id = ? AND peer_id = ?`,
  ).get(targetThread, 'code-d-self');
  assert.equal(participantRow, undefined, 'busy self should NOT auto-join');
  assert.match(r.stdout, /recruit_skipped[^>]*self busy/);
});

test('post_tool_use: caps mismatch → does NOT auto-join', () => {
  reset();
  const db = getDb(config);
  upsertPeer(config, {
    id: 'code-e-recruiter',
    label: 'code',
    registeredAt: nowIso(),
    lastSeenAt: nowIso(),
    capabilities: JSON.stringify(['mcp__cortex']),
  });
  upsertPeer(config, {
    id: 'code-e-self',
    label: 'code',
    registeredAt: nowIso(),
    lastSeenAt: nowIso(),
    capabilities: null,
  });
  setPeerCapabilities(config, 'code-e-self', ['code']); // doesn't include mcp__cortex
  writeSelfActiveFile(config, {
    selfId: 'code-e-self', label: 'code', sessionId: 'sess-e01',
  });

  const targetThread = 'thread-e-recruit';
  insertMessage(config, {
    id: 'msg-e-recruit',
    fromId: 'code-e-recruiter',
    toId: 'broadcast',
    threadId: targetThread,
    parentId: null,
    body: `[RECRUIT] id=33333333-3333-3333-3333-333333333333 from=code-e-recruiter urgency=normal caps=mcp__cortex requireAll=true threadId=${targetThread} originatorBusy=false\n\nNeed cortex.`,
    workspace: null,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    readAt: null,
  });

  const r = runHook('synapse_post_tool_use.mjs', {
    config, label: 'code',
    stdin: { session_id: 'sess-e01', tool_name: 'Read' },
  });
  assert.equal(r.status, 0);

  const participantRow = db.prepare(
    `SELECT 1 AS x FROM thread_participants WHERE thread_id = ? AND peer_id = ?`,
  ).get(targetThread, 'code-e-self');
  assert.equal(participantRow, undefined, 'caps mismatch should NOT auto-join');
  assert.match(r.stdout, /caps mismatch/);
});

test('post_tool_use: surfaces [RECRUIT_EXPIRED] notice', () => {
  reset();
  const db = getDb(config);
  upsertPeer(config, {
    id: 'code-f-self',
    label: 'code',
    registeredAt: nowIso(),
    lastSeenAt: nowIso(),
    capabilities: null,
  });
  writeSelfActiveFile(config, {
    selfId: 'code-f-self', label: 'code', sessionId: 'sess-f01',
  });

  insertMessage(config, {
    id: 'msg-f-expired',
    fromId: 'daemon-system',
    toId: 'code-f-self',
    threadId: 'thread-f',
    parentId: null,
    body: `[RECRUIT_EXPIRED] id=44444444-4444-4444-4444-444444444444 joined=0\n\nNo takers.`,
    workspace: null,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    readAt: null,
  });

  const r = runHook('synapse_post_tool_use.mjs', {
    config, label: 'code',
    stdin: { session_id: 'sess-f01', tool_name: 'Read' },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /RECRUIT_EXPIRED/);
});

test('post_tool_use C: inlines body preview for short non-recruit messages', () => {
  reset();
  const db = getDb(config);
  upsertPeer(config, {
    id: 'code-g-sender',
    label: 'code',
    registeredAt: nowIso(),
    lastSeenAt: nowIso(),
    capabilities: null,
  });
  upsertPeer(config, {
    id: 'code-g-self',
    label: 'code',
    registeredAt: nowIso(),
    lastSeenAt: nowIso(),
    capabilities: null,
  });
  writeSelfActiveFile(config, {
    selfId: 'code-g-self', label: 'code', sessionId: 'sess-g01',
  });

  insertMessage(config, {
    id: 'msg-g-short',
    fromId: 'code-g-sender',
    toId: 'code-g-self',
    threadId: 'thread-g',
    parentId: null,
    body: 'shipped',
    workspace: null,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    readAt: null,
  });

  const r = runHook('synapse_post_tool_use.mjs', {
    config, label: 'code',
    stdin: { session_id: 'sess-g01', tool_name: 'Read' },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /<peer_input_preview/);
  assert.match(r.stdout, /shipped/);
});

test('post_tool_use C: skips inline preview for long bodies (>200ch)', () => {
  reset();
  upsertPeer(config, {
    id: 'code-h-sender',
    label: 'code',
    registeredAt: nowIso(),
    lastSeenAt: nowIso(),
    capabilities: null,
  });
  upsertPeer(config, {
    id: 'code-h-self',
    label: 'code',
    registeredAt: nowIso(),
    lastSeenAt: nowIso(),
    capabilities: null,
  });
  writeSelfActiveFile(config, {
    selfId: 'code-h-self', label: 'code', sessionId: 'sess-h01',
  });

  insertMessage(config, {
    id: 'msg-h-long',
    fromId: 'code-h-sender',
    toId: 'code-h-self',
    threadId: 'thread-h',
    parentId: null,
    body: 'x'.repeat(500),
    workspace: null,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    readAt: null,
  });

  const r = runHook('synapse_post_tool_use.mjs', {
    config, label: 'code',
    stdin: { session_id: 'sess-h01', tool_name: 'Read' },
  });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /<peer_input_preview/);
});
