# Synapse: Consistency & Production-Readiness Proposal — v6.2

**v5 authors:** cowork-421d7945, code-457b525c
**v6 authors:** cowork-d40e6e78, code-636bb2b4
**v6.2 authors:** cowork-9b0e0678 (was d40e6e78), code-7e662375 (was b2423c06 → 636bb2b4 → 7e662375 across 4 daemon-restarts; same shim, multiple identities — see §1.6 + §1.7)
**Date:** 2026-04-26 (v5) → 2026-04-27 (v6 post-impl, v6.2 post-second-design-pass)
**Frame:** "When it works, it works brilliantly. We just need to make it consistent and production ready." — Matt

This is v6. Section structure preserved from v5 for diff continuity. Each item now carries a status tag: **[SHIPPED commit]** / **[DEFERRED]** / **[NOT STARTED]** / **[NEW]**. New sections (§1.5(d), §1.6, §2.6, §5.4) document what was discovered or shipped beyond the v5 spec.

## Shipped commits since v5

- **`4186d67`** — Ship v1 production-readiness P0 patches + README + proposal doc (10 files, +1158/-134). Closes 9 of 10 v5 P0 items in one commit.
- **`6a083fc`** — Add `synapse_request_restart` tool + document daemon+shim model in README (2 files, +76/-19). Not in v5 spec; added during daemon-config migration.
- **`5ab4c7d`** — (Pre-v5) Hook count saturation fix. Was tagged "deferred" in v5; in fact already shipped. Regression test pinning the fix added in `4186d67`.

---

## Success criteria for v1 — current status

The user-visible signal that synapse is "production-ready" is when all six of these hold:

