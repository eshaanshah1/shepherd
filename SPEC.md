# Shepherd — v1 Design Spec

A native macOS terminal (SwiftUI chrome, **libghostty** as the terminal engine)
that treats **Claude Code** sessions as first-class, tracked agents. It behaves
like a normal terminal until an agent starts in a tab — then that tab becomes a
tracked agent with a live state, surfaced in a sidebar, so you can run several at
once and never babysit them.

**Status:** design locked, pre-spike · **Audience:** personal / OSS · **Scope:** single window, v1.

---

## 1. Product shape

- One **window**, many **tabs**. A tab holds a **recursive binary split tree of
  panes**, and **each pane is an independently-tracked agent** — run two Claude
  sessions side-by-side in one tab and track both. Horizontal (`⌘D`) + vertical
  (`⌘⇧D`) splits, draggable dividers, and pane zoom all exist
  ([ADR 0012](.claude/adr/0012-pane-splitting-panes-as-agents.md)).
- A persistent **sidebar** of active agents.
- **Claude Code is the only first-class agent.** Other CLIs (codex, aider,
  gemini, …) are just normal terminal tabs — invisible to the sidebar in v1.

## 2. State model — `working` · `blocked` · `need-to-check` · `idle`

`idle` is the single resting state. It covers **both** ends of a session's life:
a freshly opened session that hasn't been prompted, and a finished session whose
output you've already seen. Neither nags; neither sits in the attention queue.

| Trigger | Source | → State |
|---|---|---|
| `SessionStart` (fresh, unprompted) | hook | **idle** |
| `UserPromptSubmit` / `PreToolUse` / `PostToolUse` | hook | **working** |
| `Notification` (permission / input needed; incl. plan-mode approval) | hook | **blocked** |
| `Stop` (turn finished) | hook | **need-to-check** |
| you **focus the tab** while `need-to-check` | app | **idle** |
| `SessionEnd` ∪ PTY child-exit | hook / app | **removed** |

Rules:
- **Focus only clears `need-to-check` → `idle`.** Focusing a `blocked` or
  `working` tab does nothing. (Focus is the unread→read transition for finished
  turns — not a global acknowledge.)
- A `blocked` agent leaves `blocked` only when it actually resumes (next
  `UserPromptSubmit`/`PreToolUse` → `working`).
- `idle` rows stay listed (dimmed); they're removed only when the session exits.
- **Attention queue** = agents in `blocked` or `need-to-check`.

## 3. Detection & engine — 100% hook-driven (no scraping, no process-sniffing)

The two scope cuts ("Claude-only" + "hooks via a plugin") delete the entire
fallback/inference subsystem from v1. There is **no Tier-B** (OSC-133 /
output-activity / process-tree) in v1; it's deferred to whenever generic agents
are added.

- Shepherd ships a **Claude Code plugin** whose `hooks/hooks.json` auto-loads
  from `~/.claude` — **no edits to the user's `settings.json`**; uninstall by
  deleting the plugin dir.
- When Shepherd spawns a tab's shell it injects two env vars into that PTY:
  - `SHEPHERD_SOCK` — path to Shepherd's unix socket
  - `SHEPHERD_TAB_ID` — a unique id for that tab
- The plugin's hook script reads `$SHEPHERD_TAB_ID` and `POST`s
  `{tab_id, event}` to `$SHEPHERD_SOCK`. **Correlation is by env var, not PID
  guessing** — robust because the env is per-PTY and inherited by `claude` and
  by every hook subprocess it spawns.
- **Deregistration backstop:** remove an agent on `SessionEnd` **OR** PTY
  child-exit. Relying on `SessionEnd` alone leaves a zombie `working` row if
  Claude crashes or is `Ctrl-C`'d. Shepherd owns the PTY, so it sees the child
  die regardless.
- **Agent ≠ tab.** Quitting `claude` drops the sidebar row but keeps the tab
  (now a plain shell). Relaunching `claude` in the same tab re-registers (new
  `SessionStart`, same `tab_id`).

## 4. UI

