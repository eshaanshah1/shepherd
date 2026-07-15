# 0019. Rendered markdown diff in the review panel

Status: Accepted
Date: 2026-07-15

## Context
The diff panel renders every file as a raw unified `+/-` diff with syntax
highlighting. For `.md` files that reads poorly: prose reflow and markup churn
(`*x*`→`_x_`, heading-level bumps, table pipe re-alignment) produce large textual
diffs that don't map to meaning, while a one-char change can be a big semantic
edit. We want `.md` files to render as *formatted markdown* by default, with a
per-file toggle back to the raw diff.

A first cut shipped **block-level** on MarkdownUI (`swift-markdown-ui`), but that
renderer is a black box — it can't tint arbitrary changed spans, so word-level
"rich diff" was impossible, tables reprinted whole on a one-cell edit, and YAML
frontmatter had nowhere sensible to go. So we **own the render path** over
apple/`swift-markdown` (cmark-gfm AST) and diff/highlight down to the word, cell,
and field.

## Decision

**Pure, unit-tested diff core** (compiles without the AppKit surface):
- `SequenceAlign.lcs` — LCS over `[String]` keys → `keep/remove/add` index ops; the
  backbone for aligning blocks, list items, and table rows.
- `MarkdownInlineDiff` — whitespace word-diff → `[.keep/.add/.remove]`.
- `MarkdownFrontmatter.split` — lifts leading YAML into ordered `key: value` fields
  + the body.
- `MarkdownTableDiff` — aligns rows, pairs a replaced row, reports changed cells
  (with old text), added/removed rows.

**`MarkdownDiffView`** parses both sides, aligns top-level blocks (`SequenceAlign`
on each node's `.format()`), and renders each node to SwiftUI itself.

- **The line rule (the core UX decision):** a changed span shows on **one** line
  when the edit is a **pure** addition or deletion (the changed words densely
  highlighted in place — you don't need to reconstruct before/after); a **mixed**
  edit shows **two** lines (whole-old red over whole-new green, no intra-line
  marks — interleaved word-diff on a mixed edit is unreadable). Applied uniformly
  to prose paragraphs/headings, list items, frontmatter values, and table cells.
- **Frontmatter** renders as a native **METADATA card** (key/value rows); on a new
  file values are plain (the file-level `A` already says it's new), empty values
  dim, and green/red is reserved for genuine field adds/changes/removals.
- **Tables** render row-aligned with only changed cells diffed; laid out with
  **HStack rows + equal flexible columns, not SwiftUI `Grid`** — `Grid` mis-sizes
  columns when cells use `maxWidth:.infinity` (needed for wrapping) and one cell is
  taller than its row-mates.
- **Coalescing + context-windowing:** consecutive same-kind blocks render under one
  gutter bar; unchanged blocks far from any change collapse to a `⇕ N unchanged
  sections` pill (keeping changed blocks + 2 neighbours), so a small edit in a long
  doc doesn't render the whole file. A brand-new file (all added) has nothing to
  collapse and renders fully.
- **Palette:** additions green, removals red (struck), changed-region bar blue;
  inline `code` is **steel blue** (`#8AA9C7`) — deliberately off green so it never
  reads as an addition. Word highlight uses foreground color **and** background
  (SwiftUI `Text(AttributedString)` renders per-run `backgroundColor` on this macOS;
  table cells, being discrete views, also tint their background).
- **Per-file toggle + affordances:** each `.md` header has a **Rendered ⇄ Raw**
  segment (Raw = the exact unified diff + line commenting) and permanent inline
  **copy-path** + **edit** icons (Tabler glyphs via `TablerIcon`) next to the name,
  GitHub-style.
- **Off-main fetch:** old/new source is read in the same off-main pass as syntax
  highlighting (`git show` pumps a run loop, unsafe during SwiftUI layout); cached as
  `mdSources[path]`; the view parses/diffs/renders synchronously from the strings.
- `blockContent` returns `AnyView` (not `some View`) so the recursive blockquote/list
  cases don't define an opaque type in terms of itself.

## Consequences
- Word/cell/field-level highlighting with markdown formatting intact — the "own the
  renderer" path, chosen over the MarkdownUI block-level compromise.
- Type-name collisions with SwiftUI (`Text`, `Table`, `Link`, `Image`) — swift-markdown
  nodes are qualified `Markdown.*`, views `SwiftUI.*`.
- Commenting is Raw-only (rendered mode has no line anchors) — GitHub does the same.
- New SPM dependency `apple/swift-markdown` (+ cmark-gfm) replaces `swift-markdown-ui`;
  added to the app and — because `@testable import Shepherd` pulls the app module —
  the `ShepherdModelTests` target. (Adding the package mid-build needs one extra
  incremental pass before the test target resolves it.)
- v1 scope: table columns are equal-width (robust, not content-proportional); the
  collapse pill is non-interactive (Raw shows everything); images render as `🖼 alt`
  (no image loading); single-file rendering, no cross-file rename-aware matching
  beyond `oldPath` blob selection.
