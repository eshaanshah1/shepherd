# Shepherd control CLI — design

**Date:** 2026-07-22
**Status:** approved design, pre-implementation
**Branch:** `claude-code-control`

## Goal

Give Claude Code (and any human/script) full programmatic control over a running
Shepherd instance through a `shepherd` CLI: create/edit/delete workspaces, tabs,
and panes; split; change any config item; and — the novel part — **`view`** a
pane's output and **`tell`** a pane text. The same surface serves three actors
equally: Claude orchestrating *other* panes, Claude managing its *own*
environment, and a human scripting Shepherd from any shell.

The key realization that shapes the whole design: **most of this already exists.**
`ControlMessage` in `RemoteProtocol.swift` already carries `cmdNewTab`,
`cmdSplit`, `cmdClosePane`, `cmdFocusPane`, `cmdZoom`, `cmdRenamePane`,
`cmdReorderTab`, `cmdSwitchTab`, `cmdSetWorkspaceDirectory`, `cmdNewWorktreeTab`,
and the host **already applies these to its real store** (that's how Mac-to-Mac
remote workspaces work). The `PtyBroker`/`PtyHub` already keep a 256 KB per-pane
replay ring and an input-injection path. The work is a **local control channel +
a CLI front-end** that reuses this machinery, plus config, discovery, and the
transcript-based `view`.

## Non-goals (v1)

