// End-to-end smoke for autonomous-mode v1.
// Sandboxed: uses a temp data dir, never touches the real ~/.claude/synapse/synapse.db.
// Drives the hook script directly with stdin payloads, and exercises the
// storage layer for open_auto / pause via the same code paths the MCP tools use.

import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  upsertPeer, upsertThread, getThreadState, closeThread, listAudit, logAudit,
} from '../dist/storage.js';
import { generateClientId } from '../dist/identity.js';
import { DEFAULT_AUTO_CAPS } from '../dist/types.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const HOOK_PATH = join(REPO_ROOT, 'hooks', 'synapse_pre_tool_use.mjs');
const POLICY_PATH = join(REPO_ROOT, 'policy', 'tool-effects.json');

const dataDir = mkdtempSync(join(tmpdir(), 'synapse-e2e-'));
const config = { dataDir, defaultTtlSeconds: 86_400, peerHeartbeatTimeoutSeconds: 600 };

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
  console.log(`  ok  ${msg}`);
}

// Invoke the PreToolUse hook with a payload, return { decision, reason }.
function runHook(toolName, label = 'code') {
  const payload = JSON.stringify({
    session_id: 'e2e-test',
    transcript_path: '/dev/null',
    tool_name: toolName,
    tool_input: {},
  });
  const result = spawnSync('node', [HOOK_PATH], {
    input: payload,
    env: { ...process.env, SYNAPSE_LABEL: label, SYNAPSE_DATA_DIR: dataDir },
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`hook exited ${result.status}: ${result.stderr}`);
  }
  if (!result.stdout) return { decision: 'approve' };
  try { return JSON.parse(result.stdout.trim()); }
  catch { return { decision: 'approve', raw: result.stdout }; }
}

// Mirror what synapse_open_auto does (without spinning up a server).
function openAuto(threadId, callerId, goal) {
  const now = new Date().toISOString();
  const thread = {
    threadId,
    modeBySide: { [callerId]: 'auto' },
    goal,
    openedBy: callerId,
    openedAt: now,
    closedAt: null,
    closeReason: null,
    maxTurns: DEFAULT_AUTO_CAPS.maxTurns,
    maxWallClockSec: DEFAULT_AUTO_CAPS.maxWallClockSec,
    maxTokensPerSide: DEFAULT_AUTO_CAPS.maxTokensPerSide,
    turnCounts: { [callerId]: 0 },
    tokenCounts: { [callerId]: 0 },
  };
  upsertThread(config, thread);
  writeFileSync(
    join(dataDir, 'auto-state-code.json'),
    JSON.stringify({
      threadId, goal, openedAt: now,
      maxTurns: thread.maxTurns, maxWallClockSec: thread.maxWallClockSec,
    }),
    'utf-8',
  );
  logAudit(config, {
    id: randomUUID(),
    toolName: 'synapse_open_auto',
    callerId, threadId,
    originThreadId: threadId, originMessageId: null,
    argsHash: 'e2e', result: 'allowed', reason: null,
    calledAt: now,
  });
  return thread;
}

function pauseAuto(threadId, callerId) {
  const thread = getThreadState(config, threadId);
  thread.modeBySide[callerId] = 'review';
  const allReview = Object.values(thread.modeBySide).every(m => m === 'review');
  if (allReview) {
    closeThread(config, threadId, 'paused');
    thread.closedAt = new Date().toISOString();
    thread.closeReason = 'paused';
  }
  upsertThread(config, thread);
  const stateFile = join(dataDir, 'auto-state-code.json');
  if (existsSync(stateFile)) unlinkSync(stateFile);
  logAudit(config, {
    id: randomUUID(),
    toolName: 'synapse_pause',
    callerId, threadId,
    originThreadId: threadId, originMessageId: null,
    argsHash: 'e2e', result: 'allowed', reason: null,
    calledAt: new Date().toISOString(),
  });
}

