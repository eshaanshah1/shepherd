# Unified Workbench — design

**Date:** 2026-07-26
**Status:** design approved; W0 spec (this document) awaiting implementation plan
**Supersedes (in spirit):** `2026-07-08-diff-review-panel-design.md`,
`2026-07-13-unified-code-surface-editor-design.md`

---

## 1. The problem

Shepherd has four surfaces that show code — the terminal, the diff panel, the
rendered-markdown diff, and the file editor — and they do not read as one app.
This is not a styling oversight; it is structural. Five distinct causes:

1. **Two syntax highlighters.** The diff panel runs HighlighterSwift
   (Highlight.js in JavaScriptCore) against `atom-one-dark`, then remaps every
   token to `Theme.Code` by *nearest-RGB distance* (`DiffPanelView.swift:263`).
   The editor runs CESE's tree-sitter against `shepherdEditorTheme`, built from
   the same `Theme.Code`. Same palette, different tokenizers — so the same line
   genuinely gets different colors.
2. **Two text layout engines.** Diff rows are SwiftUI `Text` with a hand-computed
   fudge (`DiffMetrics.rowPad`, `DiffPanelView.swift:662`) approximating CESE's
   `lineHeightMultiple: 1.2`. The editor is an AppKit `TextView`. Metrics only
   roughly agree, and selection / find / wrapping / mouse behavior differ wholly.
3. **Four palettes.** `Theme.Code`, atom-one-dark's remap anchors, CESE's
   `EditorTheme`, and `MarkdownDiffView`'s `private enum MDPalette`.
4. **Two chromes.** Diff: "Review" header, segmented toggle, Tabler icons,
   `shepherdCard`. Editor: 34px tab strip, SF Symbols, accent underline, a 220px
   tree on `surface1`, and a background hardcoded to `0x0F0F11` rather than
   `Theme.ground`.
5. **Mutual exclusion.** `AgentStore.openFile` sets `diffPanelOpen = false`;
   opening the diff nils `codeSurface`. The pencil affordance inside the diff
   *ejects you from the diff*.

Diff colors are also derived from **state** colors (`Theme.needsCheck.opacity(0.10)`),
so "line added" is the same green as "agent is done" — a semantic collision, and
the reason the tints read washed out.

## 2. The goal

One surface that is simultaneously a diff reviewer, a code editor, a merge
resolver, and a PR viewer — sharing one text engine, one tokenizer, one palette,
one chrome. Unity enforced by construction, not by discipline.

## 3. Decisions taken

| Decision | Choice | Rationale |
|---|---|---|
| Renderer | **Vendor the editor; build on it** | See §4 |
| Editable diffs | **Required, non-negotiable** | User directive: "full functionality… not willing to compromise" |
| Workbench unit | **Multibuffer** — all changed files in one scroll | One cursor, one find, one selection across file boundaries |
| Placement | **Full-window takeover**, scoped to the focused pane | You switch *into* a pane's work; ⌘G already binds `diffPanelPaneID` to the focused pane |
| Concurrent agent edits | **Live-follow, lock per dirty file** | Clean files stream agent edits; typing locks that one file only |
| Git scope | Stage (hunk + line), commit, push, merge resolve, PR, branch/worktree, **and** history/blame/stash/cherry-pick/rebase | All requested; sequenced across W0–W5 |

### Why vendor rather than write from scratch

`CodeEditTextView`'s `TextLineStorage` is a red-black tree indexed by **both
length and height**, with `update(atOffset:delta:deltaHeight:)` propagating
height deltas through `leftSubtreeHeight`. A block map is precisely "insert
non-text rows with heights into the line index" — the primitive already exists,
and line folding already exploits it by zeroing line heights. Writing from
scratch would mean rebuilding CTLine typesetting, the line-height index,
incremental invalidation, cursor and selection managers, IME / marked-text
handling, find/replace, undo coalescing, and accessibility before rendering a
single diff row — months of work, none of it differentiating.

CESE's own README says it is "not ready for production use" and we are already
pinned to a bare commit (`1fa4d3c`), so there is no stable API to fork away
from. Vendoring means we *own* it and diverge deliberately, cherry-picking
upstream fixes we want, rather than tracking a moving target.

### Why the public hooks are insufficient

Reachable today: `TextLayoutManager.renderDelegate` (public — CESE's own minimap
is built on it), `TextAttachment` (public — fold placeholders use it),
`HighlightProviding` (public, pluggable), `SourceEditorState` (two-way cursor +
scroll bindings), `TextViewCoordinator` (hands over the live `TextViewController`),
and `layoutManager.rectsFor(range:)` (public — anchors overlays).

