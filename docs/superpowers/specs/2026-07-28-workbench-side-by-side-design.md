# Side-by-side diff

> Design record. Roadmap:
> [`2026-07-26-unified-workbench-w1-w5-roadmap.md`](../plans/2026-07-26-unified-workbench-w1-w5-roadmap.md).
> Workbench spec: [`2026-07-26-unified-workbench-design.md`](2026-07-26-unified-workbench-design.md).
> W3, whose overlay this reuses: [`2026-07-27-workbench-w3-merge-resolver-design.md`](2026-07-27-workbench-w3-merge-resolver-design.md).

## What this adds

A toggle between the current inline diff and a two-column one: the old side on the left,
the new side on the right, aligned row for row.

## The decision that shapes everything

**There is one editor.** The new side stays the single real `SourceEditor`; the old side is
a sibling view that *draws* its text, positioned from the editor's own layout manager.

The roadmap's phrasing — "needs two synchronized multibuffers" — describes the obvious
implementation, not the right one here. Two editors means two layout managers that must
agree about the height of every row, kept in step by scroll synchronisation and alignment
spacers. This project's most expensive bugs have all been **two opinions about where a row
sits**: the gutter drifting against the text (two days), the highlighter reading excerpt row
spans as source lines, the overlay estimating its visible window from the text's line height.
The standing rule since is exactly one opinion, and `DiffGutter` and `WorkbenchOverlay` both
already work this way — they read `editorLineMetrics` and position themselves against it.

A third option, one editor rendering two columns per line fragment, was rejected outright: a
row would no longer be one piece of text, which breaks the cursor, selection, and the entire
W2 write-back story that rests on a row being a real line of a real file.

### The left side is never editable, in either mode

Working-tree mode's left side is HEAD; vs-base mode's is the base branch. Both are committed
history — there is no file on disk to write to and no meaningful edit to make. This is not a
restriction the design imposes, it is what a diff's old side *is*, and it is why giving up a
real editor there costs so little.

### How VSCode does it, and why we diverge

Monaco's `DiffEditorWidget` is **two full editors** — `originalEditor` and `modifiedEditor` —
with synchronized scrolling and *view zones* (blank spacers) keeping them aligned. The
original is set read-only for a git diff but remains a real editor. That is option B above,
and it is worth being clear that the industry-standard answer is the one this spec rejects.

The case for diverging is specific rather than general:

- Our left side has **no editing requirement at all**, so the benefit a real editor buys is
  *selection*, not editing.
- Two layout managers that must agree about every row's height is, by construction, the
  failure this project has hit four times — the gutter drifting against the text, the
  highlighter reading row spans as source lines, the overlay estimating its window from the
  wrong line height, and the overlay parented into a dead scroll view. Every one was two
  components disagreeing about geometry.
- `DiffGutter` and `WorkbenchOverlay` already demonstrate the drawn-sibling pattern working
  against the single layout manager.
- VSCode has spent years making scroll-sync and view zones not jitter. We would be starting
  that from nothing.

**The concrete thing given up against VSCode parity: visible text selection in the left
pane.** `⌘C` over a selection spanning it works through the `stringForCopyOf` hook, but there
is no highlight and no drag-select confined to the left column. If that turns out to matter
in use, the upgrade path is option B, and nothing in §1, §2 or §4 is wasted — the pairing
model and the row plan are what a two-editor version would need anyway.

### What this costs

The left column is drawn, so it is **not selectable text**. That is the same limitation
deletion bands have, and it is acceptable for the same reason: the old side of a diff is
history, and there is nothing to edit there. `⌘C` still works — the `stringForCopyOf` hook
added for deletion bands already reconstructs text that is not in the document, and the left
column plugs into it.

It also means no independent scrolling of the two sides. That is not a loss; synchronised is
the only sane behaviour for a side-by-side diff, and here it is free rather than engineered.

---

## 1. `SideBySidePlan` — pure, tested

The alignment is the whole problem, and it is pure. Given a hunk, produce the row pairing:

```swift
/// What one row of a two-column diff shows. Either side may be absent, which is what an
/// insertion or a deletion *is*.
struct SidePair: Equatable {
    let old: Int?      // index into the hunk's lines, or nil — nothing on the left
    let new: Int?      // index into the hunk's lines, or nil — nothing on the right
}

enum SideBySidePlan {
    static func pairs(_ hunk: DiffHunk) -> [SidePair]
}
```

Pairing rule, deliberately the same one `HunkPairing` settled on: a maximal run of removals
immediately followed by a maximal run of additions pairs line-for-line **when the two runs
are the same length**; otherwise the removals occupy rows with an empty right side and the
additions rows with an empty left. Context lines pair with themselves.

