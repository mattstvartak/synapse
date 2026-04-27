# Synapse

Cross-client bridge MCP server. Two Claude clients (Code, Desktop, Cowork — anything that speaks MCP) talk to each other through a shared SQLite mailbox: direct messaging, broadcast, threaded replies, autonomous-mode turn caps, and a SessionStart hook that handles identity adoption automatically.

**Status:** v0.1.0 — usable but actively iterating. See `outputs/synapse-pr-readiness-proposal.md` for the production-readiness spec and roadmap.

## Why

Claude Code and Claude Desktop don't natively share state. Synapse gives them a side channel: when you want one session to brainstorm with another, hand off context, or coordinate a multi-step task across windows, both sessions register as peers in a local SQLite mailbox and exchange messages via MCP tool calls.

Useful when:

- Pairing a Code session (writes the patch) with a Desktop session (reviews / asks questions).
- Splitting a long task across multiple sessions and having them talk asynchronously.
- Building agent-to-agent workflows where each agent has a different model, tool surface, or persona.

Not useful for cross-machine coordination — synapse is intentionally local-only (filesystem + SQLite). If you need machines to talk, run synapse on a shared mount or build a remote transport.

## Install

```bash
npm install
npm run build
```

Both Claude Code and Claude Desktop should point at `dist/cli.js shim` rather than `dist/server.js` directly. The shim is a thin stdio→HTTP proxy that connects to a single long-lived `synapse-mcp daemon` process; the daemon owns the SQLite handle and the actual MCP server logic. Benefits:

- Restarting synapse picks up new code globally — kill the daemon once and every connected shim's next probe respawns it with fresh `dist/`.
- One SQLite handle (cleaner WAL semantics across sessions).
- Sticky identity per label across `/mcp` reconnects (`<dataDir>/<label>-identity.json`).

The daemon auto-spawns on first shim launch (see `src/shim.ts`), so there's no separate "start the daemon" step.

### Claude Code (`~/.claude.json` → per-project `mcpServers`)

```json
{
  "synapse": {
    "type": "stdio",
    "command": "node",
    "args": [
      "C:/absolute/path/to/synapse/dist/cli.js",
      "shim"
    ],
    "env": { "SYNAPSE_LABEL": "code" }
  }
}
```

Hooks wire separately under `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart":     [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:/absolute/path/to/synapse/hooks/synapse_session_start.mjs\" --label=code" }] }],
    "UserPromptSubmit": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:/absolute/path/to/synapse/hooks/synapse_user_prompt.mjs\" --label=code" }] }],
    "PreToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:/absolute/path/to/synapse/hooks/synapse_pre_tool_use.mjs\" --label=code" }] }],
    "PostToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:/absolute/path/to/synapse/hooks/synapse_post_tool_use.mjs\" --label=code" }] }],
    "Stop":             [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:/absolute/path/to/synapse/hooks/synapse_stop_hook.mjs\" --label=code" }] }]
  }
}
```

The `--label=code` argv is the *default*. To run a single Claude Code window under a different label (e.g. `cowork`), set `SYNAPSE_LABEL=cowork` in that window's environment **before** launching `claude`. Env beats argv — see [Identity & label resolution](#identity--label-resolution).

### Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json`)

Desktop has no SessionStart hook. The shim's daemon-spawn handles identity adoption; just set the label in env:

```json
{
  "mcpServers": {
    "synapse": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:/absolute/path/to/synapse/dist/cli.js",
        "shim"
      ],
      "env": { "SYNAPSE_LABEL": "desktop" }
    }
  }
}
```

The peer is live the moment the shim probes the daemon and resolves identity (a few hundred ms after Desktop launch).

## Tool surface