Missing, and required: **full-row block decorations** (Zed's block map — needed
for deleted-line blocks in an editable inline diff, and for conflict widgets)
and a **customizable gutter** (`GutterView.drawLineNumbers` is private, so dual
old/new line numbers plus a staging column are impossible from outside).

## 4. Program shape

Six specs. This document is the full spec for **W0**; the rest are named here
with scope boundaries and will each get their own design → plan → implement cycle.

| | Spec | Delivers | Depends on |
|---|---|---|---|
| **W0** | **Editor foundation** | Vendored editor, block map, excerpt/multibuffer layer, live-follow, derived theme, unified chrome. Ships the *existing* review panel re-rendered on the new engine. | — |
| W1 | Review & staging | Multibuffer over changed files, hunk + line staging, commit box, push, comments→agent, PR review threads ported | W0 |
| W2 | Editing in anger | File finder (⌘P), open/save/dirty, edit-in-place, branch + worktree ops | W0, W1 |
| W3 | Merge resolver | Conflict excerpts, true 3-way via stage triples, accept ours/theirs/both/edit | W0, W1 |
| W4 | PR surface | Checks rollup, mergeability, review threads, approve/merge | W0, W1 |
| W5 | History & power tools | Log + graph, blame gutter, commit-as-diff, stash, cherry-pick, interactive rebase | W0–W3 |

**W3 and W4 are mutually independent** — order is free. **W5 is last and
optional**: roughly the size of W1–W4 combined (graph renderer, blame gutter,
revision navigator, reorderable rebase todo whose conflicts recurse into W3),
and it has the least leverage over the problem in §1. Nothing else blocks on it.

W0 must ship the existing review panel on the new engine. A foundation that
delivers no visible surface is unverifiable.

## 5. W0 architecture

### 5.1 Vendoring

`CodeEditTextView` and `CodeEditSourceEditor` move into `spike/seam1/Sources/Editor/`
as first-class Shepherd source, preserving upstream's directory layout so
cherry-picks remain mechanical. Their SPM entries leave `project.yml`.
`CodeEditLanguages` **stays a package** — it is only tree-sitter grammars, with
no reason to own it.

Every new compiled source must be added to `project.yml` (both app targets and,
for pure models, the test target's explicit `sources:` list), then
`xcodegen generate`. See the CLAUDE.md gotcha.

### 5.2 New units

Pure (no AppKit; unit-tested in `ShepherdModelTests`):

- **`StitchMap`** — the excerpt model. An ordered list of excerpts, each
  `(sourceID, source line range, kind)`, with bidirectional mapping between
  stitched offsets and `(source, offset)`. Highest bug density in the design;
  most heavily tested.
- **`BlockMap`** — ordered non-text rows with heights, keyed to stitched
  positions: file headers, deleted-line blocks, spacers, conflict widgets,
  rendered-markdown hosts. Lands in `TextLineStorage` via the existing
  `deltaHeight` path.
- **`WordDiff`** — intra-line word alignment over the existing `SequenceAlign`,
  with a length cap.

`PatchSynth` (unified-patch synthesis for `git apply --cached`, from a hunk or an
arbitrary line selection) belongs to **W1**, and `ConflictParse` (reads
`git ls-files -u` into `(base, ours, theirs)` stage triples — never scrapes
`<<<<<<<` markers) belongs to **W3**. Both are pure and unit-tested when built;
neither has a W0 consumer, so building them here would be speculative.

Impure:

- **`SourceBuffer`** (one per file) — disk text, HEAD/index blobs, dirty flag,
  locked flag, tree-sitter client, and a `DispatchSource` watcher driving
  live-follow. Owns the per-file lock: clean ⇒ follows disk; dirty ⇒ freezes and
  marks `changedOnDisk` when the agent writes.
- **`MultiHighlighter`** — conforms to the existing public `HighlightProviding`,
  fanning out to one tree-sitter client per source file and projecting ranges
  into stitched coordinates. **This is the fix for §1.1:** one tokenizer, one
  palette, no nearest-RGB guessing.
- **`DiffGutter`** — our own gutter `NSView`. Per-row old/new line numbers from
  `StitchMap`, the sign column, and the staging checkbox column. Where W5's
  blame column lands.
- **`WidgetLayer`** — SwiftUI overlays anchored via `layoutManager.rectsFor(range:)`
  for hunk actions, comment cards, and conflict controls.
- **`WorkbenchSession`** — per-pane state, held in `AgentStore.workbenchSessions[paneID]`.

### 5.3 Theme derivation

Adopt Superset's **derivation chain** (the mechanism, not its values — Superset
is Elastic License 2.0, and its warm-red `ember` palette would fight Shepherd's
neutral near-black and break the light/warm variants):