That rule is not a guess — it is the one W1's live run forced. Pairing by ordinal across
runs of different lengths lines up unrelated lines, and the word diff then brightens words
that never changed. The same failure would here put unrelated lines opposite each other,
which is worse: it reads as a claim about what changed into what.

**Tests:** pure insertion, pure deletion, equal-length replacement, unequal-length
replacement, context-only, a hunk that is entirely one side, and an empty hunk.

## 2. Rows stay new-side only

`RowPlanner` is unchanged, and this is the point. The document is still exactly what it is
inline: every row a real line of the new side, removals as `.deletedLines` bands.

In side-by-side, the deletion bands are **suppressed** — their content moves to the left
column — and each removal instead reserves a row's worth of height opposite the row it was
anchored to. A new `PlannedBand.sideGap(rows:)` does that: it occupies vertical space on the
right so the left column has somewhere to put lines the right side does not have.
`BlockKind.spacer(rows:)` already exists for precisely this and has never been emitted.

Concretely, for a hunk with 2 removals and 3 additions:

```
left (drawn)          right (the editor)
 40  old a             ░░ sideGap(2)
 41  old b
     —                 42 + new a
     —                 43 + new b
     —                 44 + new c
```

The right side's rows are unchanged from inline; only the bands differ. That is what keeps
write-back, staging, `⌘⏎`, the conflict resolver and the overlay working with no changes at
all.

## 3. `OldSideColumn` — the drawn view

A sibling of the editor, beside the gutter, built the way `DiffGutterView` is:

- row geometry from `session.editorLineMetrics` — **the** single opinion
- scroll read live off the clip view, notification only to trigger a repaint (the correction
  the overlay needed)
- `clipsToBounds = true` (false by default since macOS 14)
- the per-draw walk bounded to the visible rows
- syntax colours from `MultiHighlighter` variant `.old`, which already exists and is what
  deletion bands use
- its own thin line-number column, showing old-side numbers

It draws, per row: the paired old line if there is one, and nothing if there isn't. Empty
rows on either side get a faint hatch so an insertion reads as an insertion rather than as a
blank line someone forgot.

Width is user-draggable, defaulting to half the content area, persisted in
`~/.config/shepherd/config` under a `# shepherd:` comment key like the other Shepherd-only
settings.

## 4. Word diff across the columns

`WordDiff.spans(old:new:)` already produces both sides' spans from one call, and
`HunkPairing` already decides which lines are counterparts. A `SidePair` with both sides
present is exactly a counterpart pair, so the left column gets `spans.old` and the right
keeps `spans.new`. No new logic — it is the same pairing viewed differently.

## 5. Chrome

A header toggle (inline ⇄ split) and `⌥⌘\`, matching what every other diff tool binds. The
mode is per-pane session state, persisted with the other workbench settings so it survives a
reopen.

Split mode is **inline-only in one place**: a conflicted file. A three-way merge has no
meaningful two-column form — there are three sides, not two — so entering the Files scope
with conflicts falls back to inline and says so in the header rather than rendering
something misleading.

## 6. What does not change

Worth stating explicitly, because it is the justification for the whole approach:

`RowPlanner`'s row walk · `EditMap` and write-back · `StageSelection` and `PatchSynth` ·
`WorkbenchOverlay` and the conflict controls · the review-note bands · the commit box ·
`⌘P` and the Files scope. None of them can tell the difference, because the document they
operate on is byte-identical in both modes.

## 7. Testing

**Pure:** `SideBySidePlanTests` over the pairing rule (the table in §1), and a property that
every hunk line appears exactly once across all pairs — the alignment equivalent of "excerpts
tile the document".

**Against a real repo:** extend the existing fixture with a hunk of each shape and assert the
pairing holds over `DiffParser` output rather than hand-written hunks.

**Run it.** The drawn column is a coordinate mapping against a live layout manager, which is
the category `xcodebuild` and a green suite cannot see — every defect of that shape this
project has had was found by looking at it. Specifically: scroll far and check the columns do
not drift; a tall deletion run; a file whose last hunk ends the document; and the empty-row
hatch on a pure insertion.

---

## Deferred

- **Selecting text in the left column.** Needs the same treatment deletion bands would:
  reconstruct a selection from `rowOrigins` + the pairing. `⌘C` over it works via the
  existing copy hook; a visible selection does not.
- **Split view for conflicts.** See §5 — three sides do not fit two columns. If it is ever
  wanted, the shape is probably ours|theirs with base in a third strip, which is its own
  design.
- **Per-side independent scroll.** Deliberately not offered.
