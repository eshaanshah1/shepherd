# Shepherd live config reload — design

**Date:** 2026-07-16
**Status:** approved (design), pending implementation
**Depends on:** the light-theme work (`feat/light-theme`) — `Theme.mode` + `pick`/`pickHex`.

---

## Goal

A **Reload Config** command (⌘⇧R + menu item) that re-reads
`~/.config/shepherd/config` and propagates changes to the running app **without a
rebuild or relaunch**, keeping every terminal/agent alive. Motivating case:
flip `# shepherd: theme = light|dark` and see it apply instantly.

Since the config is rebuilt anyway, the terminal grid picks up **all** ghostty
keys (theme colors, `font-family`, etc.) live — not just theme.

## Why this needs real work

The config is currently resolved **once and frozen**:
- `Theme.mode` and every token are `static let` — computed on first access, then
  fixed for the process.
- `writeBaseTheme()` writes a temp file loaded into the ghostty config at
  `GhosttyApp.init`; surfaces bake it in at creation.

libghostty *does* support live reload — `ghostty_app_update_config` and
`ghostty_surface_update_config` (both in the vendored header) — so the grid can
repaint. The chrome needs its theme state made re-resolvable and a re-render
trigger.

## Components

### 1. `Theme.swift` — make the palette re-resolvable
- `static let mode` → `static var mode`, plus `static func reloadMode()` that
  re-reads the config file (same read as today) and reassigns `mode`.
- Convert every token from `static let` to a computed `static var` returning the
  same `pick(...)` / `pickHex(...)` expression (and `divider` to computed). Call
  sites are unchanged (`Theme.ground` still works); each read now re-resolves
  against the current `mode` — cheap (`Color(hex:)`).
- `Theme.Code.*` become computed `static var` too, so the diff/editor palette
  follows on the next re-render of those surfaces.

### 2. `Ghostty.swift` — rebuild + push config to app and every surface
- Extract the init config-build block into
  `private static func buildConfig() -> ghostty_config_t?`
  (`config_new` → load base theme (via `writeBaseTheme()`, now mode-aware) →
  load `~/.config/shepherd/config` → `finalize`). `init` calls it.
- Add a **weak surface registry**: `GhosttyApp` holds
  `NSHashTable<GhosttySurfaceView>.weakObjects()` with `register`/`unregister`.
- Add `func reloadConfig()` (main thread):
  1. `Theme.reloadMode()`
  2. `guard let cfg = Self.buildConfig()`
  3. `ghostty_app_update_config(app, cfg)`
  4. for each live registered surface view → `view.updateConfig(cfg)`
     (new internal method calling `ghostty_surface_update_config` on its surface)
  5. `ghostty_config_free(cfg)`
  6. `AgentStore.shared.bumpTheme()` (re-render the chrome)

### 3. `GhosttyTerminal.swift` — register + expose per-surface update
- On surface creation, `GhosttyApp.shared.register(self)`; in `deinit`,
  `unregister(self)`.
- `func updateConfig(_ cfg: ghostty_config_t)` → guards a live `surface` and
  calls `ghostty_surface_update_config`.

### 4. `AgentStore.swift` — chrome re-render trigger
- Add `@Published private(set) var themeVersion = 0` and
  `func bumpTheme() { themeVersion += 1 }`. `ContentView`/`SidebarView` already
  observe the store via `@EnvironmentObject`, so any `@Published` change
  re-renders them and their subtrees, which re-read the now-updated `Theme`
  tokens. Terminals are `NSViewRepresentable` → they get `updateNSView`, **not**
  a remount, so PTYs/agents survive.

### 5. `ShepherdApp.swift` — the command
- Add a **Reload Config** menu command, `⌘⇧R`, calling
  `GhosttyApp.shared.reloadConfig()` (main thread — menu commands already run
  there). Free key: no clash with `⌘⇧A/D/N`, `⌃⇥`.

## Data flow

```
⌘⇧R / menu
  → GhosttyApp.shared.reloadConfig()      (main thread)
      → Theme.reloadMode()                (re-read config → Theme.mode)
      → buildConfig()                     (fresh ghostty_config_t, mode-aware base theme)
      → ghostty_app_update_config(app, cfg)
      → each surface view.updateConfig(cfg)   (grid repaints, PTY alive)
      → ghostty_config_free(cfg)
      → AgentStore.bumpTheme()            (@Published → chrome re-renders → re-reads Theme)
```

## Testing / verification
- Pure layer is unchanged (`parseShepherdConfig` already covered). The reload
  path is AppKit/libghostty integration — **verified live**: flip the `theme`
  key, hit ⌘⇧R, confirm chrome + grid recolor and terminals/agents keep running.
- Build + existing model suite must stay green.

## Non-goals / known gaps (v1)
- **Chrome mono font** (`Theme.monoFontName`, a `static let`) stays cached — a
  `font-family` change restyles the *terminal grid* live but not the SwiftUI
  chrome until relaunch. Minor; can be made re-resolvable later.
- An already-open diff/editor surface may need to be reopened to pick up new
  `Theme.Code` colors (it re-reads on re-render).
- No file-watching / auto-reload — explicit command only.
- Reliability of the chrome re-render cascade across *all* colored views is the
  main live-test risk; if a view doesn't repaint, it's because it neither
  observes the store nor sits under a re-rendered parent — fix by having it
  depend on `themeVersion`.
