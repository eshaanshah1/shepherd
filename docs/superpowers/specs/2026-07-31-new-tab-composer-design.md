# New-tab composer (⌘T)

**Date:** 2026-07-31
**Status:** designed, not built

## Problem

`⌘T` makes an empty shell tab in the current workspace and nothing else. Everything
you actually want at that moment — a name, a different workspace, a worktree, and an
agent already working on something — is a separate gesture afterwards, and two of them
(worktree, prompt) are reachable only through a sidebar menu or by typing `claude` and
waiting. The one moment where you know what the tab is *for* is the moment Shepherd
asks the least.

## What ⌘T becomes

A centered composer card over a dimmed backdrop — a self-drawn `Theme` card in the
`NewWorkspaceModal` idiom (no native sheet or alert), presented from `ContentView` on a
new `store.promptingNewTab` flag.

```
╭───────────────────────────────────────────────────────╮
│  Untitled tab                        ⌂ shepherd  ⌄    │
├───────────────────────────────────────────────────────┤
│                                                       │
│   Ask Claude to do something…                         │
│   (leave empty for a plain shell)                     │
│                                                       │
├───────────────────────────────────────────────────────┤
│  ⑂  Worktree  ( ●)  fix-auth            ╭─────────╮   │
│                                         │Create ⏎ │   │
╰─────────────────────────────────────────┴─────────┴───╯
```

The prompt owns the card; everything else is chrome around it. This is a composer, not
a form — the shape is deliberate, and a stack of labelled fields is the thing it is not.

| Control | Default | Notes |
|---|---|---|
| Title (top-left, borderless) | empty | Autofocused. Empty ⇒ the pane names itself as it does today (agent OSC title, else cwd) — except with worktree on, where `newWorktreeTab` already titles the pane after the branch. A non-empty title wins over the branch. |
| Workspace (top-right chip) | current workspace | Menu of every workspace. Changing it re-evaluates worktree and prompt availability. |
| Prompt (body) | empty | Empty ⇒ a plain shell tab, byte-identical to today's `⌘T`. |
| Worktree toggle (footer-left) | off, or on per config | `# shepherd: new-tab-worktree = true` flips the default. |
| Branch name (beside the toggle) | slug of the title | Mirrors the title until edited, then detaches. |
| Create (footer-right) | — | Disabled only when worktree is on and the branch is empty. |

**Keys:** `⏎` create · `⇧⏎` newline inside the prompt · `⎋` or a backdrop click cancel.

**The fast path is preserved by construction.** `⌘T` `⏎` with every field at its default
creates exactly the tab `⌘T` creates today, so muscle memory costs one extra keystroke
and no second shortcut has to exist.

**Nothing is sticky.** Every open starts from defaults — empty title, empty prompt,
current workspace, worktree at its config value. `⌘T` `⏎` has to mean the same thing
every time or the fast path is a lie.

## Components

| File | Kind | Role |
|---|---|---|
| `NewTabRequest.swift` | **pure** | The form's value and every rule about it: slugging, the mirror-until-edited rule, `canCreate`, worktree availability, prompt availability. |
| `AgentLaunch.swift` | pure + Foundation IO | `command(promptFile:)` builds the launch line; `prepare(prompt:)` writes the temp file and returns its path. |
| `NewTabComposer.swift` | SwiftUI | The card. Holds no policy — every enable/disable/derived string reads `NewTabRequest`. |
| `AgentStore` | changed | `@Published var promptingNewTab: Bool`; `create(_ request: NewTabRequest)` routes to the worktree or plain path. |
| `Pane` (`SplitTree.swift`) | changed | `+ var initialCommand: String?` — **transient, never persisted**, same class as `provisioning` / `stowing`. |
| `takeResumeInput` → `takeInitialInput` | changed | One seam returning either the `claude --resume` line or the launch command. `GhosttyTerminal` calls one function; its call site is otherwise untouched. |
| `parseShepherdConfig` (`WorktreeService.swift`) | changed | Reads `new-tab-worktree`. |

`NewTabComposer` is a view and only a view. If a question of the form "is this allowed
/ what does this resolve to" is being answered inside `body`, it belongs in
`NewTabRequest`, where a test can reach it.

