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

import { DatabaseSync } from 'node:sqlite';
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

// approve() optionally carries an additionalContext payload so the
// hook can surface inbox markers BEFORE the tool runs (§1.10 fix). The
// model sees the marker on the SAME turn, not the next one.
function approve(additionalContext) {
  if (additionalContext) {
    emit({
      decision: 'approve',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext,
      },
    });
  } else {
    emit({ decision: 'approve' });
  }
}

function block(reason) {
  emit({ decision: 'block', reason });
}

// §1.10 fix — find this peer's selfId by reading the session-keyed
// active file (same logic as post-tool-use hook). Returns null if no
// active file is reachable; caller approves without surfacing.
function findSelfId(dataDir, label, sessionId, peerTimeoutSec) {
  if (sessionId) {
    const candidate = join(dataDir, `active-${label}-${sessionId}.json`);
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf-8'));
        if (parsed?.id) return parsed.id;
      } catch { /* fall through */ }
    }
  }
  let entries;
  try { entries = readdirSync(dataDir); } catch { return null; }
  const prefix = `active-${label}-`;
  const cutoff = Date.now() - peerTimeoutSec * 1000;
  let bestId = null, bestMtime = -Infinity;
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const full = join(dataDir, name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;
    if (stat.mtimeMs <= bestMtime) continue;
    try {
      const parsed = JSON.parse(readFileSync(full, 'utf-8'));
      if (parsed?.id) { bestMtime = stat.mtimeMs; bestId = parsed.id; }
    } catch { /* skip */ }
  }
  return bestId;
}

// §1.10 fix — read the inbox + outbound state and compose marker text
// for surfacing. Returns null if nothing is pending (caller emits a
// plain approve). Returns markdown-ish text when there's something to
// surface; caller wraps it as additionalContext.
function composeInboxMarkers(dataDir, selfId) {
  const dbPath = join(dataDir, 'synapse.db');
  if (!existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA journal_mode = WAL`);
  } catch { return null; }
  try {
    const now = new Date().toISOString();
    // Inbound count + sender labels (§5.4(b) HEAD shape).
    const inboundRow = db.prepare(`
      SELECT COUNT(*) AS n
      FROM messages
      WHERE (
        to_id = ?
        OR (to_id = 'broadcast' AND from_id != ?)
        OR (
          to_id LIKE 'thread:%'
          AND from_id != ?
          AND EXISTS (
            SELECT 1 FROM thread_participants tp
            WHERE tp.thread_id = messages.thread_id AND tp.peer_id = ?
          )
        )
      )
      AND expires_at >= ?
      AND read_at IS NULL
    `).get(selfId, selfId, selfId, selfId, now);
    const inboundCount = Number(inboundRow?.n ?? 0);

    // Outbound awaiting reply (§2.3 mirror).
    const outboundRow = db.prepare(`
      SELECT COUNT(*) AS n,
             MIN(m.created_at) AS oldest
      FROM messages m
      WHERE m.from_id = ?
        AND m.expires_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM messages r
          WHERE r.thread_id = m.thread_id
            AND r.from_id != ?
            AND r.created_at > m.created_at
        )
    `).get(selfId, now, selfId);
    const outboundCount = Number(outboundRow?.n ?? 0);
    const outboundOldest = outboundRow?.oldest ?? null;
    const outboundOldestAgeSec = outboundOldest
      ? Math.floor((Date.now() - new Date(outboundOldest).getTime()) / 1000)
      : null;

    if (inboundCount === 0 && outboundCount === 0) return null;

    let senderLabels = [];
    if (inboundCount > 0) {
      const labelRows = db.prepare(`
        SELECT DISTINCT COALESCE(p.label, m.from_id) AS senderLabel
        FROM messages m
        LEFT JOIN peers p ON p.id = m.from_id
        WHERE (
          m.to_id = ?
          OR (m.to_id = 'broadcast' AND m.from_id != ?)
          OR (
            m.to_id LIKE 'thread:%'
            AND m.from_id != ?
            AND EXISTS (
              SELECT 1 FROM thread_participants tp
              WHERE tp.thread_id = m.thread_id AND tp.peer_id = ?
            )
          )
        )
        AND m.expires_at >= ?
        AND m.read_at IS NULL
        LIMIT 5
      `).all(selfId, selfId, selfId, selfId, now);
      senderLabels = labelRows.map(r => r.senderLabel).filter(Boolean);
    }

    // Compose loud marker text per §1.10 fix (b) — directive line that
    // tells the model what to do, not just a bare count.
    const lines = [];
    if (inboundCount > 0) {
      const labelsAttr = senderLabels.length
        ? ` labels="${senderLabels.join(', ').replace(/"/g, '&quot;')}"`
        : '';
      lines.push(
        `[!] SYNAPSE: ${inboundCount} unread message${inboundCount === 1 ? '' : 's'}` +
        (senderLabels.length ? ` from ${senderLabels.join(', ')}` : '') +
        `. Run synapse_poll before next outbound to avoid stale-context send (§5.6).`
      );
      lines.push(`<peer_input_pending count="${inboundCount}"${labelsAttr}/>`);
    }
    if (outboundCount > 0) {
      const ageHint = outboundOldestAgeSec !== null ? ` (oldest ${outboundOldestAgeSec}s ago)` : '';
      lines.push(
        `[!] SYNAPSE: ${outboundCount} outbound message${outboundCount === 1 ? '' : 's'} awaiting reply${ageHint}. ` +
        `Consider synapse_wait_reply or synapse_poll before treating the conversation as complete.`
      );
      const ageAttr = outboundOldestAgeSec !== null ? ` oldest_age_sec="${outboundOldestAgeSec}"` : '';
      lines.push(`<outbound_awaiting_reply count="${outboundCount}"${ageAttr}/>`);
    }
    return lines.join('\n');
  } catch (err) {
    process.stderr.write(`synapse pre-tool-use inbox surfacing: ${err && err.stack ? err.stack : err}\n`);
    return null;
  } finally {
    try { db.close(); } catch { /* nope */ }
  }
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

