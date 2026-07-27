# W3 — Merge resolver (and a plain file-editing scope)

> Design record for W3 of the unified workbench. Roadmap:
> [`2026-07-26-unified-workbench-w1-w5-roadmap.md`](../plans/2026-07-26-unified-workbench-w1-w5-roadmap.md).
> Workbench spec: [`2026-07-26-unified-workbench-design.md`](2026-07-26-unified-workbench-design.md).
> Branch `workbench-w3-merge-resolver`, off `b217241`.

## What this adds

A merge resolver inside the workbench: when the repo is mid-merge, mid-rebase or
mid-cherry-pick, a **Conflicts** scope lists the unmerged files, and each conflict region
renders inline with real clickable **accept** controls. Resolving is in-memory until a
file is fully decided, at which point the whole merged file is written and `git add`ed.

It also adds a **Files** scope — the workbench as a plain multi-file editor, no diff — which
is a small amount of new chrome over machinery W2.2 already built.

## The three decisions that shape everything

1. **Controls are real inline buttons**, via a new transparent overlay view over the text
   view. Not gutter glyphs, not rail-only buttons.
2. **Nothing touches disk until a file is fully resolved.** Per-region choices live on the
   session; the write is one whole-file write plus a `git add`.
3. **A region renders as: chosen side as text rows, other side as a band.** The buffer is a
   live, literal preview of what will be written.

Everything below follows from those.

---

## 1. Reading the conflict — `ConflictReader`

`git ls-files -u -z` yields `<mode> <sha> <stage>\t<path>` records. Group by path; the set
of stages present classifies the conflict, and the blobs come from `git show :1:<path>` /
`:2:` / `:3:`.

| stages present | kind | treatment |
|---|---|---|
| 1, 2, 3 | `.content` | diff3 |
| 2, 3 | `.addAdd` | diff3 with an empty base (every line conflicts, which is correct) |
| 1, 2 | `.deletedByThem` | whole-file choice |
| 1, 3 | `.deletedByUs` | whole-file choice |
| any blob undecodable as UTF-8 | `.binary` | whole-file choice |
| anything else | `.unknown` | whole-file choice, ours preselected |

A whole-file conflict has exactly one synthetic region spanning the file, offering **keep
ours** / **keep theirs**, where the deleted side is the empty document. It renders through
the same band machinery as a content conflict, so there is no second code path.

`ConflictReader` is `Process` work and runs off the main thread, like `DiffReader` and
`GitStaging`. It returns `[MergeFile]` plus the operation in flight.

### Side labels are ref names, not "ours"/"theirs"

The reader also reads which operation is in flight — `MERGE_HEAD`, `REBASE_HEAD`,
`CHERRY_PICK_HEAD` (via `git rev-parse --git-path`) — and resolves each side to a real name.

This is not cosmetic. **Mid-rebase, stage 2 is the branch you are rebasing onto and stage 3
is your own commit being replayed** — the opposite of what "ours" means to a person about to
click a button. Sides render as `master` / `my-feature`, with `ours` / `theirs` as a
subtitle so the mapping to git's vocabulary is still legible.

Rebase state also gives the banner its progress (`rebase-merge/msgnum`, `rebase-merge/end`).

---

## 2. `Diff3.swift` — the merge itself (pure, tested)

```swift
enum MergeRegion: Equatable {
    case stable([String])
    case conflict(base: [String], ours: [String], theirs: [String])
}

enum Diff3 {
    static func merge(base: [String], ours: [String], theirs: [String]) -> [MergeRegion]
}
```

Classic three-way diff3 over two `SequenceAlign.lcs` runs:

1. `lcs(base, ours)` and `lcs(base, theirs)` give, from their `.keep` ops, two maps from
   base index to the matching index on each side.
2. A base line is a **sync point** when both sides matched it *and* both matches are in step
   with the running cursors on those sides.
3. Maximal runs of sync points become `.stable`.
4. Each run between sync points is a triple of slices `(baseSlice, oursSlice, theirsSlice)`:
   - `oursSlice == baseSlice` → `.stable(theirsSlice)` — only theirs changed
   - `theirsSlice == baseSlice` → `.stable(oursSlice)` — only ours changed
   - `oursSlice == theirsSlice` → `.stable(oursSlice)` — both made the same change
   - otherwise → `.conflict(base:ours:theirs:)`
