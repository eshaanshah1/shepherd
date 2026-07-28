# Unified Workbench W1–W5 Roadmap

> **Continuation doc.** This file carries the remaining work in executable order so a
> fresh session resumes without re-deriving anything. Spec:
> `docs/superpowers/specs/2026-07-26-unified-workbench-design.md`. W0 plan (read its
> Task 1 postmortem first): `2026-07-26-unified-workbench-w0.md`.

## Progress

Last updated 2026-07-27 · branch `workbench-w3-merge-resolver` · 545 model tests, 0 failures

```
W0  editor foundation      ██████████████████████  100%   run + hardened
W1  review & staging       ██████████████████████  100%   run + hardened
W2  editing in anger       ██████████████████████  100%   W2.0/W2.1 + write-back live-run
W3  merge resolver         ██████████████████████  100%   run + reshaped from that run
W4  PR surface             ██████████████████████  100%   band, checks, gh actions, threads
W5  history & power tools  ░░░░░░░░░░░░░░░░░░░░░░    0%   own spec; ~= W1–W4 combined
                           ──────────────────────
    overall                ██████████████████░░░░   84%
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
works. Selected rows **used to** tint in the gutter so the two surfaces agreed; that was
removed after the W2.0 live run — dragging in the text lit up the line numbers with it,
which reads as though the gutter is being dragged too. The text selection is its own
feedback.

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

### W2.0 — deleted lines became blocks — **DONE**

> The gate for everything else in W2. Kept in full because the *shape* of the solution is
> what the remaining tasks build on.

**Why it had to come first.** `rebuild()` emitted every diff line as a text row, removals
included, so the buffer was a unified interleaved diff. A removed row corresponds to no
position in any file on disk, so there was nowhere to write an edit to it back to. Keeping
the row tables in step with typing — the obvious first instinct — solves the wrong problem.

**What shipped.** The text buffer is **new-side only** (added + context + gap-revealed
context); each run of removals is a `.deletedLines` block anchored on the row it sits
above. Concretely:

- **`RowPlan.swift` (pure, 20 tests) is now the single authority on the document layout** —
  which diff line each row shows, and where every band (header, gap, deletion) goes. It was
  an inline walk in `rebuild()` plus a second walk in `StageSelection` that only tests
  called, so the tested walk and the real one could disagree about what a row index means.
  That is the exact class of bug that mangled highlighting on the first live run. `rebuild()`
  now only materializes the text and styles the plan implies.
- **`RowOrigin` absorbed the gutter numbers** (`gutterRows` is gone — three parallel
  per-row arrays are down to two) and gained `deletedRefs`.
- **Deletion bands render as code**: base-blob syntax colours (`MultiHighlighter
  .baseHighlights`, parsed lazily per band and cached on the session), the removed tint, and
  word-diff spans; the gutter draws each band line's old number and `-`.
- `sourceAnchor` is always `.new` by construction, and the gutter's single number column is
  right for free.

**The selection knock-on, resolved as planned.** A band belongs to the row it abuts, so
selecting that row selects its removals too and `⌘⏎` still stages a whole hunk rather than
silently staging only its additions. Two edges the plan didn't name:

- A run at the **end of a hunk** has no following row of its own, so it draws above whatever
  comes next but is owned by the hunk's **last** row — the only row that can carry it into a
  patch. When that "whatever comes next" is the end of the document, the band is hosted by
  the zero-length trailing line the editor appends for a document ending in a newline
  (`TextLineStorage.buildFromTextStorage`); `gutterRowCount` counts it so the gutter still
  draws its numbers.
- A hunk that is **nothing but removals** (a deleted file) has no row at all, so its band
  exists and is visible but no row can own it: whole-file staging only, which the rail's
  button already does.

**Two bugs found on the way, both pre-existing:**

- The gap computation built `(prev.newStart - 1 + prev.newCount)..<(hunk.newStart - 1)` with
  **no clamp**. Real `git diff` output is ascending so it never fired, but nothing in the
  model enforces that and an inverted `Range` **traps** — it would have taken the whole app
  down. Found because a test fixture with unrealistic hunk numbering crashed the test runner.
- `anchor(atStitchedLine:)` resolved a row through `StitchMap.locate`, which finds an excerpt
  by **summing excerpt lengths** — so it stopped matching the document the moment a hunk gap
  was expanded (those rows belong to no excerpt), and review comments would have anchored to
  the wrong file. It reads `rowOrigins` now.

**Block rendering itself was proven earlier** on the `.fileHeader` blocks. Three things
mattered, all recorded as gotchas in `CLAUDE.md`: pair fragment mutation with
`lineFragments.update(...)` (it is a sum tree); grow **both** `height` and `scaledHeight` so
the text lands below the band rather than centred in it; and widen the fragment view, which
is otherwise only as wide as its text.

**Deliberately deferred, so it isn't mistaken for done:**

- **Staging one removed line out of a run.** The row owns the whole band, so `⌘⏎` takes all
  of it. `PatchSynth` supports finer than that; only the row→selection mapping doesn't.
- **Commenting on a removed line.** No row means no anchor, so `⌘⇧C` reaches new-side lines
  only. A GitHub thread on a removed line still *resolves* — `stitchedLine(forFile:line:
  side:)` maps an old-side line to the row owning the band that shows it, so jumping to the
  thread still puts the deleted line on screen.
- **Selecting or copying a removed line.** The biggest live-run finding that is *not* a bug:
  a band is not text, so the editor cannot select it. Dragging across a hunk visibly steps
  over the deletion band, and **`⌘C` no longer yields removed lines at all** — a regression
  from before W2.0, when they were real rows. The honest fix is copy support first
  (reconstruct a band's text for a selection that spans it, off `rowOrigins` + `blockMap`),
  and only then tint the band as selected so the continuity isn't lying about what you'd
  get. Tinting alone would look right and copy nothing.
- **Word-diff tint contrast.** `wordAdd` (`0x2B5B33`) / `wordDel` (`0x6E2B28`) are dark fills
  at 55% alpha. They read behind plain identifier text and disappear behind a bright
  string-literal colour, so one changed word in a line can look highlighted while another
  doesn't. Pre-existing W0 palette, unchanged by W2.0; the span geometry itself was verified
  exact (measured vs arithmetic drift 0.00pt in JetBrainsMono NF).
- **`git show` from `draw`.** A band's colours are parsed on first paint, which reads the
  base blob — a `Process` on the main thread. Same cost the removed-row highlight path
  already paid, and cached after, but it belongs off-main with a redraw callback.
- **`StitchMap.locate` is still misleading** and now has **no live callers**. `Excerpt
  .lineRange` holds absolute row spans, which is not what `locate`/`sourceLocation`/
  `stitchedLine(for:)` assume. Fix or delete it before W2's `⌘P` file finder makes it
  load-bearing — that is the third caller the last note warned about.
- Caret and selection rects use the fragment's full inflated height, so a row carrying a
  band gets a tall caret. Cosmetic, and worse now that bands can be tall.

**Run on a real diff** against a fixture repo built to hit every shape at once: two hunks far
apart (gap band), a 40-line deletion run, a whole-file delete, removals at EOF of the last
file, and an added file. Verified two ways — a headless harness over the real `DiffParser` +
`RowPlanner` asserting the invariants (excerpts tile every row; no row is a removal; row
numbers agree with their excerpt; every removed line is owned by a row or in an all-removal
hunk), with **`git apply --cached --check` judging every synthesized patch**; then visually in
`ShepherdDev`. It found three defects, none of which 413 green unit tests could have caught:

1. **A tall band drew only its first 30 rows.** Clipping block drawing to `dirtyRect` is
   unsound for a fragment ~1000pt tall — see the `visibleRect` gotcha in `CLAUDE.md`.
2. **`DiffParser.parseHunkRanges` scanned the whole hunk header**, so the section heading git
   appends re-parsed the ranges: `->` in a Swift signature starts with `-`, so `oldStart`
   became 0. **This broke `⌘⏎` hunk staging for most hunks in a Swift file** — `PatchSynth`
   emitted `@@ -0,7` and `git apply` rejected it. Confirmed both ways: git accepts the fixed
   patches and rejects the pre-fix form. Pre-existing, shipped since W1.
3. **The trailing `""` from splitting `git diff` output became a blank context line**, so the
   last hunk of every diff carried a phantom row one line past the end of the file — with a
   line number that doesn't exist, and an extra context line in any patch built from that
   hunk. It also masked the document-trailing-band case, which now genuinely exercises the
   editor's zero-length trailing line.

### W2.1 — hunk gaps: "N lines skipped" + expand — **DONE**

A `.hunkGap` band between consecutive hunks of a file carries the skipped count, and the
gutter carries GitHub-style expand-down / expand-up / expand-all arrows (`HunkGaps`, pure +
tested; the arrows live in the gutter because `TextView.hitTest` swallows clicks aimed at a
line-fragment subview). Revealed lines are tracked per file as a **set** of 0-based new-side
lines, so two expansions meeting in the middle merge for free, and `RowPlanner` emits them
as ordinary context rows read out of the working copy.

It did **not** end up going through `ExcerptKind.context` as planned — revealing is a row
concern, and rows come from `RowPlanner`, not from `StitchMap`. `⌘P` opening a whole file
into the buffer is still the move that will need `.context` excerpts, and it is still
unemitted.

### W2.2 — the rest of "editing in anger" — **DONE**

**Verified in real use:** typing/editing with write-back, `⌘S` to disk, `⌘P`. **Not yet
exercised** — secondary, verify when convenient: reconcile's Keep mine / Take theirs, branch
switching (incl. its refusal while dirty), and the inline review notes.

**What the live run found (fixed):** edit a line, `⌘G` out, `⌘G` back, and the line went
read-only. The session and its dirty `SourceBuffer` survive the close, but reopening runs
`load()` → `rebuild()`, which materialized every row from the **diff** — and the diff
describes disk. The document silently reverted to the saved text while the buffer still held
the edit, so `canApplyEdit`'s staleness guard correctly refused every further edit to those
lines. Rows of a file in `dirtyPaths` now read from the buffer; see the gotcha in `CLAUDE.md`
and the remaining stale-hunk-boundary caveat there.

**A fixture that hits every band shape at once** — worth rebuilding rather than re-deriving.
A git repo with: a 200-line file modified at line 5 **and** ~line 170 (two hunks with a
158-line gap ⇒ gap band + expand, and word-diff inside a modified line); a file whose middle
40 lines are deleted (a tall deletion band, which is what caught the `dirtyRect` clipping
bug); a file deleted outright (all-removal hunk, no owning row); a file whose **last** lines
are deleted and which sorts **last** (the document-trailing band, hosted by the editor's
zero-length trailing line); and an untracked file sorting first as an all-additions control.
`git diff HEAD | <driver>` over `DiffParser` + `RowPlanner`, with `git apply --cached --check`
judging every synthesized patch, is what surfaced the two parser bugs below.

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
  which the buffer becomes genuinely editable rather than editable-looking. W2.0 cleared
  the way: every row is a real new-side line, so the mapping is direct.
  **Map through `sourceAnchor(atStitchedLine:)`, not `StitchMap`** — excerpt line ranges
  are row spans, which is exactly the bug that mangled highlighting (see "What the first
  live run cost") and, separately, what `anchor()` was quietly doing until W2.0.
  `StitchMap`'s `locate`-based lookups now have **no callers at all**; fix or delete them
  here rather than letting `⌘P` become the third victim.
  The other half of this task is the row tables: `rowStyles` / `rowOrigins` are indexed by
  row, so a typed newline shifts everything below it. `BlockMap.shift(fromStitchedLine:by:)`
  and `StitchMap.applyEdit` exist for exactly this and are both still unexercised.
- **Branch + worktree ops**: reuse `WorktreeService` / `WorktreeArchive`; a branch menu in
  the header, "new worktree tab from here" wired to the existing flow.

## W3 — Merge resolver — **DONE**

Spec: [`2026-07-27-workbench-w3-merge-resolver-design.md`](../specs/2026-07-27-workbench-w3-merge-resolver-design.md).

**What shipped.** `Diff3.merge` over two `SequenceAlign.lcs` runs against the index's
stage blobs (`ConflictParse` + `ConflictReader`), `RowPlanner.planConflicts`, the accept
controls on a new hit-testable overlay, and a Files scope that carries conflicts. Never
scrapes markers — but *draws* them, which is a distinction worth keeping straight (below).

**Four deviations from the design doc**, all found by building or running it:

1. **Whole-file conflicts produce no rows and no write.** Binary, delete/modify and
   add/add-with-a-binary-side have no line list; reconstructing one so it could flow
   through the normal write path would make the fabrication real. They resolve through
   `WholeFileResolve` → `git checkout --ours/--theirs` / `git rm`, from the rail. §1 of
   the spec had them rendering through the same band machinery.
2. **Both sides show at once, delimited by markers.** The spec's chosen-design was
   chosen-side-as-rows with the other behind a band. Live, that means deciding with half
   the information off screen. Now: `<<<<<<< main` / `=======` / `>>>>>>> feature`, each
   side tinted, each marker in its block's colour; picking a side collapses the region and
   drops the markers. **The markers are bands, never rows** — the document is what
   `Resolve` writes, so a marker that was a text row could reach a file.
3. **No separate Conflicts scope.** Folded into Files. A file you have to fix is still a
   file, and a second tab put the most urgent thing one click out of sight.
4. **`MergeOutput` splits into `preview` and `text`.** The buffer must render before any
   decision; the write must refuse until every one is made. `text` is `preview` joined plus
   the all-decided guard, so the two cannot disagree about content.

**The integration test earned its keep on the first run.** Git 2.55 writes no
`rebase-merge/onto_name` for a plain `git rebase main` — only the interactive and `--onto`
paths do — so the "ours" label fell through to `onto`, a bare sha, and the button that
discards one side of a rebase was labelled with forty hex characters. Unit tests could not
have found it; only real git knows what files it writes. `ConflictIntegrationTests` builds
real repos mid-real-merge and covers content conflicts, a one-sided change staying silent
beside a conflicting one, resolution producing a file git accepts as merged, delete/modify
both ways, add/add, binary, unicode/spaced paths, and rebase side inversion.

**The rebase inversion is the thing to not "fix" later.** Mid-rebase git checks out the
upstream and replays your commits onto it, so stage 2 — git's "ours" — is the branch you
are rebasing *onto*, and stage 3 is your own work. Every label is a ref name for that
reason, and a test asserts the side labelled `main` carries main's content.

**Four UI defects the live run found**, none visible to `xcodebuild` or 545 green tests:

- The keep-both buttons were `Both` and `Both ⇅` — an arrow carrying the entire meaning of
  "reversed order". This plan had already rejected gutter glyphs because "`b` vs `B` is not
  discoverable"; the same defect shipped in a nicer font. Now `Both (current first)` /
  `Both (incoming first)`, fixed width, unlike concatenating two branch names.
- The scope pill forced equal-width segments. Fine at two, unreadable at five — 260pt split
  five ways is ~7 characters, so every label ellipsised at once. Wraps past three now.
- The vs-base segment read "vs base" until you visited it and "vs main" afterwards:
  `DiffReader` only resolved the base name in branch mode, so one segment's label depended
  on which segment you were standing on.
- A side band's label wore `Theme.Diff.hover` — the hunk-gap band's fill — so it read as
  unrelated chrome floating between two lines rather than a header for the run below it.

**`WorkbenchOverlay` is the `WidgetLayer` seed.** A transparent `NSView` over the text view
that draws *and* hit-tests the accept controls, returning nil from `hitTest` everywhere
else so selection and scrolling pass through. It exists because `TextView.hitTest` returns
the text view for any point inside it — the gap arrows answered that by moving to the
gutter and the reconcile row by moving to the rail, and neither works for four labelled
buttons. Written against "blocks with targets", not conflicts, so comments, threads and
W5's blame column can retire their rail-only placements onto it.

**Deferred, recorded so it isn't mistaken for done:**

- **In-place editing of a conflict region.** Conflicted files are read-only with a visible
  reason in the header (silent refusal is the W2.2 defect). Resolve, and the file becomes an
  ordinary editable one — the file is `git add`ed and drops out of `ls-files -u`.
- **Resolution choices do not survive closing the workbench.** In memory by design, so a
  half-triaged file is untouched on disk; the cost is losing the triage.
- **Word-level diff inside a conflict region.** The pairing rule for a three-way region is
  its own question.
- **Combined-diff (`@@@`) parsing** in `DiffParser`, so Working and vs-base are honest
  mid-merge. Pre-existing; they show a banner pointing at Files instead.
- **Rebase conflicts recursing mid-sequence**, which W5's interactive rebase needs.

## W4 — PR surface — **DONE**

Shipped in `WorkbenchPRBand` (it landed early, alongside the block-row work, which is why
the progress bar above under-reported it for a while):

- Header PR band: checks rollup chip, mergeability, review decision, all gated on
  `GH.isInstalled`. A merged/closed PR hides its review decision and checks — stale trivia.
- Expandable checks list, each row clicking through to its run when the payload carries a
  URL.
- Actions via `gh`: Approve, Request changes, and Merge with a squash/merge/rebase picker.
- Scope segment `Threads (n)`, in the segmented scope pill, shown only when threads exist.
- Review threads render **inline** under their line as violet `.reviewNote` bands as well as
  in the threads panel; local pending comments render the same way in blue. Distinguished by
  marker shape and label as well as colour.

## Files scope — the workbench as a plain editor

`⌃3`: no diff, no staging. Conflicted files at the top of the rail in red, then anything
opened with `⌘P`, edited and saved through W2.2's write-back. `displayedFiles` is empty in
this scope so the document is built from `openedPaths` plus the merge files, which
`RowPlanner`'s `opened:` path already handled.

The rail deliberately grows no file browser — `⌘P` already fuzzy-matches every file git
knows about, and a second worse one beside it would be two ways to do one thing.

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
- **Excerpt virtualization — measured, and NOT worth doing.** This was called the top
  outstanding perf item on the reasoning that the document is stitched eagerly. It was
  never measured. `WholeDiffCostTests` does: on a 287-file / 24k-row diff, in a **Debug**
  build, the whole eager build is **68ms** — parse 23ms, plan 28ms, stitch + styles 12ms,
  line starts 4ms. Once per load. Release is several times faster, and focusing one file
  is 0.3ms.

  Virtualizing would touch every row-indexed table in the workbench — `rowOrigins`,
  `rowStyles`, `lineStarts`, `blockMap`, the gutter, the overlay, `StageSelection` — which
  is precisely the class of change that has produced this project's worst bugs. Trading
  that for 68ms is a bad deal. If a big diff ever *feels* slow, measure again before
  reaching for this: the likely culprits are the editor laying out 24k lines or the memory
  held by ~9k blocks, not our build of the document. The per-frame cost that was real —
  `BlockMap`'s linear scans, hit three times per row per scroll event — is fixed.
- **Per-line staged state in working-tree mode.** `git diff HEAD` shows staged ∪
  unstaged with no way to tell which a line is. Needs a second index-based diff
  correlated by line — the same `DiffReader` change as the partial-staging limitation.
- **Block-map performance.** Untested under load; Zed had to profile theirs. Three kinds
  emit now (header / gap / deletion), so the gutter's variable-height path is exercised —
  but `blocks(beforeStitchedLine:)` and `totalHeight(above:)` are both **linear scans over
  every block**, called per row per draw. On a 287-file diff that is hundreds of blocks
  scanned per visible row. Index it by row before it shows up as scroll jank.
- **Tall deletion bands.** A 500-line deletion inflates one line fragment to 500 rows tall.
  Drawing is clipped to `visibleRect` so the cost is bounded, but the fragment view itself
  is that tall and stays mounted while any part of it is on screen.
- ~~**Workbench as a `Pane.kind`**~~ — **rejected 2026-07-28.** The workbench stays a
  full-window overlay. Don't revive this; it is a decision, not a backlog item.
- **Rendered-markdown rehosting.** `MarkdownDiffView` still renders standalone;
  `BlockKind.renderedMarkdown` exists but nothing emits it yet. ADR 0019 stands.
