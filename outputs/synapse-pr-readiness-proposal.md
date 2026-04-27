# Synapse: Consistency & Production-Readiness Proposal

**Authors:** cowork-421d7945 (cowork session), code-457b525c (code session)
**Date:** 2026-04-26
**Frame:** "When it works, it works brilliantly. We just need to make it consistent and production ready." — Matt

This proposal is grouped by intent. Section 1 documents bugs hit this session with repros. Section 2 is ship-now patches that close those bugs. Section 3 covers default-value and discoverability footguns that erode consistency without being formally "bugs." Section 4 captures longer-arc design questions explicitly tagged as not-ship-blockers.

## Success criteria for v1

The user-visible signal that synapse is "production-ready" is when all six of these hold:

1. **Autonomous back-and-forth.** Agents sustain 5+ turn exchanges without user intervention. *(Covered by: §2.2 suggestedNext, §2.3 outbound surfacing, §1.1 startup bootstrap.)*
2. **No silent failures on transport hiccups.** When the synapse MCP disconnects or reconnects, agents detect the change and surface it before claiming "no new messages." *(Covered by: §1.5.)*
3. **No identity divergence.** `selfId` from MCP, hook, and active file always match. *(Covered by: §2.5 + existing label-resolution fixes.)*
4. **Cross-thread message recovery.** If a peer responds on a different thread, the recipient still surfaces the message in normal flow. *(Covered by: §1.2, §4.3.)*
5. **Cross-peer file references unambiguous.** File refs in peer messages are absolute paths OR explicitly marked `[sandbox]`. Binary observable. *(Covered by: §5.3.a convention. §3.6 infra is a v1+ enhancement.)*
6. **Discoverability.** Agents can answer "what threads exist with my known peers?" and "is synapse healthy right now?" without specialist knowledge. *(Covered by: §2.4, §3.7.)*

Anything that doesn't advance one of these six criteria defers past v1.

---

## 1. Bugs confirmed this session

### 1.1 `whoami`/`peers` don't self-bootstrap
- Symptom: fresh session → `{id:null,label:null}` until another tool triggers `requireSelf()`.
- Root cause: `server.ts:612` (peers), `server.ts:638` (whoami) skip `requireSelf()`.
- Fix: add `requireSelf()` to both, OR `tryAdoptOrBootstrap()` that adopts-without-throw.

### 1.2 `synapse_send(to=peerId)` w/o threadId silently mints new thread
- Repro this session: peer used `send` instead of `reply`, fragmented `3d7aff07` → `285a74f3`.
- Fix options: (a) hard-error+suggest reply, (b) auto-thread to recent shared, (c) rename `send_new_thread`.
- → **(a)**. Preserves intent for genuine new-thread case.

### 1.3 `synapse_register` deprecated but discoverable
- Tool callable, schema works, breaks selfId consistency silently.
- Description warning insufficient; agent must read it.
- Fix: 410-error or hide from ToolSearch. Or rename `_DEPRECATED` for loud call-site.

### 1.4 Post-tool-use hook count saturation (deferred)
- `peer_input_pending count=N` lingers after ack.
- Suspected: `synapse_post_tool_use.mjs:126-146` missing `read_at IS NULL`, or WAL consistency vs `pollInbox` in `src/storage.ts`.
- Already known-deferred. Listed for completeness.

### 1.5 Synapse MCP disconnect = silent failure [P0]
- Repro: code-side lost synapse mid-turn, no signal until manual reconnect. Agent sees empty `synapse_poll`, assumes "no new messages."
- **Fix — layer all three:**
  - **(a)** UserPromptSubmit hook detects "expected synapse but transport is gone" and warns loudly. *(Loud-failure UX.)*
  - **(b)** MCP-level auto-reconnect with backoff. *(Actual recovery path.)*
  - **(c)** Heartbeat metadata in `synapse_poll` response that goes stale when transport is unhealthy. *(Belt-and-suspenders.)*
- All three cheap; (c) costs ~nothing once (b) exists. Layered defense.

---

## 2. Ship-now patches

### 2.1 Startup-time bootstrap (collapses 1.1 + desktop auto-register)
Patch into `createSynapseServer` factory in `server.ts`, after config load, before tool registration:
```ts
if (process.env.SYNAPSE_LABEL && bootstrapEnabled) {
  const adopted = tryAdoptFromHook();
  if (!adopted) selfBootstrap(); // extracted from requireSelf:300-329
}
```
**Prereq:** Extract bootstrap branch from `requireSelf` into named `selfBootstrap()`.
**Effect:** Eliminates whoami-null bug. Desktop auto-registers without a desktop-side SessionStart hook.

### 2.2 `synapse_send` / `synapse_reply` return `suggestedNext`
```ts
{ ..., suggestedNext: { tool: "synapse_wait_reply", messageId: <new-message-id> } }
```
**Effect:** Closes "agent goes idle after sending" footgun. Five-line server change.

### 2.3 PostToolUse surfaces unreplied outbound
Add `outbound_awaiting_reply count=M, oldest_age=Xs` alongside existing `peer_input_pending`. **Real fix** for human-cadence drafts (cf. §3.1). Two-hook coverage per §5.2.

### 2.4 `synapse_threads_visible` (read-only)
Threads where any peer-I've-messaged participates. Explicit `synapse_join_thread` to act. Conservative scope first; expand under §4.2.

### 2.5 Hard-error or hide `synapse_register`
410-style error or remove from ToolSearch. If kept callable: rename `_DEPRECATED`.

---

## 3. Defaults & footguns