## How the prompt reaches the agent

A typed newline is an Enter press (`injectText` writes through `ghostty_surface_key`),
so a multi-line prompt cannot be typed — it would submit its first line and scatter the
rest. The prompt is therefore never typed. It is written to a file and read back by the
shell:

```
p=$(cat '<FILE>'); rm -f '<FILE>'; claude "$p"
```

- **One typed line**, so no newline in the prompt is ever an Enter press.
- **`"$p"` is quoted**, so newlines, quotes and `$` survive byte-for-byte into `claude`'s
  argv. Command substitution strips *trailing* newlines only, which is harmless.
- **`FILE` is a UUID under `AppMode.supportPath("prompts")`** — a path Shepherd owns, so
  the single-quoting in that line is never wrapped around user input.
- **`rm -f` runs before `claude`**, so nothing is left behind even if the session is long
  or the app dies.
- Works identically in bash and zsh, which is what a user's login shell will be.

An empty prompt produces **no `initialCommand` at all** — a plain shell, not `claude`
with an empty argument.

**The worktree case composes for free.** `newWorktreeTab` opens a provisioning pane whose
terminal does not mount until `git worktree add` (and the workspace's worktree hook) has
finished; `takeInitialInput` is read on mount. So the command is typed inside the real
worktree, after provisioning, with no new ordering machinery.

## Entry points

The composer replaces every *human* gesture that makes a tab:

- `⌘T` — `ShortcutActions` sets `promptingNewTab` instead of calling `newTab()`.
- The sidebar folder's hover-`+` — opens the composer preset to **that** workspace. It
  stops being a two-item `Menu` and becomes a plain button again; the separate
  *New Worktree Tab…* item is deleted, because it is now the toggle.
- `WorkspaceEmptyView`'s **New Tab** / **New Worktree Tab…** buttons — collapse into one
  button that opens the composer.

The control CLI's `tab new` is **untouched** and keeps creating tabs directly: a script
cannot fill in a dialog, and `shepherd tab new --cwd …` composed with `tell` already
covers the scripted case.

## Unavailable states

Each is shown, disabled, with the reason in place — never hidden. A control you cannot
see teaches nothing.

| Condition | Effect |
|---|---|
| Target workspace has no git default directory | Worktree row greyed, hint: *set a directory for this workspace*. |
| Worktree on, branch empty | Create disabled, hint: *name the worktree*. |
| Target workspace is a remote mirror | Prompt area greyed, hint: *prompts run on the host — not yet supported*. Title and worktree still forward via `cmdNewTab` / `cmdNewWorktreeTab` as they do today. |

## Data flow

```
⌘T / folder + / empty-view button
  → store.promptingNewTab = true
  → NewTabComposer edits a NewTabRequest
  → Create → store.create(request)
       ├── request.prompt non-empty → AgentLaunch.prepare(prompt:) → command string
       ├── worktree on  → newWorktreeTab(inWorkspace:name:initialCommand:)
       │                    → provisioning pane → git → mount → takeInitialInput
       └── worktree off → newTab(inWorkspace:cwd:initialCommand:)
                            → mount → takeInitialInput
```

## Testing

Pure-model coverage in `ShepherdModelTests`:

- **`NewTabRequestTests`** — branch slugging (spaces, uppercase, characters `git
  check-ref-format` rejects); the mirror rule and its one-way detach; the `canCreate`
  matrix; worktree availability against a workspace with no default path, with a
  non-repo path, and with a repo; prompt availability against a local vs mirror
  workspace.
- **`AgentLaunchTests`** — the command round-trips a prompt containing newlines, single
  and double quotes, `$VAR`, and backticks; an empty prompt yields no command.

Both files need `xcodegen generate` and an entry in the target's explicit `sources:`
list before their first run — an unknown suite reports `** TEST SUCCEEDED **`
vacuously, so a pass only counts once the test count moves.

## Deferred

- A Settings → Workspaces toggle for the worktree default (config key only for now).
- Prompts on mirror workspaces (needs a prompt field on `cmdNewTab`).
- A model / agent picker chip, attachments, and a "create more" toggle — the reference
  composer has them; we have one agent and one tab per create.
