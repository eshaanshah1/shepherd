# Unified Code Surface — Editor + Diff in One Overlay

**Date:** 2026-07-13
**Status:** Phase 1 (edit mode) shipped. Unification pivoted to **two renderers** —
see the Addendum at the bottom (the single-CESE-renderer plan was defeated by a
verified CESE limitation).
**Extends:** [`2026-07-08-diff-review-panel-design.md`](2026-07-08-diff-review-panel-design.md) (the current diff overlay).
**Related decisions:** stay native Swift + libghostty (no Rust/Electron rewrite — see below and the `shepherd-no-electron-rewrite` / `superzed-learnings` memories).

---

## 1. Goal

Give Shepherd a **lightweight code surface** for the "pop out of the agent to do a
manual thing, then pop back" moments — minor file edits and git-diff review — and
**unify editing and diff review into one renderer**. The agent (Claude in a terminal
pane) stays the primary surface; the code surface is a transient overlay you open,
work in, and dismiss.

Explicit non-goals (v1): LSP / autocomplete / go-to-definition, a debugger, a file
tree, multi-file project editing, remote (host) editing. This is a small-edits +
review surface, not an IDE.

## 2. Shape: an overlay, not a pane

The code surface is a **full-takeover overlay over the content area** — the same
presentation model as today's diff panel — **not** a leaf in the `SplitNode` pane
tree.

Rationale (settled during brainstorming): the workflow is "agent is home base; pop
in for a minor edit or a diff review, then pop back," which is a *focused, transient
mode*, not an always-open side surface. An overlay fits that; a pane would force
either "see the editor OR the terminals, never both" or reinventing tabs inside a
pane. Choosing the overlay also means **zero blast radius on the pane model**: no
`Pane.kind`, no `SplitNode` changes, no layout-persistence migration, no
focus-in-tree work, no remote-mirror parity question.

The agent keeps running underneath the overlay. The socket → `StopPolicy` → state
machine is unaffected, so the **dock badge / notification still fires** if the agent
blocks or finishes while the surface is open — that is what pulls the user back, so
not seeing the terminal while editing costs nothing.

This generalizes the existing `store.diffPanelOpen` / `diffPanelPaneID` overlay into
a code surface with two **modes** driven by one renderer.

## 3. One renderer: `CodeEditSourceEditor`

Both modes render through a single native editor component — `CodeEditSourceEditor`
(the tree-sitter AppKit/SwiftUI editor from the CodeEdit.app project, MIT), wrapped
behind our own `CodeSurfaceView` so the underlying library is swappable.

- **Edit mode** — the real file loaded into an **editable** buffer. Save writes it
  back. Syntax highlighting via tree-sitter (same engine/grammars Zed uses).
- **Diff mode** — a **read-only**, syntax-highlighted rendering of the unified diff
  loaded into the same editor (same widget, different buffer + editability).
  Clicking a file/hunk opens that file in edit mode.

### Verified capability boundary (read from CESE source, not its README)

- CESE ships **no** turnkey merge/diff view. Its "text diff" is internal range
  diffing for incremental highlighting. We render the diff ourselves (compose diff
  text + gutter/line decoration); this is real work, owned by us.
- "Inline messages (warnings/errors)" is **marketing only** — there is no
  `InlineMessage` type in the code. We do not depend on it.
- Load-bearing primitives that **do** exist: editable tree-sitter text, a gutter, a
  `TextAttachment` system (used internally for fold placeholders + minimap), and
  **`layoutManager.rectForOffset(_:)`** (line/offset → rect geometry). v1 relies only
  on `rectForOffset` + read-only/editable buffers — **not** on attachments or inline
  messages.

### Dependency strategy

Add `CodeEditSourceEditor` via SPM **pinned to a specific revision** (it self-labels
"in development, not production-ready"). All use goes through `CodeSurfaceView`; if we
later drop to the lower-level `CodeEditTextView` + `SwiftTreeSitter`, only that file
changes.

## 4. Comments — a geometry-positioned overlay layer

Comments are the review mechanism and they are **preserved end-to-end**. The
comment-to-agent pipeline is rendering-agnostic and does not change:

- Model: `ReviewComment { id, file, line, side, text }` (pure).
- `ReviewPrompt.compose(_:)` → the prompt string.
- `AgentStore.submitReview(_:toPane:)` → `injectText(prompt, intoPane:)` types it into
  the agent's PTY (with the `shepherd.diff.autoReviewSubmit` newline).

What moves is only the **anchoring/positioning**: today `CommentComposer` /
`CommentBubble` render *between rows* of the custom `DiffPanelView` list. In the code
surface they render in a **transparent overlay layer on top of the editor**, each one
positioned by querying `layoutManager.rectForOffset(line)` and repositioned on scroll
and on edit. The `CommentComposer` / `CommentBubble` SwiftUI views port over nearly
verbatim.

### Collapsed-comment behavior (approved refinement)

A placed comment renders in one of two states:

- **Collapsed** (default, when not hovered and not focused for typing): a small icon
  button (a comment/speech glyph) anchored at its line.
- **Expanded** (on hover, or while its composer has keyboard focus for typing): the
  full bubble / composer card.

Transition is hover-in → expand, hover-out → collapse, **unless** the composer holds
typing focus (then it stays expanded until focus leaves). This keeps the diff
readable — a reviewed file shows quiet line-anchored dots, not a wall of cards — and
expands just-in-time.

### Known tradeoff of the overlay layer

