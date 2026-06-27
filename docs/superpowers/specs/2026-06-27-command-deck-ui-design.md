# Command Deck — Shepherd UI redesign

**Date:** 2026-06-27
**Status:** Approved (design); pending implementation plan
**Scope:** SwiftUI chrome (sidebar + window) + libghostty terminal theme + keyboard-focus fix. App lives in `spike/seam1/Sources/`.

---

## Why

Two problems with the current UI:

1. **Keyboard-focus bug.** The sidebar is a SwiftUI `List(selection:)` (`SidebarView.swift:8`). Clicking a tab row makes the underlying `NSTableView` first responder; while it holds focus, typed letters trigger type-to-select and arrow keys move the selection, so keystrokes never reach the PTY. `GhosttyTerminal.updateNSView` tries `makeFirstResponder(terminal)` on selection (`GhosttyTerminal.swift:14`) but the List re-grabs focus and the handoff is racy. Correct behavior: **selecting a tab routes every keystroke into that tab's PTY; the sidebar captures typing only during a rename.**

2. **Templated, incohesive styling.** Stock `List` row styling/insets, stock SwiftUI semantic state colors (`AgentState.swift:14`), a chunky `HSplitView` divider, and a `ContentView` backdrop of `Color(nsColor: .textBackgroundColor)` — which is *light* in light mode and clashes with the terminal. The most load-bearing, unique part of the app (live agent state) is its least-expressed visual element.

## Design thesis

Every other terminal's sidebar is a dumb tab list. Shepherd's reason to exist is that each tab is a live agent with a state, so the sidebar should read like **mission control for a fleet of agents**. That is where the visual boldness is spent; everything else stays quiet.

---

## Token system

### Color — a *functional state palette* (each color means a state, not decoration)

| Token | Hex | Use |
|---|---|---|
| `ground` | `#15171C` | window + sidebar + terminal background (blue-charcoal, not pure black) |
| `raised` | `#1E2128` | selected row background |
| `hairline` | `#272B33` | dividers / sidebar–terminal seam |
| `textPrimary` | `#E6E8EC` | tab names |
| `textSecondary` | `#8A909B` | mono status lines, fleet summary |
| `textDim` | `#5A606B` | shell (no-agent) tabs |
| `working` | `#4DA3FF` (azure) | agent busy — calm, leave it |
| `needsCheck` | `#3FB950` (green) | turn finished — "ready for you" |
| `blocked` | `#FFB454` (amber) | your move — answer / approve / permission |
| `error` | `#FF5C5C` (red) | turn died on an API error |
| `idle` | `#7C828D` (slate) | session alive, between turns |

**Semantics remap (approved):** previously `blocked`=red, `needsCheck`=yellow. Now red = *broken*, amber = *your move*, green = *done*. Update `AgentState.color` accordingly.

### Typography
- **Tab names:** SF Pro Text, 13pt, medium.
- **Status subtitle + fleet summary + wordmark:** SF Mono, 11pt. Deliberate: machine-status in mono, on-theme for a terminal, and it visually separates "what you named it" from "what it's doing."

---

## Sidebar (the hero)

```
┌──────────────────────────────┐
│  SHEPHERD          ← wordmark: dim, letter-spaced SF Mono
│  2 working · 1 needs you   ← live fleet summary (THE signature)
├──────────────────────────────┤
│ ▎● mobile-debug              ← selected: raised bg + 3px state-colored accent bar
│     working · 0:42           ← SF Mono status subtitle
│   ● MOBPC-4821
│     needs you                ← amber, loud
│   ○ scratch
│     shell                    ← dim, recedes
├──────────────────────────────┤
│  +  New Tab            ⌘T
└──────────────────────────────┘
```

**Header region:** wordmark `SHEPHERD` (dim, letter-spaced mono) + a live **fleet summary** line that counts non-idle states (e.g. `2 working · 1 needs you`; collapses to `all idle` / `all clear` when nothing is active). This is the signature element.