- No new remote/network surface — the control socket is **local only**.
- No interactive prompts in the CLI (Claude can't answer them).
- No `--screen` rendered-grid view (deferred; needs a libghostty cell-read API).
- No MCP server — a thin MCP wrapper over the CLI stays possible later, but the
  CLI is the substrate because it also serves the human-scripting actor.

## Architecture & transport

- The app opens a **dedicated local unix-domain control socket**, separate from
  the existing fire-and-forget hook socket (`SocketServer`). It is
  **request→response**: the CLI sends one command frame and reads one reply
  frame. Reuse `FrameCodec`'s `[u32 big-endian length][json]` framing.
- **Auth = filesystem permissions.** The socket is created mode `0600` under the
  user's own directory; local-only, no pairing/nonce dance.
- The socket path is injected into every pane's PTY env as **`$SHEPHERD_CTL_SOCK`**
  (alongside the existing `SHEPHERD_TAB_ID` / `SHEPHERD_SOCK`), and there is a
  **well-known fallback path** (`~/.shepherd/control.sock`) so a shell *outside*
  a Shepherd pane can still drive the app.
- Command handling **reuses the existing `ControlMessage` store-application
  path** — the code that already powers remote workspaces. Structural verbs wrap
  the existing cases; new verbs (`ls`, `view`, `wait`, `config`, …) are added as
  new request/response cases. All store mutation happens on the main thread, per
  the libghostty threading rule.
- The CLI is the **`shepherdd` executable target with new subcommands**, exposed
  on `PATH` as **`shepherd`** (symlink or dispatch on `argv[0]`). One binary,
  used by Claude-over-Bash and by a human from any shell. The existing
  `shepherdd pty` / `shepherdd attach` subcommands are unchanged.

### New control-socket protocol

A request/response envelope distinct from `ControlMessage` (which is
host↔mirror-shaped). Sketch:

```
Request:  { "cmd": "<verb>", "args": { ... } }
Reply:    { "ok": true,  "data": { ... } }
       |  { "ok": false, "error": "<message>", "code": <int> }
```

Kept additive and versioned. Where a verb maps onto an existing structural
mutation, the handler builds the corresponding `ControlMessage` action and runs
it through the same store apply used for remote clients (single source of truth
for structural changes).

## Addressing — short stable handles

`ls` assigns short, human-ish, **stable-per-lifetime** handles:

- workspaces `ws1`, `ws2`, …
- tabs `t1`, `t2`, … (within their workspace's display)
- panes `p1`, `p2`, …

Handles are stable while the entity lives and are what every command accepts as a
target. Full internal **UUIDs are also always accepted** (unambiguous, scriptable
against `ls --json`). `whoami` resolves the caller's own workspace/tab/pane from
`$SHEPHERD_TAB_ID` (whose value is the pane id) — only meaningful when run inside
a pane.

## Command surface

Handles shown; every target also accepts a UUID.

### Discovery
- `shepherd ls [--json]` — the full tree: workspaces → tabs → panes, each with
  state, cwd, title, and (for agent panes) sessionID. Human-formatted by default,
  `--json` for scripting.
- `shepherd whoami [--json]` — the caller's own `ws`/`t`/`p` handles + ids.

### Structure (wrap existing `ControlMessage` application)
- `shepherd workspace new|rename <ws> <name>|rm <ws>|switch <ws>`
- `shepherd tab new [--workspace <ws>]|close <t>|rename <t> <name>|reorder <t> <index>|switch <t>`
- `shepherd pane split <p> --right|--down` (`--right` = `.row`, `--down` = `.column`;
  see the `SplitAxis` gotcha), `shepherd pane close <p>`
- `shepherd focus <p>` (reveal + focus, crossing workspaces if needed),
  `shepherd zoom <p>` (toggle)

### PTY
- `shepherd tell <p> "text" [--no-enter] [--raw]`
- `shepherd view <p> [--lines N] [--raw] [--follow]`

### Config
- `shepherd config get <key>`, `shepherd config set <key> <value>`,
  `shepherd config list [--json]`

### Orchestration
- `shepherd wait <p> --state <s>[,<s>...] [--timeout <secs>]` — block until the
  pane reaches any listed state (`idle`/`blocked`/`needsCheck`/`error`/`shell`/`working`),
  or `--any-attention` (blocked|needsCheck|error). Exits non-zero on timeout.

## `tell`

`tell` writes text to the pane's PTY via the existing input-injection path and
appends Enter. That is the whole behavior — **no timing logic, no agent-state
inspection.** Claude Code's TUI queues typed input natively when mid-turn and
picks it up at turn-end; an idle agent runs it immediately; a shell runs the
command. Flags:

- `--no-enter` — hold the trailing newline (compose a line, send a bare
  keystroke, then submit later).
- `--raw` — send the literal bytes with no Enter and no interpretation (e.g. a
  control byte, or driving an interactive prompt).

Sending into a `blocked` pane (permission dialog / `AskUserQuestion`) drives that
interactive UI as if typed — intended (this is how one agent can answer another's
prompt), not a special case.

## `view` — target-aware source

The source depends on the target, because a Claude-Code **TUI pane is not
append-only output** — it repaints in place (cursor addressing, spinners,
redraws), so the raw replay ring is a log of paint commands, not a transcript.
Stripping ANSI from it yields incomprehensible fragments. Therefore:

- **Agent pane** (has a live/persisted `sessionID`) → tail the **Claude session
  transcript** at `~/.claude/projects/<project-dir>/<sessionID>.jsonl`, rendered
  as clean user/assistant turns. This is the comprehensible view of "what is this
  agent doing / what did it say."
- **Shell pane** (no sessionID) → **ANSI-stripped tail of the replay ring**
  (append-only shell output reads fine stripped).
- `--raw` forces the raw ring bytes regardless of target.

Flags: `--lines N` (default a sensible tail, e.g. 40), `--raw`, `--follow`
(stream new content; for agents, tail new transcript records; for shells, stream
the ring).

### Transcript parsing (reuse the `recall` approach)

`recall` (`~/Home/dev/tools/recall/recall.py`) already solves transcript reading;
its logic is the reference, **reimplemented in ~30 lines of Swift** so Shepherd
stays self-contained (recall remains the user's personal tool, not a dependency):

- Locate the file by globbing `<sessionID>.jsonl` under `~/.claude/projects/*/`
  (records also carry `cwd`, so the pane's cwd is a cross-check).
- One JSON record per line. Keep `type: "user"` records whose `message.content`
  is a non-empty string that isn't a tool-result / hook / system-reminder /
  local-command stub; keep `type: "assistant"` records, joining their
  `content[].type == "text"` blocks. Skip everything else (tool calls/results).
- Emit the last N turns.

## `config` — unified namespace

One flat key space spanning two backends, transparent to the caller:

- **File-backed keys** (`theme`, `font-size`, `worktree-base`, and any ghostty
  key): `set` writes `~/.config/shepherd/config` and triggers the **live reload**
  (the ⌘⇧R path — re-read config, repaint chrome + terminal grid, agents survive).
  Shepherd-specific keys continue to ride `# shepherd: key = value` comment lines
  parsed by `parseShepherdConfig`.
- **App/store keys** (`sleep.mode`, `serve.remote`, `workspace.<id>.dir`,
  `panes.defaultCollapsed`): `set` mutates the store / `UserDefaults` directly.

`config list` prints each key with a `(file)` / `(app)` backend tag; `--json`
for scripting. Unknown keys error rather than silently writing.

## Safety posture

Deliberately open (this is a scriptable API), with exactly **one guard**:

- **Read / structure / tell / config verbs: no gating.** They execute.
- **Destructive-on-live-work is guarded:** `pane close`, `tab close`, and
  `workspace rm` **refuse without `--force`** when the target holds a **live
  agent** (state other than `shell`) or a **worktree with uncommitted work**.
  For worktrees, `--archive` reuses the existing archive path
  (`AgentStore.requestCloseTab`'s Archive branch) instead of discarding.
- **No interactive prompts** — the CLI never blocks on a Y/N the caller can't
  answer; it errors with the exact flag to re-run with.

## What this unlocks

`ls` + `whoami` + `wait` + `tell` + `view` together make Shepherd a
**multi-agent orchestration substrate**: an agent can spawn panes, assign each a
task via `tell`, `wait` on their states, and `view` their transcripts — the
terminal itself as the conductor's bus, an alternative to the in-process Task
tool where every sub-agent is a real, inspectable, persistent pane.

Example loop:

```sh
p=$(shepherd tab new --workspace ws1 --json | jq -r .pane)
shepherd tell "$p" "cd ~/repo && claude"
shepherd wait "$p" --state idle --timeout 60
shepherd tell "$p" "run the test suite and fix the first failure"
shepherd wait "$p" --any-attention --timeout 900
shepherd view "$p" --lines 60
```

## Components (isolation & testability)

- **Control protocol** — pure request/response envelope + codec (reuse
  `FrameCodec` framing). Unit-testable encode/decode round-trips, like
  `RemoteProtocol`.
- **Control server** — the in-app `@MainActor` socket listener + dispatch to
  store mutations / reads. Mirrors `SocketServer` structure.
- **Transcript reader** — pure function: `(sessionID, lines) -> [Turn]`, no
  AppKit; unit-tested against fixture JSONL (the recall parse rules).
- **Ring text extraction** — pure ANSI-strip + tail over ring bytes; unit-tested.
- **Config resolver** — pure key→backend routing + file read/write helpers;
  unit-tested. File-write and live-reload trigger are the only impure edges.
- **CLI front-end** — argument parsing + socket round-trip + output formatting in
  the `shepherdd` binary. Thin; the logic lives behind the socket.

## Deferred

- `view --screen` (rendered viewport) pending a libghostty cell-read API or an
  in-house vt parser over the ring.
- MCP wrapper over the CLI.
- Remote/mirror exposure of the control CLI (v1 is local only).
- Advertising the capability to Claude automatically (skill / plugin / CLAUDE.md
  note) — an onboarding follow-up, not core.