An overlay **floats**; it cannot push the diff text down GitHub-style. A comment is an
anchored bubble/popover at its line, not an inline block that shoves following lines
down. Accepted for v1. True push-down inline (and in-place editable diff with phantom
removed-lines) is a Phase-2 upgrade that would use the `TextAttachment` system — gated
on that dependency's public API; out of scope here.

## 5. Entry, save, dismiss

- **Open:** `⌘O` (file picker, default dir = focused pane's `cwd`) opens edit mode;
  the existing "Review Diff" command opens diff mode. Both open the same overlay,
  keyed to the focused pane for cwd/repo context (reuses `diffPanelPaneID`, renamed
  conceptually to the surface's target pane).
- **Save:** `⌘S` writes the editable buffer to its file, clears the dirty flag;
  untitled → save-as.
- **Dismiss:** toggle / `Esc` closes the overlay back to the agent (matching the diff
  panel today). Unsaved-changes handling: prompt on dismiss if dirty (simple confirm).

## 6. Deliberately unaffected systems (blast-radius statement)

- **Pane model / `SplitNode` / layout persistence:** unchanged (surface is an overlay).
- **Agent state machine / socket / `StopPolicy`:** unchanged; no agent runs in the
  surface.
- **Attention / dock badge / notifications:** unchanged; still fire from live panes
  underneath.
- **Remote (mirror) workspaces:** unchanged; the surface is local-only in v1.

## 7. Persistence

The surface is transient UI state (open/closed, mode, target pane, current file) —
**not** layout. No changes to `shepherd.workspaces.v1` or the `SplitNode` codecs.
Optionally remember the last-open file per session (minor, can defer).

## 8. Testing

- Pure-model coverage stays in `ShepherdModelTests`: `ReviewComment` / `ReviewPrompt`
  are already pure; add tests for any new pure helper (e.g. line→comment anchoring math
  if extracted, diff-text composition if extracted).
- `CodeSurfaceView` (AppKit/CESE) is not unit-tested — same policy as `GhosttyTerminal`
  and `DiffPanelView`; verified by build + a runtime check by the user.

## 9. Risks / de-risking spikes (do these first)

1. **`CodeSurfaceView` spike:** embed `CodeEditSourceEditor` in one overlay, load a
   file editable, confirm tree-sitter highlighting + save round-trip, and confirm
   focus behaves alongside libghostty's first-responder claiming (ADR 0009). This is
   the single highest-risk item — do it before anything else.
2. **Comment-layer geometry spike:** place one `CommentBubble` at a line via
   `layoutManager.rectForOffset`, confirm it tracks scroll and edits, and confirm the
   collapse/expand-on-hover behavior with a real text field's focus.
3. **Theme mapping:** map `Theme.swift` tokens → CESE theme; reuse the Shepherd code
   theme/fonts already built for `DiffPanelView`.

## 10. Why native Swift (not Rust/Electron) — decision record

Kept here so it is not relitigated: Shepherd stays **Swift + libghostty**. Rust (à la
Zed/superzed) would be a full rewrite of a working v1 into GPUI for zero terminal
benefit (same libghostty via FFI either way), and Zed's editor is not a reusable
library. Electron/Tauri can't embed libghostty (it is the host renderer, no
render-to-buffer path) so they force an xterm.js downgrade; Tauri is WebKit, which is
rejected. Native syntax highlighting is a solved problem via `SwiftTreeSitter` (same
tree-sitter engine as Zed) with CodeEdit.app as the production existence proof. The
lightweight-editor scope stays comfortably inside native's reach; if scope ever
balloons to a full IDE, revisit — not before.

---

## Addendum 2026-07-13 — two-renderer pivot (supersedes §3–§4 "one renderer")

Building Phase 2 surfaced a hard, verified limitation in the pinned CESE /
`CodeEditTextView`:

- **No faithful diff.** The only line-decoration primitive is `EmphasisManager`
  (`.standard`/`.underline`/`.outline`) — rounded boxes around text glyphs, not
  full-width per-line +/- backgrounds.
- **Can't show removed lines.** A diff must render removed lines that aren't in the
  file; that needs inserting non-file phantom content. `TextAttachment` is
  **width-based inline drawing** (`var width` + `draw(in:rect:)` via CGContext), an
  inline-glyph replacement — **not** a height-reserving "view zone," and it can't
  host an interactive view (e.g. a comment composer).

Reaching Monaco/CodeMirror-style diff + inline comment threads on this native stack
would require **adding a view-zone system to the layout engine** (reserve vertical
space + host NSViews mid-document) — i.e. forking and maintaining a bespoke code
editor. That is disproportionate to the "lightweight edits + diff review" scope (the
§10 "revisit only if scope balloons to full IDE" line), and the web editors that do
this off the shelf were declined to stay native.

**Resulting architecture (built):** one overlay **code surface**, two renderers:

- **Diff mode** → the existing `DiffPanelView` (full-fidelity +/- rendering + working
  inline comment→agent pipeline, unchanged).
- **Edit mode** → `CodeSurfaceView` (native CESE), from Phase 1.

They are **mutually exclusive** (opening one closes the other), and a hover **pencil**
on each diff file header **jumps to editing that file** in edit mode. The user
experiences one surface; comments stay entirely on the diff renderer (so the earlier
"comments as a layer on the editor" work — `LineGeometry` — was removed as dead).
"Diff rendered inside the editor" is dropped unless the editor stack is later revisited.