**Row anatomy:**
- State dot (~9px) in the state color; **pulses only when `working`** (gentle opacity breathe). Shell/idle dots are hollow/dim.
- Name: SF Pro 13 medium, `textPrimary` (`textDim` for shell tabs).
- Status subtitle: SF Mono 11, `textSecondary` — `<state> · <elapsed>`; for `blocked`, show the reason (e.g. "plan approval"); for `shell`, just "shell" dim.
- Selected row: `raised` background + 3px left accent bar in the row's state color.
- Attention states (`blocked` / `error`) render the subtitle in the state color (loud); calm states stay `textSecondary`.

**Fleet summary + the alive dot + the selection accent bar are the one memorable thing.** Everything else is disciplined and quiet.

---

## Window chrome
- Transparent unified titlebar (`.hiddenTitleBar` window style + full-size content view) so dark chrome flows under the traffic-light buttons.
- Replace the chunky `HSplitView` divider with a near-invisible `hairline` seam between sidebar and terminal.
- Chrome locked to dark appearance (`.preferredColorScheme(.dark)` / window appearance) regardless of system, so it never clashes with the dark terminal.

## Terminal theme (libghostty)
- Inject a matching theme via `ghostty_config_load_string` in `Ghostty.swift` (between `ghostty_config_new` and `finalize`): `background` = `ground`, a coherent 16-color ANSI `palette`, `cursor-color`, `selection-background`/`selection-foreground` tuned to the chrome.
- **Precedence (approved):** load our theme as the *base*, then `ghostty_config_load_default_files` on top — so a user's own `~/.config/ghostty` overrides our colors, but a fresh user gets Command Deck by default.
- Swap the `ContentView` backdrop (`ContentView.swift:15`) from `.textBackgroundColor` to `ground` so there is no light flash / mismatch behind unselected surfaces.

---

## The focus fix

**Replace `List(selection:)` with a custom `ScrollView` + tappable rows.** This solves both problems at once: the native `List` is *both* the keyboard-focus sink and the source of the ugly default row styling/insets.

- Rows are plain tappable views (`.onTapGesture` → `store.select`). A plain row never becomes the window's key view, so it cannot intercept type-select or arrow keys.
- On every selection change, hand first-responder to the selected terminal surface (`makeFirstResponder`) so keystrokes hit the PTY. Drive this reliably off selection (not only the racy `updateNSView` path).
- The rename `TextField` becomes the **only** view that captures typing, and only while `editing`. On commit/cancel, return first-responder to the terminal.
- **Cost:** reimplement drag-to-reorder (currently `List`'s `.onMove`, `SidebarView.swift:15`) with SwiftUI drag-and-drop (`.draggable` / `.dropDestination` or `onDrag`/`onDrop`). Accepted trade for full styling + focus control.

---

## State model additions

- **`stateSince: Date` per `Agent`** — set whenever `state` changes (in `AgentStore.apply` and the `.shell`/focus transitions). Drives the elapsed timer ("working · 0:42"). Not persisted (transient like `state`).
- A **1s tick** (a `Timer`/`TimelineView`) that refreshes elapsed labels, running only while the app is active and at least one tab is `working`/`blocked` (cheap; no tick when nothing is timing).
- Fleet-summary counts derive from existing `tabs` + `state`; no new storage.

## Out of scope (unchanged)
- Agent-state lifecycle map, hook protocol, socket, persistence keys — untouched except adding `stateSince`.
- Sidebar-shows-all-tabs behavior (ADR 0006) — unchanged.
- No new dependencies; SwiftUI + AppKit + GhosttyKit only.

## Risks / unknowns to confirm during implementation
- Exact libghostty symbol for string config (`ghostty_config_load_string` expected) and whether base-then-files ordering composes as intended.
- `.hiddenTitleBar` + custom sidebar interplay with traffic-light button insets (may need top padding on the sidebar header).
- SwiftUI drag-reorder fidelity vs. the old `List.onMove` (drop indicator, animation).

## Verification
Build via the documented flow (`xcodegen generate` → `xcodebuild` → ad-hoc codesign → `open`), then visually confirm: keystrokes reach the PTY immediately after clicking a tab; rename still works and is the only typing capture; state colors/pulse/accent bar render; terminal grid bg matches chrome; titlebar is unified; drag-reorder works. Screenshot the sidebar across states.