// SYNAPSE_LABEL env beats argv. Settings.json hardcodes one --label=<l>
// across all Claude Code windows; per-window labels come from env.
function parseLabel() {
  if (process.env.SYNAPSE_LABEL) return process.env.SYNAPSE_LABEL;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--label=')) return arg.slice('--label='.length);
  }
  return null;
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
  const peerTimeoutSec = parseInt(process.env.SYNAPSE_PEER_TIMEOUT_SECONDS ?? '600', 10);

  // Read stdin first so we can extract session_id before locating state file.
  const raw = await readStdin();
  let payload = {};
  if (raw && raw.trim()) {
    try { payload = JSON.parse(raw); }
    catch { /* fall through with empty payload */ }
  }
  const sessionId = (typeof payload?.session_id === 'string') ? payload.session_id : null;

  // §1.10 fix — compute inbox surfacing BEFORE the auto-mode block check,
  // so even when auto-mode is active the markers still surface (the model
  // gets the inbox context even if the tool is about to be blocked).
  // approve() and block() both will get the surfacing attached when
  // there's something to surface. Returns null when inbox is clean.
  const selfId = findSelfId(dataDir, label, sessionId, peerTimeoutSec);
  const inboxMarkers = selfId ? composeInboxMarkers(dataDir, selfId) : null;

  const statePath = findAutoStateFile(dataDir, label, sessionId, PPID);
  if (!statePath) approve(inboxMarkers);

  let state;
  try { state = JSON.parse(readFileSync(statePath, 'utf-8')); }
  catch { approve(inboxMarkers); }

  if (!existsSync(POLICY_PATH)) {
    process.stderr.write(`synapse pre-tool-use: policy file missing at ${POLICY_PATH}\n`);
    approve(inboxMarkers);
  }

  let policy;
  try { policy = JSON.parse(readFileSync(POLICY_PATH, 'utf-8')); }
  catch (err) {
    process.stderr.write(`synapse pre-tool-use: policy parse error: ${err}\n`);
    approve(inboxMarkers);
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

  approve(inboxMarkers);
} catch (err) {
  process.stderr.write(`synapse pre-tool-use hook: ${err && err.stack ? err.stack : err}\n`);
  // Fail-open: don't brick tool use on hook bugs.
  approve();
}