- **Sidebar row label** = the **OSC title Claude sets** (delivered via the
  libghostty *surface's* title-changed callback — a separate feed from the
  state socket). Until a title arrives, the row reads **"New session"**.
- **Ordering:** stable (insertion / tab order). The list does not reshuffle as
  states change — the keyboard primitive does the routing instead.
- **State display:** color/glyph per row; `idle` rows dimmed.
- **Navigation:** `⌘1`–`⌘9`, a dedicated **"jump to next agent needing
  attention"** key (cycles `blocked` / `need-to-check` only), and mouse click.
- **Notifications:** dock **badge** = count of agents wanting you (always
  updated). Native **alerts** on `working→blocked` and `working→need-to-check`,
  **suppressed when Shepherd is frontmost** (`!NSApp.isActive`), and not
  re-fired for an agent that's merely *staying* blocked.
- At a blocked agent you jump to the tab and answer in Claude's TUI normally —
  **no native approval/answer surface in v1.**

## 5. Build

- Fresh **SwiftUI app**; **libghostty is the engine** (PTY, VT parsing, grid,
  Metal rendering). A terminal pane = libghostty's **Metal surface** wrapped in
  an `NSViewRepresentable`, embedded in the SwiftUI layout. The terminal grid is
  **not** SwiftUI-drawn.
- libghostty comes in as the compiled **`GhosttyKit.xcframework`**; the embedding
  glue (surface creation + runtime callbacks) is **cribbed/adapted from
  Ghostty's MIT `SurfaceView`** rather than authored from `ghostty.h` cold.
- **Hardcoded sensible defaults** in v1 (one font, one theme, the keybindings
  above). No config file/UI.

## 6. Deferred (v1.x+)

Generic / non-Claude agents (+ the Tier-B PTY/OSC-133 inference ladder for
them) · navigator fuzzy-switcher popup · multiple windows · native approval
surface · config system / theming · sound.

> Splits **shipped** (panes-as-agents) — see
> [ADR 0012](.claude/adr/0012-pane-splitting-panes-as-agents.md) and §1.

> Workspaces **shipped** (Arc-style, nested model, global attention) — see
> [ADR 0013](.claude/adr/0013-workspaces.md).

### Big-ticket future: full remote control

Drive a Shepherd instance from another laptop **as if you were sitting at the
tab locally** — render its surfaces remotely, send input back, switch/observe
tabs and agent state. Hard requirements: **smooth, low-latency, and secure**
(transport over Tailscale / SSH / etc.). This is a post-polish feature — only
once the local app is solid. Open design questions for when we get there:
stream the terminal grid/PTY (server-authoritative, thin client) vs. mirror at
the libghostty layer; how the agent-state socket + sidebar project across the
link; auth + encryption model; and reconnect/latency-hiding behavior.

## 7. The live risk → the spike

Everything above assumes three seams work. The throwaway spike in [`spike/`](spike/)
proves them before any real building begins:

1. **Embedding** — one live libghostty surface (real shell, keystrokes, Metal
   render) inside *your* `NSWindow` + an adjacent SwiftUI sidebar. *Proves the
   API is embeddable by you, today.* (The unknown: current libghostty embed API
   maturity.)
2. **Correlation** — spawn the surface's shell with `SHEPHERD_TAB_ID` set; a
   script in that shell reads it and writes to the in-app socket; Shepherd logs
   the right tab. *Proves env-injection + socket + correlation.*
3. **Hook reality** — the throwaway Claude plugin's hooks fire and reach the
   socket tagged with the right `tab_id`, across a real `claude` run. *Proves
   the hook lifecycle.*

Seams **2 + 3 are runnable today without the GUI** (see `spike/README.md`).
Seam 1 needs Xcode + `GhosttyKit.xcframework` (see `spike/app-skeleton/SEAM1.md`).

## 8. Build order after a green spike

1. Tabs + spawning surfaces with env injection
2. Socket server + state store keyed by `tab_id`
3. The Claude plugin with the real event→state map
4. Sidebar rendering state + labels (OSC title feed)
5. Focus-clears-`need-to-check` + the "next attention" nav key
6. Dock badge + backgrounded alerts