```
Theme semantic tokens
  → terminal palette (what writeBaseTheme() emits)
      → editor + diff + syntax tokens, all derived
```

This deletes the standing `CLAUDE.md` hazard — "keep `Theme.swift` and
`writeBaseTheme()` in sync" — by making one the source of the other.

New token group **`Theme.Diff`**, independent of the state-dot colors:
`addition`, `deletion`, `modified`, `buffer`, `hover`, `separator`, `gutterFg`,
`wordAdd`, `wordDel`. Resolves §1's semantic collision where diff-green and
agent-done-green are the same color.

**Line height becomes a shared token at `1.5`** (Superset's ratio; CESE
defaults to 1.2), consumed by the editor, the diff, and the gutter. This is the
single number whose absence forced `DiffMetrics.rowPad` to exist.

`MDPalette` folds into `Theme`.

### 5.4 Layout

Takeover, scoped to the focused pane:

```
┌────────────────────┬────────────────────────────────────────────────┐
│ ‹ unified-workbench│  +1,128 −98 · 10 files · → main                │
│                    │            [ Side by Side │ Inline ]   ⟳   ✕   │
├────────────────────┼────────────────────────────────────────────────┤
│ Working tree     ✓ │  PACKAGES/DB/SRC/SCHEMA ─────────────────────  │
│ Against main       │   ⊞ cloud-workspace.ts                  +119   │
│ Threads          2 │  ┌───┬─────┬─────┬───┬────────────────────────┐│
│ Conflicts        — │  │ ☐ │  1  │  1  │   │ export interface CW {  ││
│                    │  │ ☑ │     │  2  │ + │   id: string           ││
│                    │  └───┴─────┴─────┴───┴────────────────────────┘│
│ UNSTAGED           │        [stage hunk] [comment] [ask agent]      │
│  ⊞ CloudTerminal   │                                                │
│  ◉ WorkspaceSide.. │  APPS/DESKTOP/SRC/RENDERER ──────────────────  │
│  ⊟ LegacyPane      │   ◉ WorkspaceSidebar.tsx  * changed on disk    │
│                    │        [keep mine] [take theirs] [merge]       │
│ STAGED             │                                                │
│  ◉ enums.ts        │  ...                                           │
├────────────────────┤                                                │
│ commit message…    │                                                │
│ [Commit] [& Push]  │                                                │
└────────────────────┴────────────────────────────────────────────────┘
```

Rail carries scope, staging, and the commit box. Scope is how four requirements
become one view:

| Requirement | Surfacing |
|---|---|
| Diff review | scope `Working tree` / `Against <base>` |
| Code editor | **not a mode** — you type in the buffer; ⌘P opens any file as another excerpt |
| Merge resolver | scope `Conflicts (n)`, auto-selected mid-merge; conflict blocks carry ours/theirs/both/edit |
| PR status | scope `Threads (n)` inline; PR band in the header for checks + mergeability |

Editing is not a mode because the block map makes the buffer editable
everywhere. That is the payoff for owning the editor.