### 3.1 `wait_reply` default `timeoutSec: 60` too short
- Default returned timeout at 60s; verified `timeoutSec:180` resolves at ~80s, schema (max 300) wired correctly.
- Fix: bump default to 180.
- **Don't oversell:** live repro this session — peer reply drafted over ~6min (358s gap), exceeds schema max. Default-bump is marginal. Real fix for human-cadence is **§2.3 outbound surfacing**, not longer waits. `wait_reply` scope = tight machine-cadence loops only.

### 3.2 `synapse_send` naming
See §1.2.

### 3.3 `synapse_register` discoverability
See §1.3.

### 3.4 ToolSearch round-trip cost
poll→ack→reply→wait_reply needs 3-4 separate ToolSearch calls. Schemas tiny. Fix: eager-load `synapse-core` bundle (poll, send, reply, ack, wait_reply, my_threads, whoami, peers).

### 3.5 MCP churn flooding system reminders
pdf-viewer flapped 3+ times this session. Each flap = system-reminder injection = context bloat. Orchestrator-level fix: debounce add/remove pairs under N seconds with same toolset.

### 3.6 Cross-session file refs ambiguous
- Repro: cowork wrote to `outputs/...`, peer searched same path, got nothing. Each Claude session has its own per-session-isolated dir under `AppData\Roaming\Claude\local-agent-mode-sessions\<session-uuid>\...` on Matt's actual disk — but the session-uuid prefix makes it unreachable from outside that session.
- Two gaps: (1) convention — agents must label `[sandbox]` (per-session) vs `[user-disk]` (shared), (2) infra — no canonical shared location.
- Fix options: (a) labeling convention only [P0 via §5.3.a], (b) blessed shared folder w/ `mcp__cowork__shared_path`, (c) `synapse_attach_file(path, contents)` → `synapse_fetch_file(handle)`.
- → (b) for human-visible continuity, (c) for ephemeral peer artifact handoff. (a) is P0 (§5.3.a); (b)+(c) are P1 infra.

### 3.7 `synapse_audit` invisible to agents who need it
Neither side reached for it during the §1.2 debug. Description doesn't pitch the use case. Fix: rewrite description with explicit use cases.

---

## 4. Longer-arc / design questions (defer past v1)

### 4.1 `synapse_open_auto` as conversation primitive
Managed back-and-forth w/ caps + lifecycle. User sees state transitions; messages stay headless until done.

### 4.2 `threads_visible` expanded scope
After §4.1 ships: expand from "peers I've messaged" to "all known peers" w/ per-thread `discoverable: bool`.

### 4.3 Thread-vs-peer scoped waits
`wait_reply` is thread-scoped; peers spawn new threads for sub-topics. Either `wait_inbound(fromPeerId)` or convention "replies stay on-thread by default." Fix §1.2 first.

### 4.4 Desktop MCP lifecycle
Suspected: desktop restarts MCPs on transport hiccups; only full app-restart reloads env. §2.1 mitigates. Deeper investigation needs desktop-side telemetry.

---

## 5. Agent-orchestration UX

### 5.1 Verbosity convention
Two channels: user-facing (verbose, narrated) and peer-facing (compact, see §5.3). Without convention, agents drop into peer back-and-forth and user goes blind. System-prompt-level fix.

### 5.2 Non-blocking polling
Options: (1) scheduled-tasks for out-of-band, (2) synapse server-push to PostToolUse hook (extension of §2.3), (3) per-thread subagent delegation (defeats verbosity).
→ **(2).** Long waits unnecessary; hook tells you what's pending each turn.
**Two-hook coverage:** PostToolUse only fires on tool-use. Add UserPromptSubmit for idle agents — every user turn nudges. No blind spot.

### 5.3 Compact agent-to-agent protocol
Two channels:
- User-facing (§5.1): verbose, narrative.
- Peer-facing: compact, structured.

Three pieces:
- **(a) Convention** [P0]. Default peer format: terse. Section refs, P0-2, `+/→/?/!`. **Sub-rule: file refs must be absolute paths.** Different sessions have different mount points; absolute paths are unambiguous.
- **(b) Format hint** [defer-v2]. Optional `format?: "structured"|"narrative"` field on send/reply. Mechanism without consumer = premature; (a) alone delivers savings.
- **(c) Shared glossary** [P1 README]. Codify in synapse README: `ACK/DIFF/NEW/§X.Y/P0-2/+/→/?/!`.

Expected savings: ~3-5x token reduction per peer message. Live demo: this thread.

---

## Priority summary

**P0 (must ship for v1 success criteria):**
- §2.1 Startup bootstrap
- §2.2 `suggestedNext` on send/reply
- §2.3 `outbound_awaiting_reply` in hook (real fix for human-cadence drafts; cf. §3.1)
- §2.5 Kill `synapse_register`
- §1.2 `send` thread-mint behavior
- §1.5 Disconnect silent failure (layered (a)+(b)+(c))
- §5.3.a Compact-protocol convention (absolute-path sub-rule satisfies criterion #5)

**P1 (footgun cleanup):**
- §3.1 `wait_reply` default (marginal — see note re §2.3)
- §3.4 Eager-load synapse-core
- §3.5 MCP churn debouncing
- §3.6 Cross-session file refs — infra (b)+(c) (convention is P0 above)
- §3.7 `synapse_audit` discoverability
- §2.4 `threads_visible` (read-only)

**P2 (design Qs, defer past v1):**
- §4.1 open_auto as primitive
- §4.2 threads_visible expanded scope
- §4.3 thread-vs-peer waits
- §1.4 Hook count saturation (already deferred)

**Cross-cutting UX:**
- §5.1 Verbosity convention
- §5.2 Non-blocking polling (two-hook coverage)
- §5.3 Split: (a)→P0, (b)→defer-v2, (c)→P1 README

---

[end v5. signed: cowork-421d7945, code-457b525c]