| Tool | Purpose |
| --- | --- |
| `synapse_send` | Send to peer-id, `broadcast`, or `thread:<id>`. Returns `suggestedNext` pointing at `wait_reply`. |
| `synapse_reply` | Reply on the existing thread. Same `suggestedNext` hint. |
| `synapse_poll` | Inbox poll. Auto-touches heartbeat. Includes `serverHealth` for transport diagnostics. |
| `synapse_ack` | Mark a message as read. |
| `synapse_wait_reply` | Long-poll for a reply on a thread. Pair with send/reply to avoid going idle. |
| `synapse_thread` | Full chronological message history for a thread. |
| `synapse_thread_state` | Mode + caps + counters (use before opening auto). |
| `synapse_thread_participants` | Roster — who else will receive `thread:<id>` messages. |
| `synapse_join_thread` / `synapse_leave_thread` | Roster ops. Joining is the mechanism for opting into a group split. |
| `synapse_my_threads` | Threads I'm on. |
| `synapse_open_auto` / `synapse_pause` | Autonomous-mode lifecycle (caps + kill switch). |
| `synapse_peers` / `synapse_whoami` | Identity introspection. Self-bootstrap on first call. |
| `synapse_audit` | Provenance log — debug cross-peer messaging, identify thread fragmentation, audit message routing. |
| `synapse_cleanup` / `synapse_diag` | Zombie reaping + read-only health dump. |
| `synapse_request_restart` | Exit this synapse MCP process so the host respawns it with fresh code. Mainly for Claude Desktop, which has no in-app `/mcp` reconnect. |

`synapse_register` is **deprecated and disabled**. Identity is assigned by SessionStart hook adoption or server-startup self-bootstrap. If you think you need to call it, run `synapse_diag` instead.

## Architecture

Synapse is a single Node.js process per Claude session, talking to a shared SQLite database. Identity, messages, threads, and audit log all live in `~/.claude/synapse/synapse.db` (override with `SYNAPSE_DATA_DIR`).

```
┌─ Claude Code window (label=code) ──────────────┐
│                                                │
│  SessionStart hook ─→ active-code-<sid>.json   │
│                       (writes peer identity)   │
│                                                │
│  MCP server (stdio) ─→ adopts identity         │
│                        from active file        │
│                                                │
│  Hooks (PostToolUse, UserPromptSubmit, …)      │
│  ─→ surface peer_input_pending +               │
│     outbound_awaiting_reply markers            │
└────────────────────────────────────────────────┘
                       │
                       ▼
┌─ ~/.claude/synapse/ ────────────────────────────┐
│  synapse.db        — peers, messages,           │
│                      threads, participants,     │
│                      audit_log                  │
│  active-<l>-<sid>.json  — per-session identity  │
│  auto-state-<l>-<sid>.json — open auto threads  │
└─────────────────────────────────────────────────┘
                       ▲
                       │
┌─ Claude Desktop (label=desktop) ───────────────┐
│  MCP server (stdio) ─→ self-bootstraps from    │
│                        SYNAPSE_LABEL on boot   │
│                        (no SessionStart hook)  │
└────────────────────────────────────────────────┘
```

### Storage

SQLite with WAL journaling. Schema is centralised in `src/schema.ts` as `INIT_SCHEMA_SQL`, imported by both `storage.ts` and the SessionStart hook so they can't drift. Five tables:

- `peers` — id, label, timestamps, capabilities. Auto-pruned after silence × `SYNAPSE_PEER_GC_MULTIPLIER` (default 2 = 20min at default heartbeat).
- `messages` — direct + broadcast + thread-scoped, with TTL (default 24h).
- `threads` — autonomous-mode state (mode-by-side, caps, per-side turn/token counters).
- `thread_participants` — roster for fan-out routing.
- `audit_log` — every tool call recorded with origin thread/message + sha256-truncated arg hash.

### Identity & label resolution

Each session has three layers of identity:

1. **Label** (e.g. `code`, `cowork`, `desktop`) — human-friendly identifier.
2. **Peer ID** (e.g. `code-22fb7ffe`) — `<label>-<8 hex>`, generated once per session.
3. **Session ID** — Claude Code's session UUID (passed to hooks via stdin) or a synthetic UUID for Desktop.

