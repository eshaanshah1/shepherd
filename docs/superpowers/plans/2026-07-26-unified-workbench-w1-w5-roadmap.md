# Unified Workbench W1–W5 Roadmap

> **Continuation doc.** This file carries the remaining work in executable order so a
> fresh session resumes without re-deriving anything. Spec:
> `docs/superpowers/specs/2026-07-26-unified-workbench-design.md`. W0 plan (read its
> Task 1 postmortem first): `2026-07-26-unified-workbench-w0.md`.

## Progress

Last updated 2026-07-27 · branch `unified-workbench-spec` · 32 commits · 357 tests, 0 failures

```
W0  editor foundation      ██████████████████████  100%   run + hardened
W1  review & staging       ██████████████████████  100%   run + hardened
W2  editing in anger       ░░░░░░░░░░░░░░░░░░░░░░    0%
W3  merge resolver         ░░░░░░░░░░░░░░░░░░░░░░    0%
W4  PR surface             ░░░░░░░░░░░░░░░░░░░░░░    0%
W5  history & power tools  ░░░░░░░░░░░░░░░░░░░░░░    0%
                           ──────────────────────
    overall                ████████░░░░░░░░░░░░░░   40%
```

**W0 — done (11 tasks).** Editor vendored (247 files / 23,946 lines in-module,
6 module collisions resolved); `Theme.Diff` + shared 1.5 line height; `StitchMap`,
`BlockMap`, `WordDiff`, `LockPolicy` (44 tests); `SourceBuffer`, `BlockRenderer`,
`DiffGutter`, `MultiHighlighter`; review rendering on the new engine. `DiffPanelView`
(1026 lines) and the HighlighterSwift dependency deleted — one tokenizer, one layout
engine, one row rhythm, one palette.

**W1 — done.** `PatchSynth` (+15 tests), `GitStaging`, comment composer/bubble
restored; `StageSelection` (+14 tests) with the staging state on the session;
staged/unstaged/committed rail with per-file + bulk toggles, commit box, inline git
errors; `WorkbenchThreadsPanel`; workbench shortcuts. See "W1 as built" for where the
result differs from the plan below.

**Both have now been run**, on a 287-file / 32k-row vs-base diff — see "What the first
live run cost" for the eleven defects that found and what they imply for W2+. The
gutter-alignment assumption that gated everything **was wrong** and is fixed; the
section that warned about it is now a record of the resolution.

## Read this before touching anything

- **Build/test commands and the global constraints** are in the W0 plan's header. They
  still apply — especially `xcodegen generate` after any file add, and adding new pure
  models to `ShepherdModelTests`' explicit `sources:` list.
- **This shell resets cwd between calls and wraps `cd` with zoxide.** Always `cd` with
  an absolute path inside each command. A compound `xcodegen && xcodebuild` without it
  silently tests a *stale* project — a passing run right after adding a file is
  suspicious until the test count moves.
- **BSD `sed` has no `\b`.** Use `[[:<:]]` / `[[:>:]]`.
- **SourceKit lies here.** "No such module" / "Cannot find type" from the editor is
  noise; `xcodebuild` is ground truth.
- **Never `killall Shepherd`** — it's the user's daily terminal. Verify by compile +
  unit tests; hand runtime checks to the user.

## RESOLVED — the assumption that gated everything

> Kept because the resolution is the load-bearing part, not the warning.

The gutter positioned rows arithmetically at `index × WorkbenchMetrics.rowHeight`
(`NSLayoutManager.defaultLineHeight × Theme.lineHeightMultiple`). **It was wrong.** CETV
types lines with CoreText — `(ascent + descent + leading) × lineHeightMultiplier`
(`TextLayoutManager.estimateLineHeight`) — a different number, so the gutter and the text
agreed near the top and drifted further apart the deeper you scrolled, exactly as
predicted.