The scope list is exactly these four through W4. W5 adds a `Commits (n)` scope
(the branch's commits, each viewable as a diff) — it is not present earlier, so
the rail must not reserve space for it.

Row anatomy:

```
│ ☐ │ 969 │ 970 │ − │  diffPanelOpen = false
  ▲     ▲     ▲    ▲   ▲
  │     │     │    │   └ code · syntax-highlighted · tint behind
  │     │     │    └ sign in its OWN column (code stays aligned)
  │     │     └ new line number
  │     └ old line number
  └ stage checkbox (line-level staging)
```

The sign gets its own column. Today it is prefixed into the attributed string,
shifting code one character right on changed rows relative to context rows.

Adopted from Superset's screenshots: files grouped under dim uppercase directory
headers (vs today's flat full paths); status as colored glyph — green `⊞` added,
amber `◉` modified, red `⊟` deleted (vs bare `A`/`M`/`D`); a dense summary line
(`+1,128 −98 · 10 files · → main`); word-level intra-line diff on by default
with a 5,000-char cap so lockfiles and minified bundles degrade rather than hang.

**Side by Side / Inline** toggles in the header. Inline is one multibuffer with
deleted-line blocks; side-by-side is two synchronized multibuffers, editable on
the right. Both editable, both stageable.

### 5.5 Keyboard

Arrows move the cursor — it is a real buffer — so hunk navigation is separate.
All declared in `ShortcutCatalog`, so the menu bar and the `⌘/` cheatsheet pick
them up without drift.

| Keys | Action |
|---|---|
| `⌥↓` / `⌥↑` | next / previous hunk |
| `⌘⏎` / `⌘⇧⏎` | stage / unstage hunk |
| `⌘⇧C` | comment on line |
| `⌘K` | focus commit box |
| `⌘\` | toggle side-by-side / inline |
| `⌃1`–`⌃4` | switch scope — **not** `⌘1`–`⌘9`, which already jumps to tab N globally, and not `⌥`+digit, which types `¡™£¢` into an editable buffer |
| `⌘F` | find (CESE's panel, free) |
| `Esc` | close |

### 5.6 Carried over unchanged

The comment→agent batch (`ReviewComment`, `ReviewPrompt.compose`, "Send to agent N");
the violet GitHub thread cards with Reply / Resolve / Send-to-agent; the
PR-status icon family and `GH.isInstalled` gate; and the rendered-markdown diff.

**On the rendered markdown diff:** `MarkdownDiffBuilder` and every block view
(`MarkdownGroupView`, `ChangedProseView`, `ListDiffView`, `TableDiffCard`,
`TableGrid`, `FrontmatterCard`, `CollapsedMarker`, `InlineStyle`) plus the four
helper files survive intact. A block map is the correct home for them: a
rendered markdown file becomes a block row hosting those views rather than a
parallel renderer. Only host wiring changes; the Rendered/Raw toggle becomes a
per-file block mode. ADR 0019 stands.

### 5.7 Deletions

What makes this a unification rather than an addition:

```
DiffPanelView.swift              1026 lines  → rendered by the workbench
CodeSurfaceView + State.swift     259 lines  → the workbench in edit mode
DiffSyntaxHighlighter + RGB remap             → MultiHighlighter
DiffMetrics.rowPad fudge                      → real text layout, no fudge
HighlighterSwift dependency                   → gone; one tokenizer
MDPalette (private)                           → Theme
hardcoded 0x0F0F11 editor background          → derived from Theme
SF Symbols in the file tree                   → Tabler, matching the diff
```

`MarkdownDiffView.swift` is **rehosted, not deleted** (§5.6).

Net: roughly 1,300 lines of duplicated renderer leave and one engine arrives.
The surfaces collapse to one code path, so they cannot drift again — the
structural form of "one design language."

## 6. Data flow

```
git / gh (Process, off-main) ─┐
disk watcher (DispatchSource) ┤
                              ▼
              WorkbenchSession   (one per pane, @MainActor)
                ├─ [SourceBuffer]
                ├─ StitchMap
                ├─ BlockMap
                ├─ StagingState
                └─ CommitDraft
                              ▼
              WorkbenchView
                ├─ Rail          scope · files · commit box
                ├─ EditorHost    vendored TextView + DiffGutter
                └─ WidgetLayer   overlays via rectsFor(range:)
```

Sessions live in `AgentStore.workbenchSessions[paneID]` and survive close/reopen.
Staging needs no persistence — it is git's index. Persisted: scope selection,
commit draft, extra open files, scroll position. Unsaved edits prompt on close;
they are neither silently persisted nor dropped.

Key flows:

1. **Open (⌘G)** — resolve the pane's cwd; `git status --porcelain=v2` + `git diff`
   off-main; build `SourceBuffer`s, then `StitchMap`, then mount. Renders the
   shell immediately and fills in as files parse, replacing today's blocking
   "Preparing diff…" state.
2. **Edit** — TextView edit → `StitchMap` maps stitched range to source range →
   `SourceBuffer` applies → dirty + locked → tree-sitter re-highlights that
   source → that file's diff recomputes against HEAD/index **in memory, no git
   call** → `BlockMap` updates.
3. **Save (⌘S)** — write the buffer, clear dirty, resume live-follow.
4. **Stage** — `PatchSynth` builds the patch → `git apply --cached` → re-read the
   index diff for that file → move it between Unstaged and Staged.
5. **Commit** — `git commit -F -` with the draft, then refresh.
6. **External write** — watcher fires; clean buffer ⇒ reload, re-diff, update
   blocks; dirty buffer ⇒ set `changedOnDisk` and show resolve controls on that
   file's header.
7. **Conflicts** — `git ls-files -u` → stage triples via `git show :1:/:2:/:3:` →
   conflict excerpts. Resolving writes the worktree file and `git add`s.

## 7. Error handling

Today `DiffReader.git` returns `nil` and every failure vanishes silently. That is
the baseline to beat.

- git command fails → inline error row in the rail carrying stderr, not a toast
- `git apply --cached` rejects (disk moved underneath) → re-read and retry once;
  on a second failure, name the file that changed and refresh it
- not a repo / detached HEAD / no upstream → affordance disabled **with a
  reason**, never a dead button
- `gh` absent → PR scopes hidden entirely (existing `GH.isInstalled` gate)
- binary / minified / very large → placeholder block; no tree-sitter, no
  word-diff; 5,000-char line cap
- unsaved edits on close → prompt
- conflict resolve → writes the worktree file and `git add`s **only** on explicit
  resolve; never implicitly

## 8. Testing

Pure models in `ShepherdModelTests`, matching repo convention.

| Target | Covers |
|---|---|
| `StitchMapTests` | offset round-trips, excerpt insert/remove, edits shifting downstream excerpts |
| `BlockMapTests` | row ordering, height accounting, insertion between excerpts |
| `WordDiffTests` | alignment and the length cap |
| `LockPolicyTests` | the live-follow state machine: follow, lock on edit, stale on external write, save/discard |
| `ThemeDerivationTests` | the chain yields a complete token set for dark/light/warm with no fallback holes — "cannot drift" made executable |

`PatchSynthTests` and `ConflictParseTests` arrive with W1 and W3 alongside the
units they cover.

`EditorHost`, `DiffGutter`, and `WidgetLayer` remain untested AppKit, verified by
build plus a runtime check — the split this repo already uses.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Block-map recalculation per keystroke across all excerpts | Zed hit this and profiled their way out; budget for it. Cap live excerpts; virtualize off-screen ones |
| Vendoring drops us off upstream while CESE moves fast | Preserve upstream layout so cherry-picks stay mechanical; we diverge deliberately, not accidentally |
| Overlay anchoring via `rectsFor(range:)` during scroll | Expected to be the most irritating part; keep `WidgetLayer` narrow and replaceable |
| N live tree-sitter clients on a 50-file diff | Excerpt virtualization — the same conclusion Superset reached with `VirtualizedFileList` |
| W0 lands with nothing visible | W0 ships the existing review panel on the new engine (§4) |

## 10. Prior art

- **[Zed split diffs](https://zed.dev/blog/split-diffs)** — the reference. One
  multibuffer as a single editable surface spanning files; split diff is two
  multibuffers where the left side is *the real old file* with deleted hunks
  tinted (preserving its genuine syntax tree and line numbers rather than
  patching a synthetic document); alignment via a block map inserting non-text
  decorations, with spacers padding the shorter side. Their
  [Project Diff](https://zed.dev/docs/git) already fuses review and staging.
- **[VSCode's 3-way merge editor](https://code.visualstudio.com/docs/sourcecontrol/merge-conflicts)**
  — incoming/current read-only above, editable result below, per-conflict actions
  including accept-combination in either order. Its
  [known flaw](https://github.com/microsoft/vscode/issues/146091) is highlighting
  and pre-checking auto-resolved regions; W3 should leave those silent.
- **[Superset](https://github.com/superset-sh/superset)** — same thesis as
  Shepherd (CLI agents in isolated worktrees, sidebar status, dock badges,
  built-in review), Electron. Its diff viewer is the licensed `@pierre/diffs`,
  so a funded team chose to buy rather than build one — a useful calibration on
  cost. Its transferable idea is the theme **derivation chain** (§5.3). Elastic
  License 2.0: take the mechanism, re-derive the values.
- **[CodeEdit](https://github.com/CodeEditApp/CodeEdit/issues/62)** — its own Git
  diff view has been an open issue for years. There is no Swift blueprint for
  this; we are not duplicating existing work.
- **libgit2 / SwiftGit2** — rejected. The repo already shells `git` and `gh`
  successfully throughout; a C dependency buys nothing here.

## 11. Open for follow-on specs

Deliberately out of W0's scope, recorded so they are not lost: promoting the
workbench from takeover to a `Pane.kind` (so it can sit beside a live terminal —
`provisioning`/`stowing` already precede a non-PTY pane); remote/mirror
workspace support; and exposing workbench verbs over the control CLI.