5. Adjacent `.stable` regions merge.

**Auto-resolved regions become `.stable` and render as ordinary unmarked context.** The
roadmap's "auto-resolved regions stay silent" requirement falls out of the algorithm rather
than being a rendering special case. VSCode's known flaw is highlighting and pre-checking
them; there is nothing here to pre-check.

### zdiff3-style trimming

Before emitting a `.conflict`, hoist leading and trailing lines common to *ours and theirs*
out into the surrounding stable regions. A shared line at the edge of a conflict is a change
both sides made identically, so it belongs in stable — and without this, a 40-line region
that genuinely differs on one line presents as a 40-line decision. Trimming runs on the
ours/theirs pair only, not against base.

### Never build a `Range` out of this arithmetic unclamped

Every slice bound in `Diff3` derives from two independent alignment walks, which is exactly
the shape that produced the inverted-`Range` trap in `RowPlanner`'s gap computation. An
inverted `Range` **traps** and takes the process down. Slices are taken with
`max(start, end)` clamps, and the tests include a fixture with out-of-order matches.

### The one honest risk: our diff3 is not git's

Computing our own merge means our conflict boundaries can differ from git's. Where all three
blobs agree, the output is identical by construction, and the one-side-changed rules match
git's. What can diverge is chunking — in principle we could auto-resolve a region git chose
to conflict on.

**Mitigation: a tripwire, not a workaround.** After reading a file, count `<<<<<<<` lines in
the worktree file and compare to our conflict count. A mismatch shows a warning row in the
rail naming the file. This is marker *counting* as a sanity check, not marker *scraping* as a
parse — the file is still never the source of truth for what the conflict is.

---

## 3. Model and resolution state

```swift
struct MergeConflict: Equatable, Identifiable {
    let id: String        // "<path>#<n>" — stable across reloads
    let index: Int        // 1-based, for "CONFLICT 2/5"
    let base: [String]
    let ours: [String]
    let theirs: [String]
}

enum Resolution: Equatable { case ours, theirs, bothOursFirst, bothTheirsFirst }

struct MergeFile: Equatable {
    let path: String
    let kind: ConflictKind
    let regions: [MergeRegion]
    let oursLabel: String
    let theirsLabel: String
}
```

On the session: `@Published private(set) var mergeFiles: [MergeFile]` and
`@Published private(set) var resolutions: [String: Resolution]`.

Conflict ids are `"<path>#<n>"` so choices survive a reload of the same conflict set. A
reload that changes a file's region count drops that file's choices, which is the safe
direction.

```swift
enum MergeSide: Equatable { case ours, theirs }

enum MergeOutput {
    /// What the buffer shows. Undecided regions fall back to `ours`, so there is always
    /// something to render and to anchor highlighting to.
    static func preview(regions: [MergeRegion], conflicts: [MergeConflict],
                        resolutions: [String: Resolution]) -> [String]

    /// What gets written. nil while any region is undecided — a partially decided file
    /// must never reach disk.
    static func text(regions: [MergeRegion], conflicts: [MergeConflict],
                     resolutions: [String: Resolution]) -> String?

    static func unresolved(conflicts: [MergeConflict],
                           resolutions: [String: Resolution]) -> [MergeConflict]
}
```

Both are pure and tested, and `text` is `preview` joined **plus** the all-decided guard — one
function decides what the merged file says, so the buffer cannot lie about the outcome. The
split exists only because the preview must render before any decision has been made, while
the write must refuse until every one has.

An undecided region previews as ours but is **not** styled as chosen: `conflictControls`
carries `resolution: Resolution?`, and `nil` renders as no segment selected. "Showing you
ours because you haven't picked" and "you picked ours" must not look the same.

### No "Edit region" control

The roadmap listed accept ours / theirs / both / **edit**. Edit is dropped from v1.