**The gutter now has no opinion about geometry.** `DiffGutterView.lineMetrics(index)`
returns the real `(yPos, height)` from `layoutManager.textLineForIndex`, and
`lineIndex(documentY)` resolves the visible window and click hit-tests through
`textLineForPosition`. `WorkbenchMetrics.rowHeight` survives only as a fallback for
before the editor exists. **Do not reintroduce a second opinion about where a line
sits** — that is what this cost two days to learn. The payoff beyond the bug: wrapped
lines and variable-height block rows (`BlockMap` file headers, still unrendered) will
line up for free instead of needing this solved again.

Two traps to respect when touching this code, both of which broke scrolling outright:

- **The gutter lives outside the scroll view**, unlike CESE's own gutter (a floating
  subview that moves for free). It tracks scroll by observing the clip view's
  `boundsDidChangeNotification` — the same signal
  `TextViewController.setUpOnScrollChangeObserver` uses. It cannot use
  `SourceEditorState.scrollPosition`, which arrives a run-loop pass late and made the
  gutter slide against the text.
- **Everything in `draw` runs per scroll event.** The layout-manager lookups are cheap
  individually and ruinous in an unbounded loop; `visibleRange` caps its walk at the rows
  that could fit the dirty rect, and each row makes exactly one layout query.

**Wiring order is a trap too.** `prepareCoordinator` runs inside
`TextViewController.init`, but `scrollView` is not built until `loadView()`, so anything
reading `controller.scrollView` at coordinator-install time gets nil. The editor pushes
`session.requestGutterAttach` one run-loop hop later instead. Retrying from `draw` alone
deadlocks: an unattached gutter never redraws.

---

## W1 as built — deviations from the plan below