Label resolution in all five hooks: `SYNAPSE_LABEL` env > `--label=<l>` argv > null. Env wins because `~/.claude/settings.json` hardcodes one argv across every Claude Code window globally; per-window label overrides come from per-window environment.

Adoption order on MCP server boot (`tryAdoptOrBootstrap()` in `server.ts`):

1. Read `active-<label>-<sessionId>.json` if `CLAUDE_SESSION_ID` is set in env.
2. Otherwise, pick the freshest `active-<label>-*.json` within the heartbeat window AND pointing at a live peer row.
3. Otherwise, mint a fresh `<label>-<hex>` peer ID, generate a synthetic session ID, persist both. Skipped in daemon mode.

If none of those succeed and `SYNAPSE_LABEL` is unset, the server boots without an identity. `synapse_whoami` and `synapse_peers` will return null self until a tool that calls `requireSelf()` triggers throw-on-failure bootstrap.

### Heartbeat & transport health

While alive, the MCP server pulses `peers.last_seen_at` every 30s and re-stamps `mcpPid` into the active file. The `synapse_user_prompt` hook checks both before its own touch:

- If `mcpPid` is stamped on disk but `last_seen_at` is older than 90s, the MCP server is gone. Hook emits `<synapse_transport_stale/>` so the model surfaces the disconnect to the user instead of claiming "no new messages."
- `synapse_poll` returns `serverHealth: { mcpPid, respondedAt }` so direct callers can sanity-check transport across calls.

This is the §1.5 layered defense from the PR-readiness proposal: hook-level warning (a) + heartbeat metadata (c). Auto-reconnect (b) is a Claude-client-level feature, not server scope.

### Thread fragmentation guard

`synapse_send(to=peerId)` without a `threadId` will *refuse* to mint a new thread when an active thread already exists between the caller and the target peer. The error message points at `synapse_reply` and at the existing threadId. To deliberately start a parallel thread, pass `threadId=<new uuid>`. The guard catches the silent-fragmentation bug where a `send` after a long convo strands the peer's `wait_reply`.

### Outbound surfacing

After every tool call (`PostToolUse`) and every user turn (`UserPromptSubmit`), if you have outbound messages with no peer reply on the thread, you'll see:

```
<outbound_awaiting_reply count="3" oldest_age_sec="412"/>
```

That's the cue to `synapse_wait_reply` (or `synapse_poll`) before treating the conversation as complete. It's the real fix for the "wait_reply timed out, peer was just slow drafting" problem — schema max is 300s, but human-paced peer drafting often exceeds that.

### Auto-mode (autonomous back-and-forth)

`synapse_open_auto({ threadId, goal, maxTurns, maxWallClockSec, maxTokensPerSide })` flips a side of a thread to `auto` mode. Synapse enforces caps:

- `maxTurns` — total send/reply count for that side.
- `maxWallClockSec` — wall-clock budget from `openedAt`.
- `maxTokensPerSide` — estimated body tokens (chars / 4).

Defaults: 8 turns, 600s wall clock, 50k tokens per side. Hitting any cap closes the thread automatically with the appropriate `closeReason` (`turn_cap`, `wall_clock`, `token_cap`). `synapse_pause` is the kill switch.

Per-side asymmetry is supported — Cowork can be in `auto` while Code stays in `review`. Each side enforces its own caps.

## Peer-protocol convention

When two synapse-enabled agents talk to each other, messages are *peer-facing*, not user-facing. The user is reading a transcript with two channels: one verbose narration to them, one terse stream between agents. Without a convention, agents default to user-facing prose for both — which floods context, blinds the user, and burns tokens. The convention below cuts agent-to-agent traffic by ~3-5×.

### Format

Default to compact. Prose only when the peer asked for prose, or the topic genuinely needs it.

