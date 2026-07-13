# Workspace default directory + git worktree tabs

**Date:** 2026-07-13
**Status:** approved (design)
**Branch:** `workspace-default-path-worktrees`

## Problem

Some workspaces are anchored to a single project directory. Today every new tab
opens in the shell's default cwd (home), so the user re-`cd`s into their repo for
every tab. And when that directory is a git repo, spinning up an isolated agent
on a fresh branch means a manual `git worktree add` in a scratch location.

This feature lets a workspace carry a **default directory**: all new tabs in that
workspace open there. When the directory is a git work tree, the workspace also
offers **"New Worktree Tab…"** — it creates a git worktree under a predictable
path and opens a tab already sitting in it.

## Decisions (settled during brainstorming)

- **Set path:** per-workspace, stored in the model + persistence, set from the
  sidebar folder right-click menu (native folder picker). Not config-driven.
- **Worktree entry point:** the folder-header hover-`+` becomes a small menu
  (*New Tab* / *New Worktree Tab…*). The worktree item is shown only when the
  workspace's default directory is a git work tree.
- **Worktree naming:** prompt for a name. If a branch of that name already exists,
  check it out in the new worktree; otherwise create it (`-b`).
- **Worktree path layout:** `<base>/<repo-folder-name>/<worktree-name>`, where
  `<repo-folder-name>` is the **basename** of the repo directory and `<base>`
  defaults to `~/.shepherd/worktrees`, overridable in the config.

## Non-goals

- No retroactive move of existing tabs/panes when a default is set — **new tabs
  only**.
- No worktree lifecycle management (list / prune / delete) in this slice — we only
  *create* a worktree and open a tab in it. Removing the worktree is left to the
  user / git.
- No change to split behavior — a split still inherits its parent pane's cwd.

## Design

### 1. Data model & persistence

Add one field to the pure `Workspace` model:

```swift
var defaultPath: String?   // nil = no default (today's behavior); tilde-allowed as stored
```

Thread it through persistence as an **optional** field so existing
`shepherd.workspaces.v1` blobs still decode (absent ⇒ nil):

- `PersistedWorkspace` gains `var defaultPath: String?`.
- `snapshotState` copies `ws.defaultPath` in.
- `buildWorkspaces` restores it onto the rebuilt `Workspace`.

No persistence version bump and no migration — an optional Codable field is
backward-compatible with old blobs, matching how `collapsed` was added.

`Workspace.init` gains a `defaultPath: String? = nil` parameter (defaulted, so all
existing call sites compile unchanged).

### 2. Plain new tabs honor the default path

`AgentStore.newTab()` and `newTab(inWorkspace:)` seed the fresh pane's cwd from the
owning workspace's `defaultPath` (tilde-expanded) before appending the tab:

```swift
var pane = Pane()
pane.cwd = expandedDefaultPath(forWorkspace: w)   // nil-safe: leaves cwd nil when unset
let tab = Tab(pane: pane)
```

Surface creation already reads `AgentStore.cwd(forPane:)` → `cfg.working_directory`
(`GhosttyTerminal.makeSurface`), so the PTY opens in that directory with **no
terminal-layer changes**. If the stored path no longer exists, libghostty falls
back to the shell default — acceptable, no special-casing.

Splitting is unchanged: `splitFocused` keeps copying the parent pane's live cwd.

### 3. Setting / clearing the directory (UI)

The workspace folder's right-click menu (today: rename / collapse / delete in
`SidebarView.WorkspaceFolderHeader`) gains:

- **Set Directory…** → native `NSOpenPanel` with `canChooseDirectories = true`,
  `canChooseFiles = false`. Chosen path → `store.setWorkspaceDirectory(id, to:)`.
- **Clear Directory** → shown only when a default is set; sets it back to nil.

New store ops:

```swift
func setWorkspaceDirectory(_ id: String, to path: String?)  // trims, nil-if-empty, save()
```

No custom sheet — the open panel *is* the picker.

### 4. Worktree tab (hover-`+` menu)

The folder-header hover-`+` (today a plain button calling `newTab(inWorkspace:)`)
becomes a `Menu`:

- **New Tab** → `newTab(inWorkspace:)` (unchanged behavior).
- **New Worktree Tab…** → present only when the workspace's default directory is a
  git work tree. Git-repo detection runs when the menu is built (user-initiated
  click, so a single synchronous `git -C <dir> rev-parse --is-inside-work-tree` is
  acceptable); returns false when `defaultPath` is nil.

Selecting **New Worktree Tab…** opens a lightweight name sheet (reusing the
existing rename-modal pattern) driven by a new store field
`@Published var promptingWorktree: (workspaceID: String, ...)?`. On submit with a
non-empty name:

1. Resolve `repoDir` = the workspace's expanded `defaultPath`.
2. Compute `dest = worktreePath(base:repoDir:name:)` (see §6).
3. Decide branch mode: `git -C <repoDir> show-ref --verify --quiet refs/heads/<name>`
   → exists ⇒ reuse, else create.
4. Run (off-main, via `Process`):
   - reuse: `git -C <repoDir> worktree add <dest> <name>`
   - create: `git -C <repoDir> worktree add <dest> -b <name>`
5. On exit 0: back on main, open a new tab in that workspace with `cwd = dest`
   (same path as `newTab(inWorkspace:)` but with an explicit cwd override).
6. On non-zero exit: surface git's stderr in an `NSAlert` (e.g. dir already
   exists, dirty index, invalid ref name). No tab is opened.

Git branch-name validity is left to git — we pass the trimmed name through and
report git's own error rather than pre-validating.

### 5. Config override

The worktree base directory (`~/.shepherd/worktrees` by default) is overridable in
Shepherd's existing config file, `~/.config/shepherd/config`. That file is parsed
by libghostty (ghostty syntax), which would flag an unknown `worktree-base` key —
so Shepherd reads its own keys from a **ghostty comment line** that libghostty
ignores:

```
# shepherd: worktree-base = ~/code/worktrees
```

A pure parser scans for `# shepherd: <key> = <value>` lines:

```swift
struct ShepherdConfig { var worktreeBase: String? }
func parseShepherdConfig(_ contents: String) -> ShepherdConfig
```

This keeps the file valid ghostty syntax (no config-error noise) while honoring
"the config" as a single file. `worktreeBase` is tilde-expanded at use; when
absent, the default `~/.shepherd/worktrees` applies. Read once at the point of
worktree creation (cheap; no need to cache).

### 6. `WorktreeService.swift` (new file)

Splits the pure, testable core from the shell:

- **Pure (unit-tested):**
  - `func worktreePath(base: String, repoDir: String, name: String) -> String`
    → `<base>/<lastPathComponent(repoDir)>/<name>`.
  - `parseShepherdConfig(_:)` from §5.
- **Shell (thin, not unit-tested):** the `Process`-based `git` invocations
  (`isGitWorkTree`, `branchExists`, `addWorktree`) returning stdout/stderr/exit.

The `AgentStore` worktree flow is the AppKit shell around these — mirroring how
`StopPolicy`/`SleepPolicy` keep the decision pure and the store does the effects.

### 7. Testing

`ShepherdModelTests` (pure-model target) gains:

- **PersistenceTests:** `defaultPath` round-trips through
  `snapshotState`/`buildWorkspaces`; an old blob **without** `defaultPath` still
  decodes (→ nil).
- **WorktreeServiceTests (new):** `worktreePath` layout, including a repo dir with
  a trailing slash and a tilde in the base; `parseShepherdConfig` — present key,
  absent key, comment with extra spacing, and a plain ghostty line (ignored).

No AppKit in tests, per the repo's model/shell test boundary. New compiled source
(`WorktreeService.swift`) must be added to both the app target and the test
target's explicit `sources:` list in `project.yml`, then `xcodegen generate`.

## Files touched

- `Workspace.swift` — `defaultPath` field + init param.
- `Persistence.swift` — `PersistedWorkspace.defaultPath` + snapshot/build.
- `AgentStore.swift` — `setWorkspaceDirectory`, default-cwd in `newTab*`,
  `promptingWorktree` state + the worktree-creation flow, config read.
- `SidebarView.swift` — folder menu items (Set/Clear Directory), hover-`+` → menu
  with the worktree item.
- `ContentView.swift` — the worktree-name sheet (reusing the rename-modal pattern).
- `WorktreeService.swift` — **new**, pure path/config + git shell.
- `Tests/PersistenceTests.swift`, `Tests/WorktreeServiceTests.swift` (**new**).
- `project.yml` — add `WorktreeService.swift` to app + test targets; `xcodegen generate`.
- `CLAUDE.md` — note the workspace `defaultPath`, the worktree flow, and the
  `# shepherd:` config-comment convention.

## Risks / open questions

- **`# shepherd:` comment convention** is the one non-obvious choice; it exists so
  a `worktree-base` key can live in the libghostty-parsed config without a config
  warning. Alternative (rejected for now): a separate `~/.config/shepherd/shepherd.conf`.
- Worktree names containing `/` (e.g. `feature/foo`) nest under the repo folder;
  `git worktree add` creates intermediate dirs. If it fails, git's error is
  surfaced — no pre-validation.
- Git-repo detection on menu-open is synchronous; acceptable because it's a
  click-driven single `rev-parse`. If it ever hitches, cache per workspace on
  directory-set.