**1. There is no gutter checkbox column.** W1.2 specified one; it was built, shipped,
and removed after one look. A permanently reserved tick box cost 26pt on *every* row for
something used occasionally. **Line selection is the editor's own text selection** —
select in the text, or click/drag in the gutter to take whole lines, and `⌘⏎` stages
exactly that (still falling back to the cursor's hunk when nothing is selected).
`session.selectedLines` is derived from `editorState.cursorPositions` in
`EditorHost.onChange`; multi-cursor selections union, so a non-contiguous pick still
works. Selected rows tint in the gutter so the two surfaces agree.

Cost of that choice: the selection lives in the text view, so it clears when you click
elsewhere — you cannot build one up across a long scroll the way ticks allowed. If that
bites, add a pin-selection toggle rather than bringing the column back.

**1b. One line-number column, not two.** Old|new side by side is identical on context
lines — most of any diff — so every number stuttered. The gutter shows the new-side
number, or the old on a removal; the sign column already disambiguates. Width went from
~138pt to ~66pt.

**2. Workbench shortcuts are declared in the view, not the menu bar.** A menu key
equivalent beats the key window's responder chain, so binding ⌥↓ / ⌘⏎ / ⌘K globally
would steal them from the terminal whenever the workbench is closed. They live in
`WorkbenchView.keyBindings` and exist exactly as long as the view does; `ShortcutCatalog`
carries them as display-only rows (`key: nil`, category `.workbench`) so ⌘/ still lists
them, and `ShortcutActions` `break`s on all seven. Also `⌘⇧⏎` was already zoom-pane, so
unstage is **`⌘⌥⏎`**. Scope is ⌃1/⌃2 (two scopes exist); ⌃3/⌃4 arrive with W3/W4.

**3. Threads are a right-hand column, not cards under their lines.** Same reason
comments are in the rail: `WidgetLayer` anchoring is unbuilt. `WorkbenchThreadsPanel`
is 340px, toggled from a header button showing the unresolved count, and a thread's
`line N` button jumps the editor there — which is what an anchored card would have
given. It rides `session.requestScroll`, installed by the editor's coordinator, because
`SourceEditorState.cursorPositions` is never applied upstream (`SourceEditor.swift:161`
compares `state.cursorPositions != state.cursorPositions`).

**4. Clicking a file in the rail *scopes* the editor to it; it does not scroll to it.**
`session.focus(file:)` rebuilds the stitched document from `displayedFiles`. Scrolling a
287-file multibuffer to a file is indistinguishable from nothing happening — you land
mid-document with the same wall of text around you. Clicking the focused file again, the
header chip, or the "All N files" row restores the full diff. **`rowOrigins` and staging
selections are built from `displayedFiles`, not `files`** — otherwise hunk indices point
at the wrong file the moment a file is focused. A focus that falls out of the diff on
reload clears itself.

Focusing is also the current answer to scale: one file is a few hundred rows instead of
32,000. The whole-diff view remains the heavy path.

**5. The rail has three sections, not two.** STAGED / UNSTAGED / **COMMITTED**. Splitting
on `git diff --cached` alone labelled all 287 already-committed files "unstaged" in
vs-base mode, and `git add` on a committed file exits 0 having moved nothing — a button
that ran, reported success, and changed no count. `session.unstagedPaths` reads
`git diff --name-only` plus untracked; committed rows carry no stage button, and `⌘⏎`
over them says so instead of letting git reject the patch.

**Known limitation — partial staging on an already-staged file.** The displayed diff is
`HEAD`-based, so `git apply --cached` can reject a synthesized patch when the index
already differs from HEAD for that file. Git's stderr surfaces in `session.lastError`
rather than failing silently. The real fix is what magit/lazygit do: read the unstaged
diff (`git diff`, index-based) for staging and the staged diff (`git diff --cached`) for
unstaging, instead of one `HEAD`-based diff for both. That is a `DiffReader` change, so
it's recorded here rather than smuggled into W2. The three-way rail split above is the
cheap half of the same problem.

---

## What the first live run cost

Eleven defects in one sitting on a 287-file / 32k-row vs-base diff. Recorded because the
*pattern* predicts where W2–W5 will break, not for the war stories.

**Nothing was cheap per-frame.** `EditorHost` rebuilt `MultiHighlighter` and
`BlockRenderer` on every `body` evaluation, and `SourceEditor` compares highlight
providers by `ObjectIdentifier` — so every scroll tick read as a provider change and
re-ran `setHighlightProviders` (dropping every cached parse) plus `reloadUI()`. Both now
live on the session, built once. The gutter materialised 32k `GutterRow`s per scroll tick
and walked all of them per draw; it now pulls only the dirty rect's rows. **Anything an
`NSViewRepresentable` constructs in `body` is constructed per frame.**

**Nothing was lazy that touched the filesystem.** `SourceBuffer.init` ran `git show` per
file — 287 process spawns on the main thread — for a `baseText` nothing read. Buffers and
their `DispatchSource` watchers were created for every changed file up front. Both are
now on demand. Word-diff pairing rebuilt both side arrays per line, so a 1000-line hunk
did ~1M array appends. Disk-triggered reloads now coalesce (an agent saving five files
fired five full tree diffs).

**Two independent bugs made highlighting look "wack", and both were mapping errors.** The
highlighter asked `StitchMap` for a row's source line, but `Excerpt.lineRange` holds
*stitched* indices — a hunk interleaves both sides, so it is not a contiguous range in
either file — and the numbers were 1-based against a 0-based table. Rows now carry a real
`sourceAnchor(atStitchedLine:)` → `(file, side, 0-based line)` from the gutter's own
numbers, and **a removed row is highlighted from the base blob**, not the working copy.
Separately, `WordDiff` pairing matched the *n*th removal with the *n*th addition anywhere
in the hunk whenever totals matched, tinting words that never changed; `HunkPairing`
pairs adjacent runs only, at equal length (+8 tests).

**The lesson for W2+.** Every one of these is invisible to `xcodebuild` and to 357 green
unit tests — they are all coordinate mappings, object lifetimes, or per-frame cost. W2's
edit write-back (`StitchMap` → `SourceBuffer.replaceText`) and W3's conflict regions are
the same class of coordinate mapping as the highlighter bug above. **Run each slice on a
big real diff before calling it done**, and prefer a logged probe over a second guess —
three of the scroll fixes here were wrong guesses that a five-minute probe settled
immediately.

---

## W1 — Review & staging (as planned; kept for the record)

Done: `PatchSynth` (+15 tests), `GitStaging`, comment composer/bubble restored.

### W1.1 Staging state on the session

**Files:** modify `Sources/Workbench/WorkbenchSession.swift`

- Add `@Published private(set) var stagedPaths: Set<String>`, refreshed from
  `GitStaging.stagedPaths(cwd:)` after every index write and at the end of `load()`.
- Add `@Published var selectedLines: Set<Int>` — stitched line indices the user has
  ticked. Clear on rebuild.
- Add `stage(lines:)` / `unstage(lines:)`: group selected stitched lines back to
  `(file, hunkIndex, lineIndexWithinHunk)` via `stitchMap` + the same walk `rebuild()`
  uses, build `[HunkSelection]`, call `PatchSynth.patch(...)`, then
  `GitStaging.applyToIndex(patch:cwd:reverse:)` **off the main thread**, then `load()`.
- Surface failures: add `@Published var lastError: String?` set from
  `GitResult.errorText`. The whole point of `GitResult` is that a rejected patch says why.

**Test (pure part only):** the stitched-line → `HunkSelection` grouping. Extract it as a
`static func selections(forStitchedLines:in:)` on a pure type so `ShepherdModelTests` can
cover it — that mapping is where the bugs will be, and it's the one part of W1.1 that
isn't `Process` work.

### W1.2 Gutter checkboxes — ~~built~~ **superseded, do not implement**

Shipped, then removed after one live look; selection replaced it (see deviation 1).

**Files:** modify `Sources/Workbench/EditorHost.swift`

`DiffGutterView` already draws the checkbox column and reports clicks via
`onToggleStage`. Wire it:

- In `WorkbenchGutter.updateNSView`, set `staged:` to `session.stagedPaths.contains(path)`
  for the row's file — but only for rows whose line is `.added`/`.removed`; context rows
  stay `nil` (not stageable).
- Set `view.onToggleStage = { idx in session.toggleStage(stitchedLine: idx) }`.

### W1.3 Rail: staged/unstaged split + commit box

**Files:** modify `Sources/Workbench/WorkbenchView.swift`

- Split `groupedFiles` into `UNSTAGED` and `STAGED` sections (directory grouping stays
  inside each), driven by `session.stagedPaths`.
- Commit box pinned at the rail's bottom: a `TextEditor` bound to
  `@Published var commitDraft: String` on the session, plus **Commit** and **Commit &
  Push** buttons. Disable both unless `!session.stagedPaths.isEmpty` and the draft is
  non-empty; disable push with a reason when `GitStaging.upstream(cwd:)` is nil and no
  branch exists (detached HEAD) — a disabled button *with a reason*, never a dead one.
- Show `session.lastError` as an inline error row in the rail, not a toast.

### W1.4 Port `GitHubThreadView`

**Files:** create `Sources/Workbench/WorkbenchThreads.swift`

Recover it from git history — it was deleted with the panel:
`git show d8ad405^:spike/seam1/Sources/DiffPanelView.swift`. Port `GitHubThreadView`
(violet rail + octocat, author/time header, stacked replies, Reply / Resolve /
Send-to-agent) and `ThreadReplyComposer` essentially verbatim. Feed from
`store.reviewThreads[paneID]`, vs-base mode only. Threads whose line no longer maps go in
a per-file "N not on the current diff" disclosure, as before.

### W1.5 Shortcuts

**Files:** modify `Sources/ShortcutCatalog.swift`, `Sources/ShepherdApp.swift`

Add and route: `⌥↓`/`⌥↑` next/prev hunk, `⌘⏎`/`⌘⇧⏎` stage/unstage hunk, `⌘K` focus commit
box, `⌘⇧C` comment (already wired locally in the view — move it to the catalog so the menu
and `⌘/` cheatsheet pick it up), `⌃1`–`⌃4` scope. **Not** `⌘1`–`⌘9` (tab jump) and **not**
`⌥`+digit (types `¡™£¢` into an editable buffer). `ShortcutActions.run(_:)` is an
exhaustive switch — every new `ShortcutID` needs a case.

---

## W2 — Editing in anger

> **The editor is `isEditable: false` right now.** W0 shipped it editable, but nothing
> maps typed text back to a `SourceBuffer` — and `rowStyles` / `gutterRows` /
> `rowOrigins` are all indexed by stitched line, so one typed newline shifts every row
> after it and silently corrupts the gutter numbers, tints, and staging targets. It was
> turned off rather than left as a footgun. Selection is unaffected (`isSelectable` is
> independent), so staging still works.

### W2.0 — deleted lines must become blocks *before* write-back is possible

**The current document cannot be edited, and no amount of bookkeeping fixes that.**
`rebuild()` emits every diff line as a text row, removals included — so the buffer is a
unified interleaved diff. A removed row corresponds to no position in any file on disk,
so there is nowhere to write an edit to it back to. Keeping the row tables in step with
typing (the obvious first instinct) solves the wrong problem.

The spec already anticipated this and W0 half-built it. `BlockKind.deletedLines(source:
lines:startingOldLine:)` exists, and its own comment says *"Removed lines, rendered as a
block because they exist in no current file."* Nothing emits it — `rebuild()` only ever
appends `.fileHeader` blocks, and `BlockMap` is built and then never rendered.

**So W2 starts here:** the text buffer becomes **new-side only** (added + context), and
each run of removals becomes a `.deletedLines` block anchored at the row that follows it.
What that unlocks, all of it currently blocked:

- Every text row is a real line in the working file, so write-back is a direct mapping
  and `StitchMap.applyEdit` works as designed.
- `sourceAnchor` is always `.new`; the base-blob highlight path becomes block-only.
- The gutter's single number column is exactly right by construction.
- `BlockMap` gets its first real consumer, ahead of W3's conflict controls and ADR 0019's
  rendered markdown — both of which are block kinds waiting on the same mechanism.

**The unproven part is rendering a block row**, since W0 never drew one. Confirmed
feasible: `TextLayoutManager+Layout` takes a line's height from the fragments that
`prepareForDisplay` builds, and a render delegate overriding `prepareForDisplay` controls
them — so `BlockRenderer` can inflate the row that a block sits above and have
`DiffRowView` draw the removed lines in that space. That is what `Block.height` and
`BlockMap.totalHeight(aboveStitchedLine:)` were shaped for. Prove this on one file before
building the rest of W2 on it.

**Knock-on:** staging currently selects removed rows as text (`PatchSynth` needs them).
Once they are blocks, a removal is staged via its block, not a text selection — plan the
interaction before converting, or hunk-level staging silently loses the ability to stage
a deletion.

- **File finder (`⌘P`)**: fuzzy-match repo files; opening one appends a `.context`
  excerpt covering the whole file to `StitchMap` and rebuilds. This is where `StitchMap`
  stops being diff-only.
- **Save**: `⌘S` → `SourceBuffer.save()`. Dirty markers already render in the rail.
- **Reconciliation UI**: `SourceBuffer.needsReconciliation` is already published and the
  rail already shows "changed on disk". Add the three actions on the file header block:
  keep mine (`save()`), take theirs (`apply(.userDiscarded)`), merge (open the W3
  resolver on that file).
- **Edit write-back**: the editor mutates `session.storage` directly today, but nothing
  maps those edits back to `SourceBuffer`s. Add a `TextViewCoordinator` implementing
  `textViewDidChangeText`, map the changed range to `(source, lineRange)`, and call
  `SourceBuffer.replaceText`. **This is the largest single piece of W2** and the point at
  which the buffer becomes genuinely editable rather than editable-looking.
  **Map through `sourceAnchor(atStitchedLine:)`, not `StitchMap`** — excerpt line ranges
  are stitched coordinates, which is exactly the bug that mangled highlighting (see "What
  the first live run cost"). `StitchMap.sourceLocation` is misleading for hunk excerpts;
  consider deleting or renaming it before it catches a third caller.
- **Branch + worktree ops**: reuse `WorktreeService` / `WorktreeArchive`; a branch menu in
  the header, "new worktree tab from here" wired to the existing flow.

## W3 — Merge resolver

- **`ConflictParse`** (pure, tested): `git ls-files -u` → `(base, ours, theirs)` stage
  triples; blobs via `git show :1:/:2:/:3:`. **Never** scrape `<<<<<<<` markers.
- Conflicted files become `.conflict` excerpts; `BlockKind.conflictControls` already
  exists — render accept ours / theirs / both (either order) / edit.
- Resolving writes the worktree file then `git add`s, **only** on explicit resolve.
- Auto-resolved regions stay **silent** — VSCode's known flaw is highlighting and
  pre-checking them.
- Scope row `Conflicts (n)`, auto-selected when the repo is mid-merge.

## W4 — PR surface

- Header PR band: checks rollup, mergeability, review decision — from the existing
  `PRStatus` / `PRThreads` and `store.prStatuses[paneID]`. All gated on `GH.isInstalled`.
- Expandable checks list; click through to the run.
- Actions via `gh`: approve, request changes, merge (respecting `mergeStateStatus`).
- Scope row `Threads (n)` for W1.4's threads.

## W5 — History & power tools (last; blocks nothing)

Roughly the size of W1–W4 combined. Do it as its own spec.

- `Commits (n)` scope — **not present before W5**; the rail must not reserve space for it.
- Commit list + graph renderer; any commit viewable as a diff in the same multibuffer.
- Blame gutter — extends `DiffGutterView` with a column, which is why it was built as a
  sibling view rather than a fork of CESE's. It is now a **one**-number-column gutter, and
  every row already has real layout geometry to hang a blame column off.
- Stash, cherry-pick, interactive rebase (reorderable todo). Rebase conflicts recurse
  into W3 mid-sequence — design that seam before starting.

---

## Deferred, recorded so it isn't lost

- **Side-by-side diff.** W0 ships inline only. Needs two synchronized multibuffers and
  each row knowing its side — depends on W1's staging model.
- **`WidgetLayer`.** Comments live in the rail because anchoring overlays via
  `rectsFor(range:)` during scroll is unbuilt. W1.4's threads will want it too.
- **Excerpt virtualization.** Spec §9: N live tree-sitter parses on a 50-file diff.
  `SourceHighlightCache` is deliberately separate so it can be swapped. **Now the top
  outstanding perf item** — the whole-diff view still stitches every hunk of every file
  into one 32k-row document. Parses and `SourceBuffer`s are lazy, so only painted files
  cost anything, but the document itself is built eagerly. Focusing a file (deviation 4)
  is the stopgap.
- **Per-line staged state in working-tree mode.** `git diff HEAD` shows staged ∪
  unstaged with no way to tell which a line is. Needs a second index-based diff
  correlated by line — the same `DiffReader` change as the partial-staging limitation.
- **Block-map performance.** Untested under load; Zed had to profile theirs. Nothing
  emits block rows yet, so the gutter's variable-height path is also unexercised.
- **Workbench as a `Pane.kind`** instead of a takeover, so it can sit beside a live
  terminal. `Pane.provisioning`/`stowing` are the precedent for a non-PTY pane.
- **Rendered-markdown rehosting.** `MarkdownDiffView` still renders standalone;
  `BlockKind.renderedMarkdown` exists but nothing emits it yet. ADR 0019 stands.