- **Section refs:** `§1.2`, `§5.3.a` — point at the exact part of a shared doc.
- **Priority tags:** `P0`, `P1`, `P2` — match the doc's priority summary.
- **Glyph prefixes** (line shape):
  - `+` — agree / add / new fact
  - `→` — conclusion / decision / next action
  - `?` — open question / awaiting peer answer
  - `!` — flag / live observation / warning
  - `~` — tentative — proposing without committing, peer may reject
  - `>>` — see-also — pointer to related earlier message or section
  - `&&` — in-addition — extends the prior point rather than replacing it
  - `||` — or-alternative — offering a fork the peer can pick between
  - `==` — equivalent — restating peer's point in your own words to confirm understanding
  - `<>` — differ — explicit disagreement on a specific framing
  - `^` — confirm-prior — agreement with the immediately previous line/claim
  - `*` — mark-followup — flagging an item for later return without acting now
- **Glossary tokens:**
  - `ACK <subject>` — receipt confirmation, no further work needed
  - `DIFF <vN>→<vN+1>:` — describes a delta to a previously-shared artifact
  - `NEW <subject>` — fresh information, not in the prior thread
  - `→ ship <subject>` / `→ defer <subject>` — explicit ship/defer call

The glyph set caps at ~12 deliberately — beyond that, comprehension drift outweighs token savings. If a meaning isn't covered, write prose for that line.

### File references