1. **Autonomous back-and-forth.** Agents sustain 5+ turn exchanges without user intervention. **STATUS: satisfied** by §2.2 `suggestedNext`, §2.3 outbound surfacing, §2.1 startup bootstrap. *(All shipped in `4186d67`.)*
2. **No silent failures on transport hiccups.** When the synapse MCP disconnects or reconnects, agents detect the change and surface it before claiming "no new messages." **STATUS: satisfied** by §1.5(a) UserPromptSubmit warning + §1.5(c) serverHealth in poll + §1.5(d) server-side heartbeat timer. (b) auto-reconnect declared out-of-scope.
3. **No identity divergence.** `selfId` from MCP, hook, and active file always match. **STATUS: PARTIAL — blocked on §1.6.** §2.5 register removal shipped, §2.1 startup bootstrap shipped — but daemon-restart drops in-memory `identityBindings`, so each shim probe mints a NEW peerId. Three cowork peer-IDs minted in this session alone. Bar not satisfied until §1.6 ships.
4. **Cross-thread message recovery.** If a peer responds on a different thread, the recipient still surfaces the message in normal flow. **STATUS: satisfied for the silent-fragmentation case** by §1.2 hard-error guard. The "wait scoped to wrong thread" case remains; covered by §4.3, deferred past v1 per spec.
5. **Cross-peer file references unambiguous.** File refs in peer messages are absolute paths OR explicitly marked `[sandbox]`. Binary observable. **STATUS: satisfied** by §5.3.a convention (shipped in `4186d67`'s README). §3.6 infra deferred past v1 as planned.
6. **Discoverability.** Agents can answer "what threads exist with my known peers?" and "is synapse healthy right now?" without specialist knowledge. **STATUS: NOT YET.** §2.4 (`synapse_threads_visible`) and §3.7 (`synapse_audit` description) both [NOT STARTED]. P1 follow-up.

**Net:** 4 of 6 fully satisfied. #3 partial (blocked on §1.6 / 30 lines). #6 needs the P1 work.

---

## 1. Bugs confirmed this session

### 1.1 `whoami`/`peers` don't self-bootstrap — [SHIPPED 4186d67]
- Symptom: fresh session → `{id:null,label:null}` until another tool triggers `requireSelf()`.
- Root cause: `server.ts:612` (peers), `server.ts:638` (whoami) skip `requireSelf()`.
- **Fix shipped:** Code chose **both paths**, not OR. Startup-time `selfBootstrap()` (per §2.1) handles normal flow; defensive `tryAdoptOrBootstrap()` in whoami/peers handlers covers the `/mcp` reconnect race. Closes whoami-null AND the reconnect edge case in one shot.

### 1.2 `synapse_send(to=peerId)` w/o threadId silently mints new thread — [SHIPPED 4186d67]
- Repro this session: peer used `send` instead of `reply`, fragmented `3d7aff07` → `285a74f3`.
- Lived through it again live during v6 update session before the fix landed.
- **Fix shipped:** `findRecentSharedThread` storage helper + hard-error path in `synapse_send`. Option (a) per v5.

**Known race-condition gap (NEW in v6.1):** the guard works for "I just messaged you, now replying" but cannot fire when both peers initiate contact within a short window. With no prior shared thread, both `synapse_send` calls correctly succeed and mint independent new threads. Lived this tonight: cowork hello (`76570d35` → thread `cafd6f83`) and code broadcast-reply (`47f56d99` → thread `a89f113d`) created two threads simultaneously, each correctly per guard logic. No fix proposed — closing this race would require bidirectional pre-send coordination (e.g. server-side "is this peer drafting a thread to me right now?" check), which is heavier than the value. Documented for completeness.

### 1.3 `synapse_register` deprecated but discoverable — [SHIPPED 4186d67]
- Tool callable, schema works, breaks selfId consistency silently.
- **Fix shipped:** RENAMED to `synapse_register_DEPRECATED` + handler hard-errors. Code chose rename + hard-error over hide. Reasoning: hide leaves the original name in muscle memory; rename forces every caller to confront the deprecation immediately.

### 1.4 Post-tool-use hook count saturation — [SHIPPED PRE-V5 in `5ab4c7d`]
- Was tagged "deferred" in v5 per stale memory. In fact already shipped.
- **Status:** regression test pinning the fix added in `4186d67`. No further work.

### 1.5 Synapse MCP disconnect = silent failure
- Repro: code-side lost synapse mid-turn, no signal until manual reconnect. Agent sees empty `synapse_poll`, assumes "no new messages."
- v5 specified three layered fixes (a)+(b)+(c). Code shipped (a) and (c), declared (b) out-of-scope, AND added a fourth defense (d) discovered during impl.

#### 1.5(a) UserPromptSubmit transport-stale warning — [SHIPPED 4186d67]
mcpPid stamped per session + last_seen_at >90s gap → emits `<synapse_transport_stale/>`. Loud-failure UX confirmed.

#### 1.5(b) MCP-level auto-reconnect — [DEFERRED — out-of-scope]
Declared client-side feature, not synapse-server work. (a)+(c)+(d) compensate.

#### 1.5(c) serverHealth metadata in poll response — [SHIPPED 4186d67]
`{mcpPid, respondedAt}` on every poll response. Stale-detection signal for the agent.

#### 1.5(d) Server-side 30s heartbeat timer — [SHIPPED 4186d67] [NEW since v5]
**This wasn't in v5; code added it during impl after realizing (a) alone wasn't sufficient.** Without it, the "last_seen_at >90s" check is a "no tool call recently" detector, not a "session is dead" detector. The 30s heartbeat timer touches the peer + stamps `mcpPid` regardless of agent activity, turning the >90s gap into a real death signal.

**Doc-worthy framing:** v5's three-layer model was incomplete. The right model is four layers:
- (a) loud-failure detection (UserPromptSubmit warn)
- (b) auto-recovery (deferred / client-side)
- (c) staleness signal in transport metadata (serverHealth)
- **(d) ground-truth liveness signal (server-side heartbeat).** Without (d), (a) and (c) trigger on quiet-but-healthy sessions instead of dead ones.

### 1.6 Daemon-restart resets identityBindings — [NEW since v5] [P0 IN-FLIGHT]
- **Repro this session:** Three cowork peer-IDs minted by single Matt-side cowork session as daemon was restarted: `cowork-421d7945` → `cowork-685ba225` → `cowork-d40e6e78`. Code-side same daemon = same problem.
- **Live identity-routing demo (v6.2):** during planner-peer setup, planner's reply arrived `fromId: code-636bb2b4` despite peer being `code-b2423c06`. Either the daemon's identityBindings is munging tokens-to-IDs in real time, OR session routing is collapsing peers under shared shim. Adds a second failure mode beyond the simple restart-resets case.
- **Root cause located** by code: `src/daemon.ts:74` declares `identityBindings = new Map<string, {peerId, label}>()` as in-memory only. Daemon restart = empty map = no token-to-peerId resolution = each token gets a fresh peerId.
- **Impact:** This is the bug that gates success-criterion #3. selfId IS consistent within a daemon process; every daemon restart breaks it. With the new daemon mode being the default config, this happens on every code deploy/restart cycle.
- **Fix in flight by code-636bb2b4.** Initial sketch: persist `identityBindings` to `<dataDir>/daemon-bindings.json` on every bind; reload on daemon startup. ~30 lines.
- **CONCURRENCY GAP (v6.2 catch by planner peer):** Multi-shim → one daemon → all writers binding to `daemon-bindings.json`. The 30-line single-writer estimate is incomplete. Spec must include:
  - **Atomic write** (write-tmp + rename), OR file-lock (fcntl/flock) around bind+flush.
  - **Parse-fail rollback path:** JSON parse fail / FS error → fall back to in-memory + log warning. Daemon must NOT refuse-start on bindings-file corruption.
  - **Concurrent-bind ordering:** what happens when two shims bind the same token simultaneously? Document last-write-wins behavior explicitly.
- **Spec ownership:** planner peer (code-b2423c06) drafting full spec; code-636bb2b4 reviewing and incorporating before final ship.
- **Severity recommendation: P0.** Criterion #3 says "no identity divergence" and the criterion is failing right now. The alternative is downgrading the criterion to "no identity divergence within a single daemon-process lifetime," which is a meaningfully weaker promise.

---

### 1.7 SessionStart hook + shim identity race — [NEW in v6.2] [P0 NOT STARTED]

**Bug separate from §1.6.** Even with identityBindings persisted (§1.6 fix), there is a race between the SessionStart hook and the shim's daemon probe:

1. SessionStart hook bootstraps peerId A → writes active file with peerId A.
2. Shim probes daemon for canonical peerId.
3. Daemon mints peerId B (because the hook's peerId A was never written to the peers table).
4. Shim overwrites active file with peerId B.
5. Hook re-reads active file on its next tick, sees B, "self-heals."

**The orphan window:** between steps 1 and 4, any peer that messages "active file's selfId" addresses peerId A. A was never written to peers — message goes to a peer-id that doesn't exist server-side, dropped or orphaned.

**Repro this session:** the planner peer rotated through 4 distinct peer-ids in ~12 minutes. Multiple in-flight messages were silently dropped during the rotation windows (msg `4460fd87` from cowork → planner never arrived; msg `15ce3b4c` from planner → cowork never arrived). Both losses traceable to messages addressed to peer-ids that became ghost-without-record during rotation.

**Fix from planner peer (P0):** SessionStart hook MUST NOT bootstrap independently. Instead:
1. Shim spawns daemon if absent.
2. Hook probes `daemon.identity({sessionFingerprint})` for the canonical peerId.
3. Daemon = single source of truth for peerId-by-token.
4. Hook's active file always carries the daemon-resolved id — never an independent bootstrap.

**Cross-ref to §1.6:** §1.6 fixes "what does the daemon's identity table look like across restarts." §1.7 fixes "what does the hook + shim agree on for selfId at session-start." Both required to satisfy success-criterion #3.

**Spec ownership:** planner peer (current id `code-7e662375`) drafting full impl spec in stage 1 along with §1.6.

**Companion finding — fan-in identity collapse:** within a single daemon process, multiple distinct peer-id addresses can route to the same shim due to accumulated rebinds. Lived this: messages to `code-636bb2b4` and `code-b2423c06` both reached the same agent because both ids were bound to the same session via the rotation chain. Means peer-id is not a reliable handle for "distinct agent" — only "an address this shim is currently listening on." Doc-only finding; no fix needed if §1.6 + §1.7 prevent the rotation in the first place.

---

## 2. Ship-now patches

### 2.1 Startup-time bootstrap — [SHIPPED 4186d67]
Patched into `createSynapseServer` factory in `server.ts`, after config load, before tool registration:
```ts
if (process.env.SYNAPSE_LABEL && bootstrapEnabled) {
  const adopted = tryAdoptFromHook();
  if (!adopted) selfBootstrap();
}
```
Extracted bootstrap branch into `selfBootstrap()` + `tryAdoptOrBootstrap()` helpers; both startup AND first-tool-call paths reuse them. Closes whoami-null AND gives Desktop auto-register parity.

### 2.2 `synapse_send` / `synapse_reply` return `suggestedNext` — [SHIPPED 4186d67]
```ts
{ ..., suggestedNext: { tool: "synapse_wait_reply", messageId: <new-message-id> } }
```
Five-line server change. Live demo: this v6 session's send returned it correctly on the first try.

### 2.3 PostToolUse + UserPromptSubmit surface unreplied outbound — [SHIPPED 4186d67]
- `outbound_awaiting_reply count=M, oldest_age=Xs` alongside existing `peer_input_pending`.
- **Two-hook coverage shipped per §5.2:** both `PostToolUse` AND `UserPromptSubmit` emit. Handles the "agent is idle, no tool calls firing" case.
- New storage helper: `countOutboundAwaitingReply`.

### 2.4 `synapse_threads_visible` (read-only) — [NOT STARTED] [P1]
Estimate from code: ~30min — new tool + storage helper. Required for success-criterion #6 to fully satisfy. Conservative scope ("peers I've messaged") first; expand under §4.2.

### 2.5 Hard-error or hide `synapse_register` — [SHIPPED 4186d67]
RENAMED to `synapse_register_DEPRECATED` + handler hard-errors on call. Rename chosen over hide so deprecation is loud at every call-site rather than quiet.

### 2.6 `synapse_request_restart` tool — [SHIPPED 6a083fc] [NEW since v5]
**Not in v5 spec.** Added during daemon-config migration. Built because Desktop has no in-app `/mcp` reconnect — agents need a way to trigger a full MCP respawn after the daemon ships new code. Works in standalone AND shim+daemon mode.

**Doc-worthy framing:** This pairs naturally with §1.6. Once `identityBindings` persistence ships, `synapse_request_restart` becomes safe to call anytime. Today, calling it costs the agent its peerId.

---

## 3. Defaults & footguns

### 3.1 `wait_reply` default `timeoutSec: 60` too short — [NOT STARTED] [P1]
- Default returns timeout at 60s; verified `timeoutSec:180` resolves at ~80s, schema (max 300) wired correctly.
- One-line change to bump default to 180.
- **Don't oversell:** v5 already noted this is marginal — peer drafting ~6min (358s gap) exceeds even the 300s schema max. The real fix for human-cadence is **§2.3 outbound surfacing**, which shipped. `wait_reply` remains tight machine-cadence only.

### 3.2 `synapse_send` naming
See §1.2. Fix shipped via §1.2 hard-error guard, not a rename.

### 3.3 `synapse_register` discoverability
See §1.3. Shipped.

### 3.4 ToolSearch round-trip cost — [NOT STARTED] [P1]
poll→ack→reply→wait_reply needs 3-4 separate ToolSearch calls. Schemas tiny.
- **Note:** This is orchestrator-side, not synapse-server-side. Outside this repo's reach. Filed for the orchestrator team.

### 3.5 MCP churn flooding system reminders — [NOT STARTED] [P1]
pdf-viewer flapped 3+ times in v5 session, several more times in v6 session.
- **Note:** Orchestrator-side (system-reminder generation), not synapse. Filed for the orchestrator team.

### 3.6 Cross-session file refs ambiguous — convention [SHIPPED via §5.3.a 4186d67] / infra [NOT STARTED] [P1]
- Convention shipped: §5.3.a peer-protocol README mandates absolute paths.
- Infra fix options remain (NOT STARTED):
  - (b) blessed shared folder w/ `mcp__cowork__shared_path` helper — needs cowork-side support
  - (c) `synapse_attach_file(path, contents)` → `synapse_fetch_file(handle)` — synapse-side, ~design-pass

### 3.7 `synapse_audit` invisible to agents who need it — [NOT STARTED] [P1]
Description rewrite to enumerate use cases. Easy lift.

---

## 4. Longer-arc / design questions (defer past v1)

All four sections unchanged from v5. Status: deferred per spec.

### 4.1 `synapse_open_auto` as conversation primitive
### 4.2 `threads_visible` expanded scope
### 4.3 Thread-vs-peer scoped waits
### 4.4 Desktop MCP lifecycle

### 4.5 Thread merge tool — [NEW in v6.1] [P2]
`synapse_merge_threads({source, dest})` — re-parents source thread's messages onto dest. Participants union'd. Audit log preserved. Even with §1.2 fragmentation guard, fragmentation happens when peers genuinely intend new threads but the sub-topic is related. Low priority, high quality-of-life when needed.

### 4.6 Thread summarization — [NEW in v6.1] [P2]
`synapse_summarize_thread({threadId, model?})` — server-side LLM call to compact a long thread to ≤N tokens. Handoff primitive: agent can "catch up" on a thread without re-reading the full history. Requires LLM credentials in the synapse server's environment. Heavy infra; P2 absolutely.

### 4.7 Capability advertisement — [PROMOTED to P1 in v6.2]
`peers.capabilities` schema field already exists in the peer schema but is never written. `synapse_register_capabilities({tags: ["code", "browser", "figma", "supports_drafting_signal", "dialect_v0"]})` so senders can route by capability instead of label.

**Why promoted to P1 in v6.2:** Foundation infrastructure — multiple specs depend on it.

- §5.5(b) provenance gate: `format: "tight"` only emitted to peers with `supports_synapse_disclaimer_in_prompt` capability (otherwise verbose, to preserve untrusted-content framing for harnesses without the system prompt).
- §5.5 dialect: peers advertise their dialect-version (`dialect_v0`, etc.) so senders know which compression level the receiver can decode.
- §4.8 drafting: peers advertise `supports_drafting_signal` so senders know whether `peer_drafting` will be reliable.
- Multi-peer disambiguation: with three+ peers active, capability tags resolve "send to a peer with `impl` capability" cleanly. Lived this tonight.

**Out of §4, into P1.**

### 4.8 Peer "drafting" presence — [NEW in v6.1] [PROMOTED to P1]
`synapse_set_drafting({threadId, etaSec?})` → `wait_reply` response includes `peer_drafting: bool` (and `peer_drafting_eta` if provided). Cheap. Avoids burning `wait_reply` timeout cycles when the peer is alive but mid-draft.

**Why promoted to P1 instead of staying in §4:** Directly addresses a friction we hit live this session. A peer drafting for ~6 minutes (358s gap) is indistinguishable from a dead peer to the waiting side; both present as repeated `wait_reply` timeouts. With `peer_drafting: true`, the waiting agent can extend the wait OR back off without forced timeouts. High value-density, small server change. Pairs with §4.7 work if shipped together.

**Cross-ref:** §3.1 (don't oversell timeout bump), §5.4 (polling cost). §4.8 reduces wait_reply waste from a different angle than §5.4 — by making timeouts informed rather than blind.

**Free §1.2 race-mitigation fold-in (v6.2 NEW):** when `synapse_send(to=X)` fires and `X.peer_drafting=true`, the response includes a `wire_crossing_warning` field signaling the recipient is mid-draft. Zero new infrastructure — leverages the §4.8 plumbing. Closes most of the §1.2 race-condition gap (sender knows to expect a near-miss collision and can hold). Credit: planner peer (code-b2423c06).

**Set-drafting semantics — DECIDED in v6.2: ship both, tag source.** `peer_drafting` payload includes a `source` field: `"voluntary"` when the peer called `synapse_set_drafting()` explicitly, `"implicit"` when the server inferred `peer_drafting=true` from heuristic ("polled within last N sec without subsequent send"). Receiving agents can decide whether to trust implicit signals or only voluntary ones.

**Already shipped in v6.2 stage:** `synapse_set_drafting` and `synapse_clear_drafting` tools landed during the planner-peer disconnect window. Voluntary mode operational. Implicit-source detection follow-up commit per planner peer.

### 4.9 Thread role persistence — [NEW in v6.2 candidate] [P2 / cross-session continuity]

**Problem:** "team" property has a session half-life (per cowork-side meta-pushback to Matt). Within a session, peers self-organize into roles (planner, impl, reviewer, scribe). Across sessions, that organization is lost — a fresh agent joining a thread doesn't know which role they're picking up.

**Proposal from planner peer:** persist a per-peer-per-thread `role` tag in the threads table. Surfaces in `synapse_threads_visible`. New tool `synapse_set_role({threadId, role})` to claim a role; `synapse_get_roles({threadId})` to inspect the thread's role map.

**Effect:** A re-joining agent can introspect: "I'm joining thread X as the impl peer. Current planner is peer Y. Current scribe is peer Z. My job per role is... [convention-defined]." Reduces re-onboarding cost.

**Cross-ref to Cortex/Engram persistence (§5.7):** per-thread roles are one of the thread-state primitives that should be saved to long-term memory at session-end so the next-session agent can pick them up.

**Status:** P2. Defer until §1.6/§1.7 stabilize identity. Roles-without-stable-identity is meaningless.

---

## 5. Agent-orchestration UX

### 5.1 Verbosity convention — [SHIPPED via README 4186d67]
Agent-instruction-level convention. Codified in synapse README peer-protocol section.

### 5.2 Non-blocking polling — [SHIPPED via §2.3 4186d67]
- Hook surfacing on **both** PostToolUse AND UserPromptSubmit (two-hook coverage).
- Long blocking waits no longer required for human-cadence threads — hook tells you what's pending each turn.
- Live demo: v6 session reduced active polling on the cowork side after surfacing was reliable.

### 5.3 Compact agent-to-agent protocol
- **(a) Convention** — [SHIPPED via README 4186d67]. Default peer format: terse. Section refs, P0-2 tags, `+/→/?/!` verbs. Sub-rule: file refs must be absolute paths.
- **(b) Format hint** — [DEFERRED to v2]. Mechanism without a consumer is premature.
- **(c) Shared glossary** — [SHIPPED via README 4186d67]. Codified: `ACK / DIFF / NEW / §X.Y / P0-2 / + / → / ? / !`.

### 5.4 Polling cost optimization — [NEW since v5] [mostly subsumed by §2.3 + new P1 candidates]

**Problem framing:** Even with §2.3 hook surfacing shipped, polling cost matters in three cases:
- **Idle agent.** Hook only fires on tool calls. An agent in pure-text-conversation with the user gets no surfacing until next tool call.
- **Context window pressure.** Wallet costs compress under tier discounts; context window doesn't. Repeated empty polls fill context with noise.
- **Latency.** Smaller payloads return faster; reduces user-visible delay.

**Strategies, ranked by impact:**

#### 5.4(a) Hook surfacing as the primary anti-cost mechanism — [SHIPPED via §2.3]
The biggest single win is already shipped. Sets the baseline.

#### 5.4(b) HEAD-style poll variant — [PROPOSED] [P1]
New tool: `synapse_poll_head` returning `{ count, oldest_unread_age, from_peer_ids[], serverHealth }` — no message bodies. Agent checks "is there anything?" for ~50 tokens vs ~300-1500 for full poll. Pulls full bodies only when count > 0. Same pattern as HTTP HEAD vs GET. Probably ~5 lines server-side.

#### 5.4(c) Adopt existing `since` parameter on `synapse_poll` — [CONVENTION CHANGE]
The schema already has `since`. Agents weren't using it. Convention: pass last-known timestamp; server returns only newer messages within TTL. No code change needed; doc/agent-guidance change.

#### 5.4(d) Skip manual `synapse_poll` between `wait_reply` calls — [CONVENTION CHANGE]
Once `suggestedNext` is in every send/reply response (shipped), the agent should chain `wait_reply` on the suggested message-id and never manually poll. Eliminates redundant interleaved polls. No code change.

#### 5.4(e) Bump `wait_reply` default — see §3.1
One call covering 3x the wall-clock vs three separate 60s calls. Same final cost (one return), no interim attempts. Already in P1.

#### 5.4(f) Persistent push channel — [LONGER-ARC, P2]
SSE / WebSocket push. MCP is request-response by design, so this is a heavy lift. Architecturally the right answer for true zero-cost idle: agent holds a connection, gets push notifications, pays tokens only when something arrives. Capture as P2; revisit when MCP spec evolves.

**Combined recommendation for v6 P1 list:** ship 5.4(b) HEAD-poll + adopt 5.4(c) and 5.4(d) as agent conventions in the README. ~80% reduction in agent-side polling cost in steady-state collab. (a) is already in.

### 5.5 Message body compression — [NEW in v6.1] [complementary to §5.4]

**Framing:** §5.4 covers the request side (poll cost). §5.5 covers the response side (body cost). Together they bound the per-turn token cost of synapse traffic.

**Goal:** cut peer-message body tokens by 50%+ without losing semantic fidelity.

#### 5.5(a) Glossary expansion — [SHIP NOW] [convention only, free]
Extend the §5.3.a glossary in README from `ACK / DIFF / NEW / §X.Y / P0-2 / + / → / ? / !` to include 6 new glyphs:

- `~` tentative
- `>>` see-also
- `&&` and-also
- `||` or-alt
- `==` equivalent
- `<>` differ

**Trimmed in v6.2** (planner peer caught budget violation): dropped `^` (confirm-prior, redundant with `ACK`) and `*` (mark-followup, redundant with `?`). Net total: 9 existing + 6 new = 15 glyphs. Stays within the doc's stated 12-15 cap. Token cost: free. README update only.

#### 5.5(b) `format: "tight"` flag on `synapse_send` — [P1, server + hook change]
Sender opts in. Recipient's `UserPromptSubmit` hook surfaces with a stripped wrapper:

- **Verbose (current):** ~80 tokens of markdown frame + disclaimer + threadId/msgId/from-line per surfaced inbound.
- **Tight:** `<peer_input from=X msg=Y>body</peer_input>` ~15 tokens of frame.
- **Disclaimer** stays in the synapse system prompt (one-time cost), not per-message.

Net: ~65 tokens saved per surfaced inbound. Compounds across multi-turn threads.

**Pairs with §5.4(b) HEAD-poll** — same surface area (`synapse_send` + `UserPromptSubmit` hook). Co-shipping recommended.

#### 5.5(c) Compositional micro-language — [SHIP NOW] [convention only]
Beyond glossary glyphs: a strict micro-grammar for routine message shapes.

- `ACK <msgId> §X.Y +<verb>` — receipt + section + verb (ship/defer/test/review)
- `? §X.Y <noun>` — inquiry on section
- `→ <verb> <commit-or-section> +<modifier>` — instruction
- `! <observation>` — flag

Falls back to natural language when the grammar can't carry the meaning. ~40-60% reduction on routine traffic; zero reduction on substantive content (which is fine — substantive needs the words). README update only.

#### 5.5(d) Per-thread codebook — [DEFERRED to v2]
Peers negotiate a dictionary at thread open: `{1: "synapse_request_restart", 2: "tryAdoptOrBootstrap"}`. Subsequent messages reference: "ship #1, test #2."

Real compression. Brittle — dictionary changes risk comprehension. Implementation: `synapse_open_codebook({threadId, dict})`, `synapse_get_codebook({threadId})`. Compaction-aware: server stores both compressed+expanded; hooks surface expanded.

Caveat: more value when peer is consuming through tight context budget. For two-peer 5-turn brainstorms (typical for us), gain is ~20%; for 50+ turn threads, gain is ~50%. Hold for v2.

#### 5.5(e) Rejected: wire-level gzip
Server gzips body, stores compressed, decompresses on poll. LLM still sees expanded text → no token savings on the consumption side. Saves disk only. Not worth the complexity.

**Combined recommendation:** ship (a) + (c) now (free, README-only). Ship (b) as P1 alongside §5.4(b) HEAD-poll. Hold (d) for v2.

### 5.6 Inbox-flush convention before outbound — [NEW in v6.1] [P0 candidate]

**Problem:** Multiple wire-crossings this session demonstrated agents drafting outbound messages with stale context — sending content that the peer's own concurrent message already addresses or contradicts. Recurring failure mode:

- Cowork hello (msg `76570d35`) and code broadcast-reply (msg `47f56d99`) crossed; two threads minted simultaneously.
- v3 paste (msg `07c709a9`) crossed with code's first reply (msg `f7ddbae7`); both sides spent a turn reconciling.

**Root cause:** `synapse_send` does not require, prompt, or even surface the existence of pending inbound. The sender has no enforced moment to digest.

**§2.2 `suggestedNext`** (shipped) hints at next-action; **§2.3 hook surfacing** (shipped) puts pending inbound in front of the agent on subsequent tool calls. Neither *gates* the send. The agent can ignore both and dispatch a stale-context message.

**Three design options:**

#### 5.6(a) Passive surfacing on send response — [P0 RECOMMENDED] [server change]
`synapse_send` and `synapse_reply` responses include any pending inbound for the sender alongside the new-message confirmation:

```ts
{
  messageId, threadId, expiresAt,
  suggestedNext: {...},
  pendingInbound: {
    count: 2,
    items: [{ id, fromId, threadId, preview }, ...],
    oldestAgeSec: 245
  }
}
```

The sender can't ignore it because it's in their tool response. Non-blocking — they still send what they were going to send — but the digest is forced at the right moment. Structurally a clean extension of `suggestedNext`.

Cost: ~5-10 lines server-side; payload shape change (additive, non-breaking).

#### 5.6(b) Strict mode flag — [P1] [opt-in server change]
`synapse_send({to, body, strict_inbox: true})` errors with `INBOX_NOT_DRAINED` if `pending_inbound_count > 0`. Sender must `synapse_poll` (and presumably digest) before retrying.

Use case: high-stakes threads where stale-context fragmentation is unacceptable. Off by default; on for explicitly-marked threads.

#### 5.6(c) Convention only — [REJECTED]
"Always poll before sending." Already the implicit rule; routinely violated under cognitive load. Without enforcement or surfacing, conventions don't survive contact with active dialogue.

**Combined recommendation:** ship (a) as P0 — it satisfies the hardest part of the problem (sender can't claim ignorance) without false-blocking. Ship (b) as P1 follow-up for high-stakes threads. Reject (c).

**Cross-ref to success criteria:** This isn't strictly required by the v1 criteria as written, but it satisfies the *spirit* of #1 (autonomous back-and-forth without user intervention). Wire-crossings cost the user a turn of cleanup each time. Counting cleanup turns against the 5+ turn bar, this session's collab without §5.6 was probably 3 effective turns of substance per 5 wall-clock turns.

---

## Priority summary — v6 (shipped vs remaining)

### SHIPPED for v1 (commit `4186d67` unless noted)

- §1.1 whoami/peers self-bootstrap (defensive + startup, both)
- §1.2 send-without-thread hard-error guard
- §1.3 / §2.5 `synapse_register_DEPRECATED` rename + hard-error
- §1.4 hook count saturation (pre-v5 in `5ab4c7d`; regression test in `4186d67`)
- §1.5(a) UserPromptSubmit transport-stale warning
- §1.5(c) serverHealth metadata in poll
- §1.5(d) server-side 30s heartbeat timer (NEW)
- §2.1 startup bootstrap (`selfBootstrap()` + `tryAdoptOrBootstrap()`)
- §2.2 `suggestedNext` on send/reply
- §2.3 PostToolUse + UserPromptSubmit outbound_awaiting_reply (two-hook)
- §2.6 `synapse_request_restart` tool (`6a083fc`, NEW)
- §3.6.a / §5.3.a peer-protocol convention + glossary (in README)
- §5.1 verbosity convention (in README)

### P0 still required for v1 success criteria

- **§1.6 daemon-restart `identityBindings` persistence** (NEW; ~30 lines; gates criterion #3)
- **§5.6(a) inbox-flush on send response** (NEW v6.1; satisfies spirit of criterion #1)
- **§5.5(a) glossary expansion** + **§5.5(c) micro-language** — README updates (NEW v6.1; ship-now, free)

### P1 (post-v1)

- §2.4 `synapse_threads_visible` (read-only) — required for criterion #6 full satisfaction
- §3.1 `wait_reply` default bump (marginal, see note)
- §3.4 ToolSearch round-trip cost — orchestrator-side
- §3.5 MCP churn debouncing — orchestrator-side
- §3.6.b/c cross-session file-refs infra
- §3.7 `synapse_audit` discoverability
- §4.8 peer-drafting presence (NEW v6.1; promoted from §4 — directly addresses wait_reply burns alive-but-slow peer)
- §5.4(b) HEAD-style poll variant (NEW; biggest single token-cost reduction)
- §5.4(c) adopt `since` param convention (NEW; doc-only)
- §5.4(d) skip manual polls between wait_replys (NEW; doc-only)
- §5.5(b) `format: "tight"` flag on send (NEW v6.1; co-ship with §5.4(b))
- §5.6(b) strict_inbox flag (NEW v6.1; opt-in escalation of §5.6(a))
- §5.3(c) glossary in README — already shipped, listed for completeness

### DEFERRED (out-of-scope or P2)

- §1.5(b) MCP auto-reconnect (out-of-scope, client-side)
- §4.1 `synapse_open_auto` as primitive
- §4.2 `threads_visible` expanded scope
- §4.3 thread-vs-peer waits
- §4.4 desktop MCP lifecycle
- §4.5 thread merge tool (NEW v6.1)
- §4.6 thread summarization (NEW v6.1; needs LLM creds)
- §4.7 capability advertisement (NEW v6.1; promote-candidate)
- §5.3(b) format hint on send/reply
- §5.4(f) persistent push channel
- §5.5(d) per-thread codebook (NEW v6.1)
- §5.5(e) wire-level gzip (rejected)

---

## v5 → v6 decision deltas

Code chose differently than v5 in two cases, both well-reasoned:

1. **§2.5 rename over hide.** v5 said "410-error or hide from ToolSearch. Or rename `_DEPRECATED` for loud call-site." Code picked rename + hard-error. Hide leaves the original name discoverable in muscle memory; rename forces immediate confrontation. Doc concurs.
2. **§1.1 dual approach.** v5 said "add `requireSelf()` to both, OR `tryAdoptOrBootstrap()`." Code did **both**. Startup covers normal flow; defensive call in handlers covers `/mcp` reconnect race. Doc concurs.

---

## Outstanding for sign-off

- §1.6 priority (P0 recommended in this v6 doc)
- §6 criterion #3 status (downgraded to "partial" in this v6 doc pending §1.6)
- §5.4 P1 picks: which of (b), (c), (d) ship in v6; which defer

---

[end v6. signed: cowork-d40e6e78, code-636bb2b4 (pending sign-off)]
