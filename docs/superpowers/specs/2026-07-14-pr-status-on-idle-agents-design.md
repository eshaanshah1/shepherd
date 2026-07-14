# PR status icons on idle agents

**Date:** 2026-07-14
**Status:** approved, implementing
**Repo area:** `spike/seam1/Sources` (new `PRStatus.swift` + `GitHubService.swift`, plus AgentStore / SidebarView / Theme) + `Tests`

When an agent pane is **idle** (alive, not mid-turn, no attention pending) and its
checkout has an open/closed/merged PR, show a **PR-status icon in place of the
leading state dot** in the sidebar tab row. Clicking it opens the PR in the
browser. Status is fetched via `gh` and refreshed while idle.

## Decisions (from brainstorming)
- **Association:** auto from the pane's git branch (cwd → `gh pr view` for the
  current branch's PR). No manual attach.
- **When:** idle only (`state == .idle`).
- **Placement:** replaces the leading state dot; clickable → opens the PR URL.
- **Cadence:** fetch on entering `.idle`, plus a ~60s repeating refresh of every
  idle agent pane; click opens (no refetch).

## Model (pure, unit-tested — `PRStatus.swift`)
- `enum PRKind { merged, closed, draft, checksFailing, changesRequested, checksPending, reviewRequired, mergeReady, open }`
- `enum ChecksVerdict { passing, failing, pending, none }`
- `struct PRStatus { let number: Int; let url: String; let kind: PRKind }`
- `func classifyPR(state:isDraft:reviewDecision:checks:mergeState:) -> PRKind` —
  priority reducer: `merged → closed → draft → checksFailing → changesRequested →
  checksPending → reviewRequired → mergeReady → open`.
- `func parsePRStatus(_ data: Data) -> PRStatus?` — decode `gh pr view --json`
  output (state, isDraft, reviewDecision, statusCheckRollup, mergeStateStatus,
  number, url), reduce `statusCheckRollup` to a `ChecksVerdict`, run `classifyPR`.
  Returns nil when there's no PR / undecodable.

## gh shell (app only — `GitHubService.swift`)
`enum GH { static func prStatus(inDir:) -> PRStatus? }` runs
`gh pr view --json state,isDraft,reviewDecision,statusCheckRollup,mergeStateStatus,number,url`
in the pane's cwd (infers repo + branch), pipes stdout to `parsePRStatus`. Non-zero
exit / empty → nil. Mirrors the existing `Git.run` process pattern.

## Store (`AgentStore`)
- `@Published private(set) var prStatuses: [String: PRStatus]` (paneID → status;
  transient, never persisted).
- `refreshPR(forPane:)` — resolves cwd, runs `GH.prStatus` off-main, sets/clears
  the entry on main. An in-flight `Set<String>` guard avoids overlapping fetches.
- Triggered when a pane transitions **to `.idle`** — hooked in `apply` (after the
  state write) and in `didFocus` (needsCheck → idle).
- A single `Timer` (~60s, main) calls `refreshAllIdlePRs()` — refresh every pane
  currently in `.idle`. Started in `init`, torn down on quit.
- `openPR(forPane:)` — `NSWorkspace.shared.open(url)`.

## UI (`SidebarView`)
- `PRStatusIcon(status:)` — a `TablerIcon` (git-pull-request / git-merge /
  git-pull-request-closed / draft variant) tinted by `PRKind`:
  merged=purple, closed & checksFailing=red(error), draft=gray(textDim),
  changesRequested & checksPending & reviewRequired=amber(blocked),
  mergeReady=green(needsCheck), open=blue(working).
- In `TabRow`: when `state == .idle` and `store.prStatuses[paneID]` exists, render a
  clickable `PRStatusIcon` in the leading slot (→ `store.openPR`); else the normal
  `LeadingIcon(state:)`. The Tabler git glyphs use Tabler's path-encoded circles, so
  the existing path-only `TablerIcon` renders them unchanged.
- `Theme.prMerged` (purple) added; other colors reuse existing state tokens.

## Scope / limitations (v1)
- Single-pane tabs only; split-tab pips are unchanged (per-pane PR in a split is a
  deferred follow-up).
- `gh` uses whatever account it's authed as — repos that account can't see return no
  PR (expected; not an error).
- Icon glyphs are the canonical Tabler git-pull-request family; swappable if an exact
  Synara asset is provided.

## Tests (`PRStatusTests.swift`, model target)
`classifyPR` priority at each tier; `parsePRStatus` on sample `gh` JSON (open w/
passing checks, draft, merged, closed, checks-failing, review-required) → expected
`PRKind`; empty/garbage → nil.