**Always absolute.** Different sessions have different mount points (Claude Desktop sandboxes its outputs under `AppData\Roaming\Claude\local-agent-mode-sessions\<session-uuid>\...` — on the user's disk but not reachable without the session UUID). When a peer says "I wrote X," the path must let the recipient verify directly:

- `C:\Users\matts\repo\outputs\foo.md` — shared filesystem, recipient can read.
- `C:\Users\matts\AppData\Roaming\Claude\local-agent-mode-sessions\<uuid>\...\foo.md [sandbox]` — peer-private, recipient cannot read; paste the content inline if the recipient needs it.

If a path could be either: tag explicitly with `[shared]` or `[sandbox]`. Binary observable.

### When *not* to compact

- The user explicitly asked for narrative — write prose.
- A peer used compact format and you have a longer point — answer in prose with `[expanding format because:]` so the receiving agent knows you're not breaking convention by accident.
- The reply contains a copy-paste artifact (markdown doc, code block) — wrap the artifact, keep the surrounding metadata compact.

## Configuration

All env vars are read by both the MCP server and the hooks; set them in your MCP client's env block (or, for argv-style hooks, in the launching shell environment).

| Env var | Default | Effect |
| --- | --- | --- |
| `SYNAPSE_LABEL` | _(none — required)_ | Human-friendly label. Beats `--label=` argv. |
| `SYNAPSE_DATA_DIR` | `~/.claude/synapse` | SQLite DB + active/auto-state files location. |
| `SYNAPSE_TTL_SECONDS` | `86400` (24h) | Default message TTL. Override per-message via `synapse_send({ ttlSeconds })`. |
| `SYNAPSE_PEER_TIMEOUT_SECONDS` | `600` (10m) | Heartbeat window — peers silent longer than this fall out of `synapse_peers`. |
| `SYNAPSE_PEER_GC_MULTIPLIER` | `2` | Hard-prune cushion = heartbeat × this. Default 20min before zombie peer rows are deleted. |
| `SYNAPSE_DAEMON_PORT` | `7847` | HTTP port for daemon mode (advanced; see `src/daemon.ts`). |
| `SYNAPSE_DAEMON_URL` | `http://127.0.0.1:<port>` | Override for the shim's daemon URL (advanced). |

`CLAUDE_SESSION_ID`, if set in the MCP server's env, is used as a session-key hint during adoption. Claude Code doesn't currently expose this, so adoption falls back to picking the freshest active file.

## Hooks

Five hooks in `hooks/`, run by Claude Code's hook system. Each is a `.mjs` file invoked directly (no compilation step — they import compiled types from `dist/` only when needed).

| Hook | Event | Job |
| --- | --- | --- |
| `synapse_session_start.mjs` | `SessionStart` | Adopt or bootstrap identity, write `active-<label>-<sessionId>.json`, GC zombie active files. |
| `synapse_user_prompt.mjs` | `UserPromptSubmit` | Surface unread peer messages (with auto-ack), `outbound_awaiting_reply` marker, `synapse_transport_stale` warning. |
| `synapse_pre_tool_use.mjs` | `PreToolUse` | Inspect auto-mode thread state before peer-facing tool calls. |
| `synapse_post_tool_use.mjs` | `PostToolUse` | Emit `<peer_input_pending/>` + `<outbound_awaiting_reply/>` markers between tool calls. |
| `synapse_stop_hook.mjs` | `Stop` | Cleanup on session end. |

All five share the same `parseLabel()` precedence: env > argv > null.

## Development

```bash
npm run build        # compile src/ → dist/
npm run dev          # tsc --watch
npm start            # node dist/server.js (stdio MCP)
npm test             # see below
```

### Tests

Standalone Node test runner. Run individual files:

```bash
node --test tests/classifier.test.mjs
node --test tests/storage-pr-readiness.test.mjs
```

Or both together:

```bash
node --test tests/classifier.test.mjs tests/storage-pr-readiness.test.mjs
```

The `tests/` directory also has smoke scripts (`*.mjs` without `node:test` imports) for integration checks like daemon-shim handshake and identity stickiness — run those directly with `node tests/<file>`.

### Daemon mode (advanced)

`synapse-mcp daemon` runs an HTTP server that multiple shim processes can connect to. This avoids spinning up a fresh Node process + SQLite handle for every Claude window. Each shim writes its own `active-<label>-<sessionId>.json` and the daemon assigns identities per HTTP connection (`bootstrapEnabled = false` in daemon mode so the daemon can't accidentally mint a server-wide identity).

See `src/daemon.ts` and `src/shim.ts`. Smoke test: `tests/daemon-shim-smoke.mjs`.

## Troubleshooting

### `synapse_whoami` returns `{id: null, label: null}`

Either `SYNAPSE_LABEL` isn't set in the MCP server's env, or no SessionStart hook ran and bootstrap is disabled (daemon mode). Run `synapse_diag` for a full identity-state dump including which env vars are exposed and which active files exist.

### Peer doesn't show in `synapse_peers`

Most common: peer hasn't called any tool yet, so the MCP server hasn't self-bootstrapped. (As of v0.1.x the server self-bootstraps on boot, but this only applies if `SYNAPSE_LABEL` is set.)

Other causes:

- Peer's MCP server crashed — `last_seen_at` will be stale. The hook will surface `<synapse_transport_stale/>` on next user prompt.
- Wrong label — both peers thought they were `code` because env vars weren't propagated. Run `synapse_diag` on both sides to compare.

### Conversation got fragmented across two threads

The §1.2 thread-mint guard catches the most common cause (`send` without `threadId` after an active conversation). If you see threads `t1` and `t2` both with the same two participants and overlapping time windows, the older bug pattern bit you — use `synapse_audit` to trace which message minted the second thread, and `synapse_thread({ threadId })` on each to merge mentally.

### Transport seems to be down

`synapse_diag` returns `processInfo.pid` and the active-file `mcpPid`. If they don't match, the MCP server you're talking to isn't the one stamped on disk — usually a `/mcp` reconnect after the original server died. The active file gets re-stamped on next tool call via `requireSelf()`.

### Hooks aren't firing

Confirm `~/.claude/settings.json` has the hook entries with absolute paths (Claude Code does NOT expand `~`). Check the hook log directory (`~/.claude/projects/<project-id>/`) for stderr from failed hook runs.

## Proposal & roadmap

Production-readiness proposal — success criteria, P0/P1/P2 list, design questions: **`outputs/synapse-pr-readiness-proposal.md`**. The doc is co-authored by two Claude sessions during a real cross-client brainstorm; it's the canonical statement of where synapse is going. If anything in this README contradicts that doc, the doc wins.

## License

(Internal OneNomad project — no public license at this time.)
