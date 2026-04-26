#!/usr/bin/env node
/**
 * Synapse PreToolUse hook — gates tool calls when autonomous mode is open.
 *
 * Behavior:
 *  - No-op (approve) unless an auto-state file exists for this SYNAPSE_LABEL.
 *    The state file is written by synapse_open_auto and removed by
 *    synapse_pause (or natural close).
 *  - When auto-state is present, classifies the incoming tool against the
 *    side-effect registry (synapse/policy/tool-effects.json):
 *      external -> block, with a reason that points the model at synapse_pause.
 *      internal -> approve (sanctioned coordination side-effects).
 *      none     -> approve (read-only).
 *      unknown  -> falls back to the registry's `default` (external).
 *  - Always exits 0; never crashes the user's tool call. Failures inside the
 *    hook log to stderr and approve by default (fail-open, since blocking on
 *    hook bug would brick all tool use).
 *
 * Stdin payload: { session_id, transcript_path, tool_name, tool_input }
 *
 * Env:
 *   SYNAPSE_LABEL    required (otherwise approve and return)
 *   SYNAPSE_DATA_DIR default ~/.claude/synapse
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const POLICY_PATH = join(__dirname, '..', 'policy', 'tool-effects.json');

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function approve() {
  emit({ decision: 'approve' });
}

function block(reason) {
  emit({ decision: 'block', reason });
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    // If nothing piped, end quickly.
    setTimeout(() => resolve(data), 250);
  });
}

function parseLabel() {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--label=')) return arg.slice('--label='.length);
  }
  return process.env.SYNAPSE_LABEL;
}

// v1.2 session_id keying for the auto-state file. The MCP server writes
// `auto-state-<label>-<sessionId>.json` (and the legacy ppid-keyed path
// for backward compat); we prefer the session-keyed path because hook
// and MCP ppids diverge on Windows native.
function findAutoStateFile(dataDir, label, sessionId, ppid) {
  if (sessionId) {
    const candidate = join(dataDir, `auto-state-${label}-${sessionId}.json`);
    if (existsSync(candidate)) return candidate;
  }
  // Freshest auto-state file scan (ignored age cutoff: an open auto thread
  // can be hours old; we just want the most recent matching file).
  let entries;
  try { entries = readdirSync(dataDir); } catch { entries = []; }
  const prefix = `auto-state-${label}-`;
  let best = null, bestMtime = -Infinity;
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const full = join(dataDir, name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.mtimeMs > bestMtime) { bestMtime = stat.mtimeMs; best = full; }
  }
  if (best) return best;
  const legacyPpid = join(dataDir, `auto-state-${label}-${ppid}.json`);
  if (existsSync(legacyPpid)) return legacyPpid;
  const legacyUnscoped = join(dataDir, `auto-state-${label}.json`);
  if (existsSync(legacyUnscoped)) return legacyUnscoped;
  return null;
}

try {
  const label = parseLabel();
  if (!label) approve();

  const dataDir = process.env.SYNAPSE_DATA_DIR ?? join(homedir(), '.claude', 'synapse');
  const PPID = process.ppid;

  // Read stdin first so we can extract session_id before locating state file.
  const raw = await readStdin();
  let payload = {};
  if (raw && raw.trim()) {
    try { payload = JSON.parse(raw); }
    catch { /* fall through with empty payload */ }
  }
  const sessionId = (typeof payload?.session_id === 'string') ? payload.session_id : null;

  const statePath = findAutoStateFile(dataDir, label, sessionId, PPID);
  if (!statePath) approve();

  let state;
  try { state = JSON.parse(readFileSync(statePath, 'utf-8')); }
  catch { approve(); }

  if (!existsSync(POLICY_PATH)) {
    process.stderr.write(`synapse pre-tool-use: policy file missing at ${POLICY_PATH}\n`);
    approve();
  }

  let policy;
  try { policy = JSON.parse(readFileSync(POLICY_PATH, 'utf-8')); }
  catch (err) {
    process.stderr.write(`synapse pre-tool-use: policy parse error: ${err}\n`);
    approve();
  }

  const toolName = payload?.tool_name ?? '';
  const defaultEffect = policy.default ?? 'external';
  const effect = (policy.tools && Object.prototype.hasOwnProperty.call(policy.tools, toolName))
    ? policy.tools[toolName]
    : defaultEffect;

  if (effect === 'external') {
    const threadDesc = state?.threadId ? `thread ${state.threadId}` : 'unspecified thread';
    block(
      `Synapse autonomous mode active (${threadDesc}) — tool ${toolName || '<unknown>'} has external side effects, dropped to review. Pause auto with synapse_pause then retry.`
    );
  }

  approve();
} catch (err) {
  process.stderr.write(`synapse pre-tool-use hook: ${err && err.stack ? err.stack : err}\n`);
  // Fail-open: don't brick tool use on hook bugs.
  approve();
}
