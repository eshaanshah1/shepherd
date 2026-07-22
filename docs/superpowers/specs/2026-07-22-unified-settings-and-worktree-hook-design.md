# Unified Settings window + per-workspace worktree hook

**Date:** 2026-07-22
**Status:** approved, pre-implementation
**Branch:** `add-worktree-create-hook`

## Problem

Shepherd's configuration is scattered and mostly invisible:

- **Appearance** (theme, font) lives only in `~/.config/shepherd/config`, hand-edited
  and reloaded with ⌘⇧R. No UI.
- **Remote sharing** (serve toggle, pairing, add host) lives in the sidebar `⋯`
  overflow menu.
- **Keybindings** are the hardcoded `ShortcutCatalog` with no view at all.
- **Workspace directory** is set from a folder right-click.
- **Stay Awake** is a top-level `CommandMenu` in the menu bar.

There is no single place to see or change how Shepherd behaves. Separately, there is
no way to run setup steps when a git worktree is created — copying an untracked
`.env`, symlinking a `.claude` folder, installing deps, etc. Today you do this by
hand in every new worktree.

This spec introduces a **unified Settings window** that surfaces the existing
surfaces in one place, and adds a genuinely new subsystem: a **per-workspace
worktree hook** — bash commands that run immediately after a worktree is created.

## Scope

**Fully functional this session:** the Settings window shell, the **Appearance**
tab (writes back to the config file + live reload), and the **Workspaces** tab
including the **worktree hook** (the star feature).

**Surfaced (not net-new logic):** the **Remote** tab mirrors the existing serve /
pairing / add-host controls; the **General** tab moves/mirrors Stay-Awake +
misc flags out of the menu bar.

**Marked TBD:** the **Keybindings** tab is a read-only render of `ShortcutCatalog`;
live rebinding is explicitly deferred (ShortcutCatalog is currently hardcoded and
rebinding is a whole subsystem).

**Explicitly deferred (YAGNI):** live keybinding rebinding; a full first-class
config store (Appearance still round-trips the ghostty-comment file — see ADR 0010
and the standing "proper config support" note); global / cross-workspace worktree
hooks (this spec is per-workspace only); worktree hooks on remote/mirror workspaces
(host-authoritative worktree creation already surfaces its errors on the host — a
v1 limitation carried forward).

## Presentation

A SwiftUI `Settings { SettingsView() }` scene is added to `ShepherdApp.body`. This
gives **⌘,** and a *Settings…* item under the app menu automatically, in a proper
separate window (idiomatic macOS, roomy, discoverable).

`SettingsView` is a `TabView` themed with `Theme` tokens, fixed size ~640×460, with
five tabs in order: **Appearance · Workspaces · Remote · Keybindings · General**.
Sidebar SwiftUI controls stay `.focusable(false)` per ADR 0009 where they could
otherwise steal focus (the Settings window is separate, so this is low-risk, but
follow the convention).

## Components

### 1. `SettingsView.swift` (new)
The `TabView` container plus one small subview per tab. Reads/writes through the
store (`@EnvironmentObject AgentStore` — the Settings scene injects
`AgentStore.shared`) and through `ShepherdConfigWriter` for file-backed keys.

### 2. `ShepherdConfigWriter.swift` (new)
Surgically updates specific keys in `~/.config/shepherd/config` while preserving
every other line, comment, and ordering.

- **Pure core:** `apply(contents: String, sets: [ConfigEdit]) -> String`, where a
  `ConfigEdit` names a key, its kind (native ghostty key like `font-family` /
  `font-size`, or a `# shepherd:`-comment key like `theme`), and the new value.
  - Updating an existing key rewrites that line in place.
  - A missing native key is appended as `key = value`.
  - A missing shepherd key is appended as `# shepherd: key = value`.
  - Unrelated lines, blank lines, and comments are preserved verbatim.
- **Shell:** `read()` / `write(_:)` file IO + a `set(_ edits:)` that reads, applies,
  writes, then calls `GhosttyApp.shared.reloadConfig()`. Creates the file/dir if
  absent.

This is the "round-trip write to the ghostty-comment format" and is the only new
config-persistence infra. It must not clobber a hand-written config.

### 3. Appearance tab
- **Theme** picker: dark / light / warm → `theme` (shepherd-comment key).
- **Font family** text field → `font-family` (native ghostty key).
- **Font size** stepper → `font-size` (native ghostty key).
- Current values read from the parsed config on appear.
- On any change: `ShepherdConfigWriter.set(...)` → `reloadConfig()` (live; agents
  survive per the reload-config design). Known gap carried forward: the chrome's own
  mono font is cached until relaunch (ADR 0010).

### 4. Workspaces tab
- A workspace picker (defaults to the selected workspace).
- **Default directory** field (mirrors the folder-right-click "Set Directory…";
  writes `Workspace.defaultPath` via a store setter). Local workspaces only; on a
  remote/mirror workspace this shows the host-side path text as today.
- **Worktree hook** multiline bash editor (monospace `TextEditor`), with a short
  helper line listing the available env vars. Persists to
  `Workspace.worktreeHook: String?`.

### 5. `WorktreeHookRunner.swift` (new)
- **Pure core:** `hookEnvironment(worktreeDir:src:branch:name:repoName:) ->
  [String: String]` — maps to `WORKTREE_DIR`, `WORKTREE_SRC`, `WORKTREE_BRANCH`,
  `WORKTREE_NAME`, `REPO_NAME`. Unit-tested.