try {
  // Pre-flight: F1 files exist.
  assert(existsSync(POLICY_PATH), 'F1: tool-effects.json policy file present');
  assert(existsSync(HOOK_PATH), 'F1: pre-tool-use hook present');

  // Bootstrap a peer.
  const codeId = generateClientId('code');
  const now = new Date().toISOString();
  upsertPeer(config, { id: codeId, label: 'code', registeredAt: now, lastSeenAt: now, capabilities: null });

  // ── Phase 1: review mode (no auto-state file) — everything approves ─
  const beforeBash = runHook('Bash');
  assert(beforeBash.decision === 'approve', 'review mode: Bash approves');

  const beforeRead = runHook('Read');
  assert(beforeRead.decision === 'approve', 'review mode: Read approves');

  const beforeNotion = runHook('mcp__plugin_Notion_notion__notion-create-pages');
  assert(beforeNotion.decision === 'approve', 'review mode: Notion external approves');

  // ── Phase 2: open auto mode ─────────────────────────────────────────
  const threadId = randomUUID();
  openAuto(threadId, codeId, 'e2e-smoke');

  assert(existsSync(join(dataDir, 'auto-state-code.json')), 'open_auto wrote state file');
  const thread = getThreadState(config, threadId);
  assert(thread.modeBySide[codeId] === 'auto', 'thread persisted as auto for caller');

  // ── Phase 3: in auto, external blocks, internal/none allow ─────────
  const autoBash = runHook('Bash');
  assert(autoBash.decision === 'block', 'auto mode: Bash blocks');
  assert(typeof autoBash.reason === 'string' && autoBash.reason.includes('synapse_pause'),
    'auto block reason mentions synapse_pause');

  const autoRead = runHook('Read');
  assert(autoRead.decision === 'approve', 'auto mode: Read approves (none)');

  const autoIngest = runHook('mcp__engram__memory_ingest');
  assert(autoIngest.decision === 'approve', 'auto mode: memory_ingest approves (internal)');

  const autoSend = runHook('mcp__synapse__synapse_send');
  assert(autoSend.decision === 'approve', 'auto mode: synapse_send approves (internal)');

  const autoOpenAuto = runHook('mcp__synapse__synapse_open_auto');
  assert(autoOpenAuto.decision === 'block', 'auto mode: synapse_open_auto blocks (external — prevents nesting)');

  const autoPause = runHook('mcp__synapse__synapse_pause');
  assert(autoPause.decision === 'approve', 'auto mode: synapse_pause approves (internal — kill switch stays available)');

  const autoNotionCreate = runHook('mcp__plugin_Notion_notion__notion-create-pages');
  assert(autoNotionCreate.decision === 'block', 'auto mode: Notion create blocks');

  const autoNotionFetch = runHook('mcp__plugin_Notion_notion__notion-fetch');
  assert(autoNotionFetch.decision === 'approve', 'auto mode: Notion fetch approves (read)');

  const autoUnknown = runHook('SomeUnknownTool');
  assert(autoUnknown.decision === 'block', 'auto mode: unknown tool falls back to default=external (block)');

  // ── Phase 4: pause — back to review ─────────────────────────────────
  pauseAuto(threadId, codeId);

  assert(!existsSync(join(dataDir, 'auto-state-code.json')), 'pause removed state file');
  const closed = getThreadState(config, threadId);
  assert(closed.closedAt !== null && closed.closeReason === 'paused', 'thread closed with paused reason');

  const afterBash = runHook('Bash');
  assert(afterBash.decision === 'approve', 'after pause: Bash approves');

  const afterNotion = runHook('mcp__plugin_Notion_notion__notion-create-pages');
  assert(afterNotion.decision === 'approve', 'after pause: Notion create approves');

  // ── Phase 5: audit log captured the open_auto + pause ───────────────
  const audit = listAudit(config, { threadId });
  assert(audit.length >= 2, `audit log has open_auto + pause entries (${audit.length})`);
  assert(audit.some(e => e.toolName === 'synapse_open_auto'), 'audit: open_auto recorded');
  assert(audit.some(e => e.toolName === 'synapse_pause'), 'audit: pause recorded');

  console.log('\nALL E2E SMOKE TESTS PASSED');
  process.exit(0);
} finally {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