Resolving a file writes it and `git add`s it, which removes it from `git ls-files -u`; it
then reappears in Working-tree scope as an ordinary staged file that W2.2 already makes
fully editable, with write-back, `⌘S` and staging. Hand-editing is one resolve away, and a
half-working in-place editor for a buffer with no on-disk backing is worse than not having
one — a button that does nothing is worse than no button (the same call §7 of W2.2 made
about the reconcile row's third action).

---

## 4. Row planning

A separate entry point; `RowPlanner.plan(files:revealed:opened:)` is untouched.

```swift
static func planConflicts(_ files: [MergeFile],
                          resolutions: [String: Resolution]) -> RowPlan
```

Two new `PlannedBand` cases:

- `.conflictControls(path:conflictID:index:total:)`
- `.mergeSide(path:conflictID:side:lines:label:)` — the side *not* currently chosen

and one new field on `RowOrigin`:

```swift
var conflictID: String? = nil
```

Defaulted, so no existing `RowPlan` test or call site changes.

Rows for a conflicted file are the stable lines plus the chosen (or, while undecided,
defaulted) side's lines of each conflict, in order — that is, exactly
`MergeOutput.preview`. They carry:

- `lineIndex: -1` — never reaches `PatchSynth`, and `isStageable` is already false for it
- `kind: .context` — **no new `DiffLineKind` case**, so `PatchSynth`, `StageSelection`,
  `HighlightMap` and the gutter's sign column are all untouched
- `newLineNumber` = the 1-based line in the merge preview
- `conflictID` set on rows inside a conflict region, nil on stable rows

The conflict tint rides `rowStyles` and `GutterRow.tint` as `RowTint.conflict`, which already
exists in both the palette and the gutter and has never been used.

A `.mergeSide` band renders like a deletion band and divides **its own height** by its line
count in both `DiffRowView` and `DiffGutterView` — never `WorkbenchMetrics.rowHeight`. Its
gutter rows show `~` and no line number, because those lines exist in no file the user can
address. Its drawing is bounded by `visibleRect.union(dirtyRect)`, never `dirtyRect` alone;
a `mergeSide` band is exactly the tall-fragment shape that caught the clipping bug.

### Preview line numbers, and conflicted files are read-only

The gutter's numbers in a conflicted file are **merge-preview** numbers. They cannot be file
lines: the file on disk holds git's markers, so nothing in the preview is at the line number
the preview would claim.

Which means text editing must be refused in a conflicted file. `canApplyEdit` would refuse
it anyway — `documentMatchesFile` compares the document text against the file's and the
markers guarantee a mismatch — but it would refuse **silently**, and "the line went
read-only for no visible reason" is the exact defect W2.2's live run turned up.

So the refusal is explicit and labelled: the session short-circuits `canApplyEdit` for any
row whose file is in `mergeFiles`, and both the file header band and the rail row read
*conflicted — resolve to edit*.

---

## 5. Highlighting — generalize the cache key

`MultiHighlighter` currently caches by `(SourceID, DiffSide)` and `sourceAnchor` always
returns `.new` plus a line index into the file on disk. Mid-merge that file is the
marker-laden one, so every conflict row would be painted with some other line's colours —
the same class of mapping bug that mangled highlighting on the first live run, and the one
the roadmap explicitly warns W3 will re-encounter.

```swift
enum HighlightVariant: Hashable {
    case new                    // the working copy
    case old                    // the base blob
    case mergePreview           // the merged text this document *is*
    case mergeSide(MergeSide)   // a stage blob, for the not-chosen band
}
```

- `CacheKey` becomes `(SourceID, HighlightVariant)`.
- `anchor` returns a variant rather than a `DiffSide`.
- The text provider takes a variant; the session serves `.mergePreview` from the same
  `MergeOutput.preview` the document was built from, and `.mergeSide` from the stage blob.
- `invalidate(source:)` drops every variant for that source.
- Changing a resolution invalidates `.mergePreview` for that file only.

Conflict rows anchor to `.mergePreview` at their own preview line, so the mapping is correct
**by construction** — the highlighted text and the displayed text are the same string —
rather than by arithmetic that can drift. The existing diff path keeps behaving exactly as it
does today; the change is additive.

---

## 6. `WorkbenchOverlay` — the clickable band layer

A new `NSView` that makes band controls hit-testable. `TextView.hitTest` returns the text
view for any point inside it, so a line-fragment subview never receives a click — which is
why the hunk-gap arrows went to the gutter and the reconcile actions went to the rail. The
gutter is 66pt wide and four labelled buttons do not fit in it.

**Placement.** Added as a subview of `controller.scrollView` — *not* `documentView`, and not
a SwiftUI `.overlay` — from the `onReady` hop in `EditorHost` that already installs the
gutter attach, the line-metrics closures and the scroll hook. Being a sibling of the clip
view means it does not scroll with content and must track scroll itself, which is the gutter's
proven arrangement rather than a new one. `onReady` fires on every editor remount, so
re-attachment after a rebuild is free.

It obeys every rule the gutter learned the hard way:

- tracks scroll via the clip view's `boundsDidChangeNotification`, **never**
  `SourceEditorState.scrollPosition`, which lands a run-loop pass late
- re-attaches on every rebuild with **no** "already attached" short-circuit; only
  `attach(to:)` no-ops, and only when the clip view is genuinely unchanged
- `clipsToBounds = true` (it defaults to `false` since macOS 14, and rows are placed at
  `yPos - scrollY`)
- gets row geometry from `session.editorLineMetrics` — the same layout-manager query the
  gutter uses, so there is exactly **one** opinion about where a line sits
- bounds its per-draw walk to the visible rect, the way `DiffGutterView.visibleRange` does
- draws its controls rather than hosting `NSButton`s, so scrolling causes no view churn
- `hitTest(_:)` returns `nil` for every point outside a control rect, so text selection,
  clicks, drags and scroll wheel all pass through untouched
- control rects come from one layout function used by both `draw` and `hitTest`, so drawing
  and hit testing cannot disagree (the rule `DiffGutterView.expandTargets` established)

Hover state comes from a tracking area; the hovered control redraws only its own rect.

The view is written generically over "blocks that want hit targets" — it asks the session
for `[(rect, action)]` for the visible blocks — but W3 wires only `conflictControls`. **This
is the `WidgetLayer` seed** the spec defers and that comments, threads and W5's blame column
all want; keeping it generic now costs nothing and stops the next feature forking it.

### `BlockKind.conflictControls` changes shape

It exists today as `case conflictControls(SourceID)` and has never been emitted; its only
references are `BlockKind.source` and a `default:` arm in two switches. It becomes:

```swift
case conflictControls(source: SourceID, conflictID: String, index: Int, total: Int,
                      resolution: Resolution?, oursLabel: String, theirsLabel: String)
```

and a sibling `case mergeSide(source: SourceID, conflictID: String, side: MergeSide,
lines: [String], label: String)` joins it.

---

## 7. Chrome

**Scope.** `WorkbenchScope.conflicts`, keyed `⌃3`. The segment appears only when unmerged
entries exist — the same rule the Threads segment uses, so no branch carries a permanent
dead "Conflicts 0" segment — and is auto-selected when the workbench opens mid-operation.
`WorkbenchScope.mode` is a trap here and must change shape. It is
`self == .workingTree ? .workingTree : .branchVsBase` today, so adding cases silently maps
both new scopes to `.branchVsBase` — and `WorkbenchView`'s `.onChange(of: session.mode)`
would then fire a full `git diff` every time you entered Conflicts or Files. `mode` becomes
`DiffMode?`, nil for the scopes that are not a git comparison, and `setScope` only touches
`mode` when the next scope has one. Conflicts drives `loadConflicts()`; Files loads nothing.

**Rail, in Conflicts scope.** An operation banner (*Rebasing `my-feature` onto `master` — 3
of 7*), then one row per conflicted file with `n unresolved / n`, each offering **All ours**
/ **All theirs** / **Resolve** (enabled only when nothing is undecided). Below, **Abort**
behind a confirm, running `git merge --abort` / `rebase --abort` / `cherry-pick --abort` to
match the operation — a resolver without an escape hatch is a trap. The divergence tripwire
from §2 posts its warning here.

**Keyboard.** `⌃⇧O` ours, `⌃⇧T` theirs, `⌃⇧B` both-ours-first, acting on the conflict the
cursor is in (`RowOrigin.conflictID`). Declared in `WorkbenchView.keyBindings`, **not** the
menu bar: a menu key equivalent beats the key window's responder chain and would steal these
from the terminal whenever the workbench is closed. They go into `ShortcutCatalog` as
display-only `.workbench` rows (`key: nil`) so `⌘/` lists them, and `ShortcutActions` `break`s
on each.

**Resolving rebuilds and re-scrolls.** A resolution changes which rows exist, so it needs a
full `rebuild()` — which remounts the editor (`.id(session.revision)`) and loses the scroll
position. After the rebuild the session scrolls back to that conflict's first row, which is
where the user wants to be regardless.

**Other scopes mid-merge.** Working-tree and vs-base scopes show a banner pointing at
Conflicts while unmerged entries exist. `DiffParser` is **not** being taught combined `@@@`
hunks; that mid-merge diffs read wrong in those scopes is a pre-existing gap, not something
W3 introduces, and it is recorded rather than fixed.

---

## 8. The Files scope — the workbench as a plain editor

`WorkbenchScope.files`, keyed `⌃4`. Almost no new machinery: `⌘P` already opens any repo file
whole, `RowPlanner`'s `opened:` path already emits every line as a row, and W2.2's write-back
already handles those rows (`lineIndex: -1`, mapped by path and line number) with `⌘S` to
disk. What is missing is the mode around it.

- `displayedFiles` is empty in this scope, so the document is built purely from
  `openedPaths` — no diff, no bands, no tints.
- The rail shows OPEN plus the repo file list, filterable, replacing the staged/unstaged/
  committed sections.
- The header drops the `+N −M` summary and the staging pills; the branch menu, `⌘P` and
  `⌘S` stay.
- The commit box stays — editing files and committing them is one workflow.

Sequenced **last**, deliberately, so it cannot destabilise the conflict core.

---

## 9. Testing

**Pure, in `ShepherdModelTests`** (new files must be added to the target's explicit
`sources:` list in `project.yml`, not just dropped in `Tests/`):

- `Diff3Tests` — identical all three; empty base (add/add); empty ours; empty theirs; only
  ours changed; only theirs changed; both changed identically; genuine conflict; changes at
  file head and tail; two adjacent conflicts; a line deleted by both; the zdiff3 trim; and a
  fixture with out-of-order matches to prove no `Range` inverts.
- `MergeOutputTests` — every `Resolution`; both-orders; whole-file kinds where a side is
  empty; `preview` defaults undecided regions to ours while `text` returns nil for the same
  input; and `text` equals `preview` joined once everything is decided.
- `ConflictParseTests` — the `ls-files -u` record parse and stage-set classification for
  each row of the §1 table, including malformed input.
- `ConflictRowPlanTests` — rows equal `MergeOutput.text` split by line; band placement; every
  conflict row carries its `conflictID`; no row is stageable; preview numbering is
  consecutive from 1.

**Against a real repo.** The roadmap is emphatic that none of the eleven live-run defects
were catchable by unit tests — they were coordinate mappings, object lifetimes and per-frame
cost. So: a fixture repo scripted to produce, in one merge, a content conflict with two
regions, an auto-resolved region (one side only), a delete/modify conflict, an add/add
conflict, and a binary conflict. Driven headless through `ConflictReader` → `Diff3` →
`MergeOutput`, asserting the invariants, and cross-checked against `git merge-file`'s own
output on the stable regions.

**Then run it in `ShepherdDev`**, per the standing rule — never `killall Shepherd`, which is
the user's daily terminal. Overlay hit-testing, scroll tracking under a rebuild, and tall
`mergeSide` bands are all invisible to `xcodebuild` and to a green test suite.

---

## Deferred, recorded so it isn't lost

- **Combined-diff (`@@@`) parsing** in `DiffParser`, so working-tree scope is honest
  mid-merge.
- **In-place editing of a conflict region** before resolution. Needs the document to have a
  writable backing, which a merge preview does not.
- **Resolution choices surviving a workbench close.** They are in-memory by design; a
  half-triaged file is untouched on disk, which is the safe trade, but it does mean closing
  loses the work.
- **Word-level diff inside a conflict region.** `WordDiff` + `HunkPairing` would pair
  ours/theirs lines the way they pair a hunk's, but the pairing rule for a three-way region
  is its own question.
- **Rebase conflicts recursing mid-sequence**, which W5's interactive rebase needs — the
  seam to design is "resolve, continue, land back in the resolver on the next commit".
- **The overlay generalized to comments and threads**, retiring the rail-only placement.
