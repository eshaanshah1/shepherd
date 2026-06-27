# 0009. Sidebar: custom ScrollView rows (not List); T3-Code visual language

Status: Accepted
Date: 2026-06-27

## Context
The v1 sidebar used SwiftUI `List(selection:)`. Two problems:
1. **Keyboard-focus sink.** Clicking a row made the underlying `NSTableView` the
   first responder; while it held focus, typed letters did type-to-select and
   arrow keys moved the selection — keystrokes never reached the PTY.
   `GhosttyTerminal`'s `makeFirstResponder(terminal)` fought the List and lost
   (racy). This was the user-reported "typing doesn't go to the terminal" bug.
2. **Templated styling.** `List`'s default row insets / selection highlight were
   most of what made the sidebar look unpolished, and they resist overriding.

## Decision
Replace `List` with a custom `ScrollView` + `LazyVStack` of plain tappable rows.
- A plain row never becomes the window's key view, so it can't intercept keys.
  On select we hand first responder to the selected terminal surface; the
  selected `GhosttySurfaceView` also claims it on creation (launch/restore), and
  rename hands it back via `store.refocusActiveTerminal()` (a `focusTick` nonce).
- The rename `TextField` is the ONLY view that captures typing, and only while
  editing. SwiftUI controls in the sidebar are `.focusable(false)` (New Tab).
- Drag-reorder is hand-rolled (live reflow, commit on release) since we lost
  `List.onMove`: the drag mutates `tabs` instantly while non-dragged rows animate
  to their new slots; the dragged row follows the cursor via `.offset`.
- Sidebar resize is a custom 6px draggable hairline in `ContentView` (we also
  dropped `HSplitView`); width persists via `@AppStorage`.

Visual language is modeled on **T3 Code**: flat near-black palette (`Theme.swift`
tokens), a dim uppercase section header, one leading glyph per row (muted terminal
icon for shells, colored status dot for agents — pulses while working), a
right-aligned colored status word on notable states only, muted names that
brighten + go medium-weight on selection, subtle rounded selection + hover fills.
Design record: the superpowers spec/plan under `docs/superpowers/` — note those
describe the earlier loud "command deck" direction that this superseded.

## Consequences
- Keyboard correctness now hinges on nothing else stealing first responder — keep
  any sidebar SwiftUI control `.focusable(false)`. Don't reintroduce
  `List`/`HSplitView` without re-solving the focus sink and the styling.
- We own reorder + resize + focus routing (more code, full control).
- All colors live in `Theme.swift`; the libghostty base theme ([ADR 0010](0010-terminal-theme-from-shepherd-config.md))
  mirrors those hexes — keep them in sync.
