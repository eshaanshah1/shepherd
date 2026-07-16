# GitHub PR review comments in the diff panel

**Date:** 2026-07-16
**Status:** approved (design)
**Related:** [`2026-07-14-pr-status-on-idle-agents-design.md`](2026-07-14-pr-status-on-idle-agents-design.md), diff-review roadmap (long-term "linked-PR comments" item)

## Problem

The diff panel (⌘G) shows an agent's changes and lets you leave **local** comments
that batch into one prompt for the agent ("Send to agent N"). When that checkout has
a GitHub PR, the PR's own **inline review comments** live only on github.com — you
have to leave the app to read them, reply, or resolve them.

This feature pulls those inline review comments into the diff panel next to the local
ones, and adds **reply**, **resolve/unresolve**, and **send-to-agent** on them — so a
reviewer's note can be answered on GitHub or handed straight to the agent without
leaving Shepherd. GitHub comments must be **visually unmistakable** from local ones.

## Scope

**In:**
- Pull **inline review comments** (the threads anchored to a file:line) for the pane's PR.
- Render them inline in the diff, visually distinct from local comments.
- **Reply** to a thread (posts to GitHub as the `gh`-authenticated user).
- **Resolve / unresolve** a thread on GitHub.
- **Send to agent** — turn a GitHub review comment into an agent prompt, reusing the
  existing local-comment batch + "Send to agent N" pipeline.
