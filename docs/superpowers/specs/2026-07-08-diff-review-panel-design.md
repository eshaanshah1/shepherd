# Diff Review Panel — design

**Date:** 2026-07-08
**Status:** design approved, pre-implementation
**Branch:** `feature/diff-review-panel`

## Problem

To see what an agent changed in a Shepherd pane, the current flow is: ask the
agent to open a draft PR, then review it on GitHub. That's a lot of ceremony for
"show me the diff," and it pulls you out of Shepherd into a browser.

We want an **in-app native diff-review panel**: open a pane's diff inside
Shepherd, read it, and — the differentiator — **comment on it and have the
comment become a prompt sent straight back to that pane's agent**. No PR, no
browser round-trip.

The native (SwiftUI) route was chosen deliberately over reusing libghostty /
`delta`, because this panel is the foothold for a larger review surface (see
[Future](#future)).

## v1 scope

- **Pane-scoped.** The panel reviews the *focused* pane's cwd.
- **Two diff modes, toggleable:** working-tree (default) and branch-vs-base.
- **View:** file list + syntax-highlighted, diff-colored hunks.
- **Comment → prompt:** anchor comments to lines, batch them like a PR review,
  submit as one prompt injected into the pane's agent.

Everything else in [Future](#future) is explicitly out of v1, but the boundaries
below are drawn so those features bolt on without a rewrite.

## Architecture

Four units, following the repo's existing pure-model-vs-AppKit-shell split
(`SplitTree`/`Workspace`/`StopPolicy` are pure and unit-tested; their AppKit
shells live separately).

### 1. `DiffModel.swift` — pure model + parser (no AppKit)

The load-bearing piece. Everything else consumes this.

```
DiffFile   { path, oldPath?, status(.added/.modified/.deleted/.renamed),
             isBinary, hunks: [DiffHunk] }
DiffHunk   { header, oldRange, newRange, lines: [DiffLine] }
DiffLine   { kind(.context/.added/.removed), text, oldLineNo?, newLineNo? }
```

Plus `parse(unifiedDiff:) -> [DiffFile]` — turns `git diff` output into the
model. Fully unit-testable against captured fixtures. **No dependency on
HighlighterSwift** — highlighting is a view concern layered on at render time; the
model stays plain text. Added to both the app target and the
`ShepherdModelTests` `sources:` list.

### 2. `DiffReader.swift` — git subprocess shell (app target)

Runs `git -C <pane.cwd>` and hands raw unified-diff text to the parser. Owns:

- the two modes and their git invocations (below),
- base-branch detection,
- untracked-file synthesis,
- reading the two whole-file blobs for syntax highlighting.

Effectful, not unit-tested (shells out) — same posture as other process-spawning
code in the app. Runs off the main thread; results marshaled to the
`@MainActor` view-model.

### 3. `DiffPanelView.swift` + `DiffReviewModel` — SwiftUI + `@MainActor` VM

The panel UI and its state. The VM holds the current `[DiffFile]`, the mode, the
pending review comments, and the `pendingDiff` staged for refresh. Imports
HighlighterSwift (app target only).

### 4. Comment → prompt injection

Reuses the existing PTY-injection seam (the `claudeResumeInput` /
`shepherdd pty` input path). A submitted review is one text blob typed into the
focused pane's PTY.

**Why these boundaries:** the diff *data* (1) is decoupled from how it's
*acquired* (2) and how it's *shown* (3). Per-turn diffs swap only the reader's
git range; remote review ships `DiffModel` over the wire and renders it on
Android; linked-PR comments overlay onto the same file/line anchors. None of the
Future work forces a core rewrite.

## Diff acquisition (`DiffReader`)

All commands run with `git -C <pane.cwd>`.

### Working-tree mode (default)

- Tracked: `git diff -M HEAD` — staged + unstaged vs. last commit. This is
  everything the agent touched since the last commit, which is the common case
  you're reaching for. `-M` so renames render as renames.
- Untracked: `git ls-files --others --exclude-standard`, synthesize an
  all-added `DiffFile` per new file. Agents create files constantly; untracked
  **must** show or the diff lies.

### Branch-vs-base mode ("what the PR shows")

- Detect base: `git symbolic-ref refs/remotes/origin/HEAD` → fall back to `main`
  then `master`. Repos here vary (`mobile` vs `railsApp`), so detect, don't
  hardcode.
- Diff: `git diff -M <base>...HEAD` (three-dot = merge-base, what a PR diffs),
  **unioned** with working-tree changes so uncommitted work still appears. The
  mode reads as "total change vs. base," not "committed only."

### Guards

- cwd not a git repo → clean empty state ("not a git repository"), no crash.
- Renames via `-M`.
- Not a Claude pane (plain shell) → diff still viewable (it's a git panel,
  agent-agnostic); the comment composer is hidden unless the pane has a live
  agent (`sessionID` present).

## Refresh model

GitHub's "this branch has new commits · Refresh" pattern, applied to turns.

- **Panel closed:** the panel reads fresh on every open, so a `Stop` while
  closed needs no handling — next open is current.
- **Panel open:** a `Stop` for the reviewed pane does **not** disturb the view.
  The VM rebuilds the diff **in the background** and stashes it as `pendingDiff`;
  a **"⟳ Changes available"** banner appears. The displayed diff holds still.
  Clicking the banner is a near-instant swap (`displayed = pending`) — no
  read/parse latency at click time. Latest `Stop` wins if several land while you
  read. Manual `r` with no pending falls back to a synchronous read.

Your scroll position and in-progress comments are only ever disturbed by your
own click.

Mechanically: `DiffReviewModel` observes the reviewed pane finishing a turn. The
store already routes `Stop`→need-to-check per pane in `AgentStore.apply`; we
surface a signal off that — no new plumbing. This same "a turn ended" signal is
what the Future per-turn timeline will hook to append entries.

## Panel UX

- **Trigger:** `⌘⇧G` toggles the panel for the focused pane (`⌘⇧D` is taken by
  split-down). `Esc` or `⌘⇧G` again closes.
- **Placement:** slides in as a right-hand panel over the content area (sidebar
  stays put), resizable via a hairline divider like the sidebar/content split.
  Does not disturb the pane's live terminal underneath — close it and the agent
  is exactly where it was.
- **Layout (top → bottom):**
  - Header: pane title · mode toggle (Working tree ⇄ vs. `<base>`) · `r`
    refresh · the "⟳ Changes available" banner when stale · pending-comment
    count.
  - File list: path · status glyph (A/M/D/R) · +/− line counts · collapse
    toggle. `j`/`k` or click to move between files.
  - Hunks: unified view. Two-layer coloring — diff-semantic **background**
    (added/removed/context/hunk-header from `Theme.swift`) with syntax-colored
    **foreground** tokens (below). Monospace. Gutter shows old/new line numbers
    (the comment anchors).
  - Empty states: "not a git repository" / "no changes."
- **Keyboard-first**, all controls `.focusable(false)` (ADR 0009) so keystrokes
  aren't stolen from the PTY.

### Syntax highlighting

- **HighlighterSwift** (`smittytone/HighlighterSwift`, module/product
  `Highlighter`; Highlight.js over JavaScriptCore, SPM) — a Swift package that
  bundles the JS as a resource; JavaScriptCore is a system framework. Added as an
  SPM dependency in `project.yml`; the JS is never touched directly. (Chosen over
  the original `raspu/Highlightr`, which is unmaintained as of 2026 and points
  users to HighlighterSwift; the API is near-identical — `Highlighter()?`,
  `highlight(_:as:)`.)
- **Whole-file, not fragment** (how GitHub / VS Code do it). We are inside the
  repo, so we have the real files — no reconstruction:
  - new-side = the file on disk in the pane's cwd
  - old-side = `git show HEAD:<path>`
  Highlight each whole file **once**. Then map colors onto diff lines by
  line-number index — every `DiffLine` carries its old/new line number, so it's
  a direct lookup, not fuzzy matching.
- **Guards:** cache per file; **skip highlighting for very large / minified
  files** (>~500 KB) and fall back to diff-coloring only, so a giant generated
  file never janks the panel. JSCore has per-call cost — highlight once, reuse.
- Kept out of `DiffModel` / the test target — strictly a view-layer concern.

## Comment → prompt

Modeled on the PR review flow being replaced: **accumulate, then submit once.**

- **Anchor:** select a line (or drag a range) in a hunk → a composer opens
  anchored to that `file` + line number/side. Type, "Add." Held in the VM as a
  pending comment `(file, line, side, text)`; the line gets a marker.
- **Batch:** leave several comments across files; a running count shows in the
  header.
- **Submit:** one "Send to agent" action composes all pending comments into a
  single prompt and injects it into the reviewed pane's PTY via the existing
  injection seam. Shape:
  ```
  Review feedback on your changes:

  1. src/foo.rb:42 — this should handle the nil case
  2. src/foo.rb:88 — rename `tmp` to something meaningful
  3. lib/bar.swift:10 — extract this into a helper

  Please address these.
  ```
  file:line references so the agent can jump to each site.
- **Submit policy:** config flag `shepherd.diff.autoReviewSubmit` (UserDefaults,
  same pattern as `shepherd.panes.defaultCollapsed`; ADR 0012's "source from
  `~/.config/shepherd` later" applies). **Default: auto** — compose, type, and
  send (trailing newline). Set false → stages the prompt without the newline so
  you press Enter yourself.
- **Gating:** composer only appears if the reviewed pane has a live agent
  (`sessionID` present). Plain shell → view-only.
- After submit, pending comments clear (the review is "submitted").

## Testing

Pure, in `ShepherdModelTests` (`DiffModelTests.swift`, added to the target's
`sources:` list):

- Parser against captured `git diff` fixtures: adds, deletes, renames (`-M`),
  binary, untracked-synthesized, multi-hunk, no-newline-at-EOF, empty diff.
- Comment → prompt composition: N anchored comments → the exact prompt string
  (deterministic, no AppKit).
- Diff-line → highlighted-blob-line index mapping, kept as pure functions so
  it's testable without JSCore.

`DiffReader` (shells to git), HighlighterSwift rendering, and the SwiftUI panel are
verified at runtime by the user (per the repo's "compile + unit tests, defer
runtime checks to me" rule — never killall/relaunch the live app).

## Files touched

**New (`spike/seam1/Sources/`):**
- `DiffModel.swift` — pure model + parser (app target **and** test target)
- `DiffReader.swift` — git subprocess shell (app target)
- `DiffPanelView.swift` — SwiftUI panel + `DiffReviewModel` (app target)

**New (`spike/seam1/Tests/`):**
- `DiffModelTests.swift`

**Edited:**
- `project.yml` — HighlighterSwift SPM package; new model source in the test target
- `ShepherdApp.swift` — `⌘⇧G` menu command
- `ContentView.swift` — mount the panel as the right-hand overlay + divider
- `AgentStore.swift` — surface the per-pane "turn ended" signal for the
  stale-banner; expose PTY injection for review submit (reuse existing seam)

Remember: `xcodegen generate` after adding files.

## Future

Long-term vision (user's own words — the boundaries above are drawn toward
these). None are in v1.

- **Review + act:** stage/unstage/discard hunks in-app — replace the PR review
  UI entirely.
- **Per-turn timeline:** diff-since-last-`Stop`, watch an agent's work accrete
  step by step, leveraging the hook lifecycle. Hooks onto the same "turn ended"
  signal the stale-banner uses. Needs anchor-preservation (remap comments/scroll
  across diffs) — the reason auto-refresh-on-`Stop` is deferred out of v1.
- **Remote review:** review + comment from the Android / remote client — ships
  `DiffModel` over the wire, renders + comments remotely.
- **Linked-PR comments:** pull `gh` PR review comments and show them inline on
  the same file/line anchors (requires an agent↔PR link, itself a future task).
- **Natural-order diff:** reorder hunks into a readable review sequence rather
  than file/line order (very long term).

## Deferred out of v1 (rationale)

- **Auto-refresh-on-`Stop` (blind replace):** replaced by the pending-diff +
  banner model; true live-refresh belongs with the per-turn timeline where
  anchor-preservation is the actual goal.
- **Workspace-wide / multi-pane diff overview:** v1 is pane-scoped.
- **git mutations (stage/discard):** view + comment only in v1.
