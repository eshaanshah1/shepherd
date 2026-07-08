# ⌘F terminal search — design

**Date:** 2026-07-08
**Status:** approved, implementing
**Branch:** `feature/cmd-f-terminal-search`

## Goal

⌘F opens a search box on the focused pane. Matches are highlighted in the
terminal grid (iTerm-style); a counter shows the current/total match; Enter and
⌘G step through matches. Literal, case-insensitive substring search only.

## Key fact: libghostty does the matching + highlighting

libghostty v1.3.1 has search in its core. Its Metal renderer highlights all
matches and the current match itself once search is active — Shepherd draws
nothing. Matching is **literal, case-insensitive substring**
(`std.ascii.indexOfIgnoreCase` over a sliding window). **No regex** — that would
require Shepherd to own the entire match-find + highlight-draw pipeline (read all
scrollback, run `NSRegularExpression`, map offsets → cells, overlay-render), since
the core only highlights its own literal matches. Deferred; only cheap if
libghostty adds regex upstream.

### Protocol

App → core, via `ghostty_surface_binding_action(surface, name, len)`:
- `start_search` — open core search (no term)
- `search:<text>` — set/update needle; **empty cancels** the search
- `navigate_search:next` / `navigate_search:previous` — step matches
- `end_search` — end search, drop highlights

Core → app, via the existing `action_cb` (`handleAction` in `Ghostty.swift`),
target is a surface (recover paneID like `SET_TITLE`/`PWD` do):
- `SEARCH_TOTAL` — `total` = match count
- `SEARCH_SELECTED` — `selected`, **1-based**, `-1` = no match
- `END_SEARCH` — core closed search; hide our overlay

## Components

- **`SearchState`** (`Sources/Search.swift`, pure model, unit-tested): `query`,
  `total`, `selected`; derives `counter` ("3/12") and `noMatches`. Plus
  `SearchDirection { next, previous }`.
- **`AgentStore`** additions (transient, not persisted — like zoom):
  `searches: [paneID: SearchState]`, `focusedPaneID`, and `openSearch()` /
  `closeSearch(paneID:)` / `setSearchQuery(_:paneID:)` /
  `navigateSearch(_:paneID:)` (all post binding actions to the surface), plus
  `setSearchTotal` / `setSearchSelected` / `endSearchFromCore` from `handleAction`.
- **Surface bridge** (`GhosttyTerminal.swift`): a `.shepherdPerformBinding`
  notification carrying `{paneID, action}` — the matching surface view calls
  `ghostty_surface_binding_action`. Mirrors the existing `.shepherdPaneClosed`
  idiom (no weak-registry boilerplate; runs on main).
- **`PaneSearchOverlay`** (`SplitContainer.swift`): floating rounded field at the
  top-right of the focused leaf — 🔍 · text field · `n/N` counter · ‹ › · ✕.
  Shown only when `store.searches[focusedPane] != nil`. The one intentional
  exception to the "sidebar controls are `.focusable(false)`" rule: the field
  takes keyboard focus while open and restores first-responder to the surface on
  close.

## Interaction

- **⌘F** — open/focus search on the focused pane (select-all on reopen)
- type → live `search:<text>`
- **Enter / ⌘G** → next; **Shift+Enter / ⌘⇧G** → previous
- **Esc / ✕** → close (`end_search`, refocus terminal)

## Scope / non-goals

- Focused pane only. No cross-pane / all-pane search.
- No persistence (cleared on pane close + app restart).
- No regex, no whole-word, no per-search case toggle (core is always
  case-insensitive).
