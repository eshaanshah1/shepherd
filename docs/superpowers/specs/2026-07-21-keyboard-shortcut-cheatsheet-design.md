# Shepherd keyboard-shortcut cheatsheet — design

**Date:** 2026-07-21
**Status:** approved (design), pending implementation

---

## Goal

A **⌘/** HUD overlay that shows every Shepherd keyboard shortcut, grouped by
category — a reference card so you never have to grep `ShepherdApp.swift` or the
CLAUDE.md table to remember "how do I jump to the next tab that needs me" (it's
⌘⇧A). Dismissed by Esc, click-outside, or ⌘/ again. The terminal + agents keep
running underneath.

## Why this needs real work (single source of truth)

The naive version is a hand-curated list of shortcuts living next to the real
`.keyboardShortcut(...)` declarations — a guaranteed drift risk. SwiftUI's
`.commands` / `CommandGroup` gives **no runtime-queryable registry**: the
shortcuts are baked into view builders, invisible to code, so the cheatsheet
cannot reflect over the existing menu.

The fix inverts the current structure: declare the commands as **data**, then
generate *both* the menu and the cheatsheet from that one array. Adding or
changing a shortcut happens in exactly one place; the two can't drift.

## Components

### 1. `ShortcutCatalog.swift` (new, pure model)

An AppKit-free source of truth. No SwiftUI view code — so it compiles into
`ShepherdModelTests`.

```swift
enum ShortcutCategory: String, CaseIterable {
    case tabsPanes    = "Tabs & Panes"
    case focusNav     = "Focus & Navigation"
    case workspaces   = "Workspaces"
    case tools        = "Tools"
    case attention    = "Attention"
    case config       = "Config"
}

struct ShortcutCommand: Identifiable {
    let id = UUID()
    let title: String
    let key: KeyEquivalent?         // nil ⇒ display-only (no menu button generated)
    let modifiers: EventModifiers
    let category: ShortcutCategory
    let action: (() -> Void)?       // nil for display-only family rows
    let display: String             // rendered keycap, e.g. "⌘⇧A" (precomputed)
}
```

The menu is generated only from commands with a non-nil `key`/`action`
(`ShortcutCatalog.menuCommands`); the cheatsheet renders **all** of `.all`,
including the display-only family rows below.

- `KeyEquivalent` / `EventModifiers` come from SwiftUI, which is header-only and
  fine in the model target (no AppKit dependency). If the test target balks at
  the `action` closure or SwiftUI import, fall back to storing `key`/`modifiers`
  as plain data and building the `display` string from them — the catalog test
  only needs the string fields.
- `static let all: [ShortcutCommand]` — every simple command, in category order.
- The `display` string is authored alongside each command (⌘, ⇧, ⌥, ⌃, ↩, arrows)
  rather than derived, to keep glyph mapping trivial and reviewable.

**Catalog contents** (mirrors today's `ShepherdApp.swift`):

| display | title | category |
|---|---|---|
| ⌘T | New Tab | Tabs & Panes |
| ⌘W | Close Pane | Tabs & Panes |
| ⌘D | Split Right | Tabs & Panes |
| ⌘⇧D | Split Down | Tabs & Panes |
| ⌘⇧↩ | Zoom Pane | Tabs & Panes |
| ⌘⌥← / → / ↑ / ↓ | Focus Pane (directional) | Focus & Navigation |
| ⌘⇧[ / ⌘⇧] | Previous / Next Tab | Focus & Navigation |
| ⌘1–9 | Jump to Tab N | Focus & Navigation |
| ⌘⇧N | New Workspace | Workspaces |
| ⌃⇥ / ⌃⇧⇥ | Next / Previous Workspace | Workspaces |
| ⌘F | Find | Tools |
| ⌘G | Review Diff | Tools |
| ⌘O | Open Editor | Tools |
| ⌘S | Save File | Tools |
| ⌘⇧A | Jump to Next Alert | Attention |
| ⌘⇧R | Reload Config | Config |
| ⌘/ | Keyboard Shortcuts (this panel) | Config |

Rows that don't fit the simple `title + single key + action` mold are represented
as **display-only catalog entries** (`key`/`action` nil, so no live
`.keyboardShortcut` is generated from them — their real bindings stay
hand-written in `.commands`):
- **⌘1–9 / ⌘⌥-arrows** — families rendered as one combined row each; the real
  buttons stay their existing `ForEach`.
- **⌃⇥ / ⌃⇧⇥** — `.tab` with control; keep as catalog rows, real buttons stay inline.

Excluded entirely (not shortcuts): the **Stay Awake** picker and the **DEBUG**
thermal items.

### 2. `ShepherdApp.swift` — generate the menu from the catalog

The block of individual `Button(...).keyboardShortcut(...)` calls that have a
1:1 catalog entry become a `ForEach` over the catalog's simple commands, emitting
`Button(cmd.title) { cmd.action() }.keyboardShortcut(cmd.key, modifiers: cmd.modifiers)`,
with `Divider()`s inserted on category boundaries. The special cases (⌘1–9
`ForEach`, Stay Awake menu, DEBUG block, directional-focus/tab family if they
stay inline) remain as-is. The new **⌘/** command toggles
`AgentStore.shared.showShortcuts`.

Also add a **Help-menu** entry via `CommandGroup(replacing: .help)` — a
"Keyboard Shortcuts" button (same action, ⌘/) — for menu-bar discoverability.

### 3. `AgentStore.swift` — overlay state

`@Published var showShortcuts = false` — transient (not persisted, like zoom).

### 4. `ShortcutCheatsheetView.swift` (new, SwiftUI)

A centered rounded card over a dimmed backdrop, styled entirely from
`Theme.swift` tokens (near-black panel, soft dividers, mono keycaps in
`Theme.monoFontName`). Two-column grid of `ShortcutCategory` sections; each row is
`display` (a small keycap capsule) + `title`. Footer: "Esc to close · ⌘/ to toggle".
Built by iterating `ShortcutCatalog.all` grouped by `category` — no shortcut is
listed by hand here.

### 5. `ContentView.swift` — mount the overlay

Add to the top-level `ZStack`, gated on `store.showShortcuts`:
- a full-bleed backdrop `Button` (`.plain`, dark translucent fill) that sets
  `showShortcuts = false` on click,
- the `ShortcutCheatsheetView` centered on top,
- an invisible `Button {} .keyboardShortcut(.cancelAction)` (Esc) that dismisses.

⌘/ toggles it back off via the menu command. Because the overlay adds no
persistent first responder, the terminal reclaims focus on dismiss (existing
selection-drives-first-responder logic in `GhosttyTerminal`). Keep all controls
`.focusable(false)` per ADR 0009 so focus never leaves the terminal while open.

## Testing

`ShortcutCatalogTests.swift` in `ShepherdModelTests` (add the new source to the
target's `sources:` list in `project.yml`):
- every command has a non-empty `title` and `display`,
- no duplicate `display` strings within the simple-command set,
- every `ShortcutCategory` that appears is covered / ordering is stable.

Overlay rendering is pure SwiftUI chrome — verified by build + the user's runtime
check, not unit tests (consistent with the rest of the app's UI).

## Non-goals (YAGNI)

- No search/filter box.
- No per-key rebinding / user-configurable shortcuts.
- No sourcing from `~/.config/shepherd`.
- Just a static, always-current reference card.

## Files touched

- `spike/seam1/Sources/ShortcutCatalog.swift` (new, pure model)
- `spike/seam1/Sources/ShortcutCheatsheetView.swift` (new, SwiftUI)
- `spike/seam1/Sources/ShepherdApp.swift` (catalog-driven menu + ⌘/ + Help item)
- `spike/seam1/Sources/AgentStore.swift` (`showShortcuts` flag)
- `spike/seam1/Sources/ContentView.swift` (overlay mount)
- `spike/seam1/Tests/ShortcutCatalogTests.swift` (new)
- `spike/seam1/project.yml` (register the two new sources; Tests glob picks up the test)