- **Shell:** `run(script:cwd:env:) -> (exitCode: Int32, output: String)` — runs
  `bash -c "<script>"` (login-ish env inherited + the hook vars overlaid), `cwd` =
  the new worktree dir, capturing merged stdout+stderr. Runs off-main (called from
  the existing background block).

### 6. Remote tab (surfaced)
Mirrors the `⋯` overflow menu: Serve toggle (`store` serve binding), *Add remote
host…* (`store.showingRemoteDevices`), pairing code while serving, and a list of
known/paired devices from the existing remote state. No new remote logic.

### 7. Keybindings tab (TBD)
Read-only two-column reference built from `ShortcutCatalog.all`, grouped by
`ShortcutCategory` — same data the ⌘/ cheatsheet renders. Header note: "Rebinding
coming soon." No editing.

### 8. General tab ("anything else")
- **Stay Awake** mode picker (off / while-agents / always) + "Sleep if running hot
  under closed lid" toggle — same bindings as the menu-bar `CommandMenu`
  (`SleepGuard.shared`). The menu-bar command may stay or be thinned; the Settings
  control is authoritative UI going forward.
- **Worktree base** path (the `worktree-base` shepherd key) — display + edit via
  `ShepherdConfigWriter`.
- **Panes default collapsed** toggle (`shepherd.panes.defaultCollapsed`
  UserDefaults flag).
- **Open config file** button (reveals/opens `~/.config/shepherd/config`).

## Data flow — worktree hook

```
newWorktreeTab(inWorkspace:name:)                 [main]
  → addProvisioningTab (tab opens, provisioning=true)
  → DispatchQueue.global:                          [off-main]
        Git.addWorktree(...) → ok
        if ws.worktreeHook non-empty:
            env = WorktreeHookRunner.hookEnvironment(dir: dest, src: repoDir,
                     branch: name, name: name, repoName: <basename repoDir>)
            (exit, out) = WorktreeHookRunner.run(script: hook, cwd: dest, env: env)
        DispatchQueue.main:                          [main]
            finishProvisioning(paneID)               // always — worktree is kept
            if hook ran and exit != 0:
                showWorktreeError("Worktree hook reported an error",
                                  detail: <trailing lines of `out`>)   // non-fatal
```

The git-failure path (remove tab + alert) is unchanged. The hook only runs on git
success and never tears the worktree down — "warn but keep."

## Persistence

`Workspace` gains `worktreeHook: String?` and `PersistedWorkspace` gains a matching
optional field (optional on disk ⇒ existing `shepherd.workspaces.v1` blobs decode
with `nil`). Wired through `snapshotState` and `buildWorkspaces` in
`Persistence.swift`. No store-key bump; no migration needed. `defaultPath` handling
is unchanged (already persisted).

## Error handling

- **Config write failure** (permissions, IO): surface an `NSAlert`; do not reload.
- **Hook non-zero exit:** non-fatal `NSAlert` with the tail of captured output;
  worktree kept, provisioning finished.
- **Empty / whitespace-only hook:** skipped entirely (no subprocess).
- **Malformed config on read:** `apply` operates line-wise and preserves unknown
  content, so a weird file degrades to "append the key" rather than corrupting.

## Testing

Pure-model coverage in the existing `ShepherdModelTests` target (add the two new
compiled sources to `project.yml`'s `sources:` list, then `xcodegen generate`):

- `ShepherdConfigWriterTests` — insert a new native key; insert a new shepherd
  key (as a `# shepherd:` line); update an existing native key in place; update an
  existing shepherd key in place; preserve unrelated lines/comments/order/blank
  lines; idempotent re-apply.
- `WorktreeHookRunnerTests` — `hookEnvironment` maps all five vars correctly,
  including a repo name derived from a trailing-slash path.

Verification: `cd spike/seam1 && xcodegen generate && xcodebuild ... build` and run
the `ShepherdModelTests` target. No app relaunch (per the "don't kill Shepherd while
live" rule — runtime checks deferred to the user).

## Files

**New:** `spike/seam1/Sources/SettingsView.swift`,
`spike/seam1/Sources/ShepherdConfigWriter.swift`,
`spike/seam1/Sources/WorktreeHookRunner.swift`,
`spike/seam1/Tests/ShepherdConfigWriterTests.swift`,
`spike/seam1/Tests/WorktreeHookRunnerTests.swift`.

**Edit:** `spike/seam1/Sources/ShepherdApp.swift` (Settings scene),
`spike/seam1/Sources/Workspace.swift` (`worktreeHook`),
`spike/seam1/Sources/Persistence.swift` (persist `worktreeHook`),
`spike/seam1/Sources/AgentStore.swift` (run hook in `newWorktreeTab`; setters for
`worktreeHook` / `defaultPath`), `spike/seam1/project.yml` (new sources + test
sources).

## Open items resolved during brainstorming

- Hook scope: **per-workspace only** (no global default).
- Hook failure: **warn but keep the worktree**.
- Appearance apply: **write back to config file + live reload**.
- Presentation: **native Settings window (⌘,)**.
- Env var names: **unprefixed** (`WORKTREE_SRC`, …) to match the user's phrasing.
