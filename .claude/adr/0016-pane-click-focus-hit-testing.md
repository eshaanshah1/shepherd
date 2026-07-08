# 0016. Click-to-focus a pane: three hit-testing gates

Status: Accepted
Date: 2026-07-08

## Context
Clicking an inactive pane did not move keyboard focus — keystrokes kept going to
the previously-focused pane (`mouseDown`/`focusPane` are correct; the click simply
never reached the intended surface). The failure was *intermittent* and appeared
to move as each layer was fixed, because **three independent surfaces** could each
intercept a click before it reached the target pane. They stack, so fixing one
just exposed the next.

The bug was invisible before pane splitting: a single-pane tab never needs a
*click* to take focus — it grabs first responder on tab-switch (`updateNSView`
`isSelected` → `makeFirstResponder`). Only a split, where you click to move focus
*between* two live panes, exercises click-routing, so the overlaps had never
mattered.

Ground truth came from instrumenting the click path (a `shepherdClickLog` file
tap + an app-level `NSEvent` `.leftMouseDown` monitor dumping every
`GhosttySurfaceView` under the point, in z-order, plus the `hitTest` result's
ancestry). The dumps showed, at a failing click: eight stacked surfaces (six
full-width from other tabs, `alpha=1`, not hidden), and — after the first two
fixes — `hitTest -> NSClipView` for a mispositioned sidebar scroll view.

The common thread: **SwiftUI's `.opacity(0)`, `.clipped()`, and
`.allowsHitTesting(false)` do NOT propagate to a hosted `NSView`'s participation
in AppKit hit-testing.** A visually-hidden/clipped hosted view (our
`GhosttySurfaceView`, or a native `ScrollView`'s `NSClipView`) stays a real,
hit-testable AppKit view at its real frame. AppKit routes `mouseDown` by frame +
z-order, ignoring the SwiftUI-level modifiers.

## Decision
Fix at the level AppKit actually consults — frames and per-view `hitTest` — with
three gates:

1. **Within a split tab — custom `PaneLayout` (not `.position`/`.offset`).**
   `.position` expands each pane's backing `_NSGraphicsView` to fill the whole
   container; stacked, the topmost pane covered its sibling and swallowed its
   clicks. `.offset` is render-only (doesn't move the backing frame), so it was no
   better. `SplitContainer` now places panes with a `Layout` that frames each
   pane's backing view to its **exact** rect from `node.frames` — no overlap,
   correct AppKit routing — while `ForEach(node.panes)` keeps each pane's SwiftUI
   identity so surfaces/PTYs are never torn down.

2. **Across tabs — gate on the surface itself.** Every tab of every workspace
   stays mounted (agents keep running), and `ContentView`'s
   `.allowsHitTesting(visible)` did not reach the raw `GhosttySurfaceView`, so
   background tabs' full-size surfaces stayed hit-testable and overlapped the
   visible split. `GhosttySurfaceView` now carries `hitTestable` (set from
   `isVisible` = *selected tab's on-screen pane* in `updateNSView`) and overrides
   `hitTest` to return `nil` when not hit-testable. Only the selected tab's
   on-screen panes accept clicks.

3. **Across workspaces — gate the sidebar's off-screen lists.** The sidebar
   renders all workspaces' tab lists in one horizontally-offset strip
   (`.offset(x: -index*w)`, `.clipped()`), each list a `ScrollView`. `.clipped()`
   hid the off-screen lists visually but their backing `NSClipView` floated over
   the content area (e.g. x≈548 over the left pane) and ate clicks there. Each
   non-current list now gets `.allowsHitTesting(ws.id == selectedWorkspaceID)`.
   Unlike our custom surface, a **native** `ScrollView` *does* honor
   `.allowsHitTesting(false)` — verified: after the gate, `hitTest` returns a
   `GhosttySurfaceView` for every click, zero `NSClipView`.

All three are required. #2 handles cross-tab, #3 cross-workspace, but neither
touches the within-tab sibling overlap — two panes in the *visible* tab are both
`hitTestable`, so `.position`'s full-size wrappers would still fight; #1 is what
separates them.

## Consequences
- Click-to-focus is deterministic in both directions, across tabs and workspaces.
- `PaneLayout` requires macOS 13+ `Layout` (fine; target is macOS 26). Subview
  order must match `ForEach(node.panes)` — the layout maps `subviews[i]` to
  `node.panes[i]` and recomputes `node.frames` itself, including the zoom case
  (zoomed pane fills; siblings placed at 0×0, still mounted).
- Do **not** revert `SplitContainer` to `.position`/`.offset`, remove the
  `GhosttySurfaceView.hitTestable`/`hitTest` gate, or drop the sidebar
  `.allowsHitTesting` — each silently reopens one axis of this bug, and the
  single-pane path won't catch it.
- The sidebar slide animation is preserved (the strip still exists; only
  hit-testing on non-current columns is disabled).

## Lesson
SwiftUI view modifiers (`.opacity`, `.clipped`, `.allowsHitTesting`) are not a
reliable way to remove a **hosted `NSView`** from AppKit hit-testing — they may
affect only the SwiftUI layer while the backing view stays live at its real frame.
Gate hosted-view interactivity at the AppKit level: correct frames (custom
`Layout`), a `hitTest` override, or — for SwiftUI-native hosted views like
`ScrollView`, which *do* honor it — `.allowsHitTesting`. When a click "does
nothing," dump the actual AppKit view tree at the point (an `NSEvent` monitor +
`hitTest` ancestry), don't reason from the SwiftUI hierarchy.