- Show threads only in **branch-vs-base** mode (the panel mode that mirrors the PR's diff).
- **Sidebar unresolved-comment badge** — an idle agent whose PR has unresolved review
  threads shows a **red comment glyph + count** as a new state of the existing
  leading PR-status icon (overriding the normal PR-kind glyph).
- **Remove the `reviewRequired` eye icon** — it falls through to the default
  pull-request glyph (still amber).

**Out (v1):**
- PR-level conversation comments and review-summary bodies (not line-anchored).
- Posting *new* top-level review comments to GitHub (local comments stay agent-bound).
- Working-tree mode overlay (threads only render in vs-base mode).

## Architecture

### Where thread state lives (decision)

`AgentStore` owns the fetched threads in a per-pane cache (**approach B**), living
right next to the existing `prStatuses: [String: PRStatus]`. The panel reads from the
store; it does not own thread state. Rationale: threads are fetched alongside PR
status (same triggers), survive the panel being closed, and — the deciding factor —
are reachable from the **sidebar**, which this v1 needs for the unresolved-comment
badge (see below). (Approach A, panel-owned transient state, was rejected precisely
because the sidebar can't reach into a `@StateObject` view-model.)

### All GitHub I/O via `gh api graphql`

One authenticated tool, already gated on `GH.isInstalled`. GraphQL rather than REST
because a single `reviewThreads` query returns thread IDs, `isResolved`, `isOutdated`,
and each comment in one call — and the reply/resolve mutations need those thread IDs.

### Units

**1. Pure model — `PRComments.swift`** (no AppKit; unit-tested; namespaced like
`PRStatus.swift` so symbols don't clash under `@testable import`)

```
struct GHReviewComment: Equatable, Identifiable {
    let id: String            // GraphQL node id
    let databaseId: Int?
    let author: String        // login, "" if unknown
    let body: String
    let createdAt: String     // ISO8601 as returned; formatted at render time
}

struct GHReviewThread: Equatable, Identifiable {
    let id: String            // GraphQL thread node id (used for reply/resolve)
    let path: String
    let line: Int?            // nil when outdated / no longer maps
    let side: DiffSide        // RIGHT -> .new, LEFT -> .old
    let isResolved: Bool
    let isOutdated: Bool
    let comments: [GHReviewComment]   // first is the root, rest are replies
}

enum PRThreads {
    /// Parse the `repository.pullRequest.reviewThreads.nodes` GraphQL payload.
    static func parse(_ data: Data) -> [GHReviewThread]
    /// "https://github.com/{owner}/{repo}/pull/{n}" -> (owner, repo); nil if unparseable.
    static func ownerRepo(fromURL url: String) -> (owner: String, repo: String)?
}
```

Reuses `DiffSide` from `DiffModel.swift`. `parse` is defensive: missing/null fields
degrade (nil `line`, `""` author) rather than dropping a thread.

**2. `gh` shell — extend `GH` in `GitHubService.swift`** (app-target only, not
unit-tested — matches the existing `GH.prStatus` split). All synchronous `Process`
calls run off-main by the caller, using the same `augmentedEnv` + `executablePath`.

```
static func reviewThreads(owner:repo:number:inDir:) -> [GHReviewThread]?
    // gh api graphql -f query='<reviewThreads query>' -F owner -F repo -F number
static func replyToThread(id:body:inDir:) -> Bool
    // addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id, body:$body})
static func setThreadResolved(id:_ resolved:Bool,inDir:) -> Bool
    // resolveReviewThread / unresolveReviewThread(input:{threadId:$id})
```

The query requests `reviewThreads(first:100){ nodes{ id isResolved isOutdated path
line diffSide comments(first:100){ nodes{ id databaseId author{login} body createdAt }}}}`.

**3. `AgentStore` — the per-pane thread cache + mutation orchestration**

New state, next to `prStatuses`:
- `@Published private(set) var reviewThreads: [String: [GHReviewThread]] = [:]`
  (keyed by pane id)
- an in-flight `Set<String>` guard (mirrors `prInFlight`)

New methods:
- `refreshReviewThreads(forPane:)` — no-op without `GH.isInstalled`, a cwd, or a
  cached `PRStatus` for the pane. Off-main (owner/repo from
  `PRThreads.ownerRepo(fromURL: status.url)`, number from `status.number`) →
  `GH.reviewThreads(...)` → publish on main; clears the entry when there's no PR /
  empty result.
- `replyToThread(id:body:forPane:)` and `setThreadResolved(id:_:forPane:)` — call the
  `GH` mutation off-main, then `refreshReviewThreads(forPane:)` to reconcile.
- **Triggers:** threads are fetched on the *same* occasions PR status is — a pane
  entering `.idle` (hooked in `apply`/`didFocus`), the 60s idle refresh loop
  (`refreshAllIdlePRs` also refreshes threads for panes that have a PR), plus after any
  reply/resolve mutation and on the panel's manual refresh. Fetching is independent of
  whether the panel is open (that's the point of B).

**4. `DiffReviewModel` (in `DiffPanelView.swift`)** — reads the store, owns only
ephemeral panel UI state:
- Reads `store.reviewThreads[paneID]` (no thread state of its own).
- `@Published var replyingTo: String? = nil` (thread id whose inline reply composer is
  open) + `@Published var expandedResolved: Set<String>` (resolved threads the user
  clicked to expand). Purely UI, panel-local.
- **Only renders threads in `mode == .branchVsBase`** (working-tree mode ignores the
  store cache).
- **Anchoring:** a thread with a non-nil `line` anchors to a `DiffLineRow` exactly like
  a local comment — `Anchor(file: thread.path, line: thread.line!, side: thread.side)`
  matched against the row's own `anchor`. Reuses the existing `commentsHere` pattern.
- **Unanchored / outdated threads** (`line == nil`, or a line not present in the
  current diff) surface in a per-file **"N review comments not on the current diff"**
  disclosure at the file header — nothing silently disappears.
- Reply / resolve buttons call `store.replyToThread(...)` / `store.setThreadResolved(...)`.
- **Send-to-agent bridge:** a thread's "Send to agent" appends a derived
  `ReviewComment` to the panel's local `comments` batch, tagged GitHub-sourced so the
  composed prompt reads *"Address this PR review comment from @user on file:line: …"*.
  It ships with the same "Send to agent N" button — local + GitHub notes mix in one
  batch. (See `ReviewPrompt` change below.)

**5. `ReviewComment` / `ReviewPrompt` (in `DiffModel.swift`)**

`ReviewComment` gains an optional `githubAuthor: String?` (nil = local). `ReviewPrompt.compose`
formats a GitHub-sourced entry as *"Address this PR review comment from @author on
file:line: …"* and a local one as today. This keeps the batch/inject pipeline
(`submitReview` → PTY) untouched.

### Rendering — visual distinction (the "make it obvious" requirement)

- **Local comments:** unchanged — the current `CommentBubble` (quiet card, accent/blue
  voice, `×` to remove) and `CommentComposer`.
- **GitHub threads:** a new `GitHubThreadView` — a card with a **left rail + Tabler
  `brand-github` octocat glyph in violet** (reusing the PR-icon violet family), a
  header of `@author · <relative time>`, stacked reply comments, and a footer row:
  **Reply** (opens an inline composer mirroring `CommentComposer`), **Resolve / Reopen**
  toggle (Tabler check glyph; a resolved thread renders **dimmed and collapsed** to its
  first line until expanded), and **Send to agent**.

So: local = blue / quiet / agent-bound; GitHub = violet / octocat / threaded with
reply+resolve. Unmistakable at a glance.

### Sidebar unresolved-comment badge (`SidebarView.swift`)

A new render state of the existing leading PR-status icon (the `paths(_:)` / `prIcon`
site at `SidebarView.swift:958`). It is **not** a `PRKind` case — `PRKind` stays a pure
reduction of `gh pr view`. Instead the sidebar combines two sources it already has
access to: `store.prStatuses[paneID]` and `store.reviewThreads[paneID]`.

- **Unresolved count** = `reviewThreads[paneID]?.filter { !$0.isResolved }.count ?? 0`.
- **Override:** when a pane is idle, has a PR, and unresolved > 0, the leading icon
  becomes a **red (`Theme.error`) `Tabler.message` glyph with the count** — overriding
  whatever the PR-kind glyph would have been (unresolved reviewer feedback is the most
  actionable signal). Count renders as a small number on/beside the glyph; **`9+`** when
  greater than 9.
- When unresolved == 0, the icon is exactly today's PR-kind glyph.
- **New glyph:** `Tabler.message` must be added to the `Tabler` enum (no comment glyph
  exists yet) using the Tabler `message` SVG path.

### Eye-icon removal (`SidebarView.swift:964`)

Drop `case .reviewRequired: return Tabler.eye` so `.reviewRequired` falls through to the
default `Tabler.pullRequest` glyph (its amber color via `color(_:)` is unchanged). The
now-unused `Tabler.eye` path is removed.

## Data flow

```
pane idle / focused / 60s loop, pane has PRStatus
  → AgentStore.refreshReviewThreads(forPane) (off-main): GH.reviewThreads(owner,repo,number,dir)
      → gh api graphql (reviewThreads query) → PRThreads.parse
  → publish store.reviewThreads[paneID] on main

panel (vs-base) reads store.reviewThreads[paneID]
  → DiffLineRow shows anchored threads inline; file header shows unanchored ones

reply:   composer → store.replyToThread(id,body,pane) → GH.replyToThread → refresh
resolve: toggle   → store.setThreadResolved(id,resolved,pane) → GH.setThreadResolved → refresh
send to agent: append GitHub-tagged ReviewComment → existing "Send to agent N" → PTY
```

## Error handling & fail-safe

- No `gh`, no PR, non-vs-base mode, or a failed/empty GraphQL fetch ⇒ no cached threads
  for the pane; the panel behaves exactly as today (local comments only). The feature
  is invisible when it can't apply.
- A failed reply/resolve mutation surfaces a lightweight inline error and refetches to
  reconcile; it never blocks local review.
- `parse` degrades on malformed payloads (drops nothing on a nil field; returns `[]`
  on undecodable data), matching `PR.parse`.

## Testing

- **`PRCommentsTests.swift`** (added to `ShepherdModelTests` `sources:` + the `Tests`
  glob): GraphQL payload → threads covering resolved, outdated, `line == nil`,
  multi-comment (root + replies) threads, empty/malformed payloads; and PR-url →
  owner/repo parsing (incl. enterprise-host and trailing-path variants). Plus a pure
  `PRThreads.unresolvedCount(_:)` helper (drives the sidebar badge) covering all-resolved,
  mixed, and empty cases.
- The `gh` shell (`GH.reviewThreads` / `replyToThread` / `setThreadResolved`) and the
  SwiftUI views stay uncovered, matching the existing `GH` / `PRStatus` split.
- `xcodegen generate` after adding `PRComments.swift` + `PRCommentsTests.swift`.

## Boundaries left open (future)

- PR-level conversation / review-summary comments (non-anchored section).
- Posting new top-level review comments to GitHub from local comments.
- Working-tree-mode overlay with best-effort re-anchoring.
