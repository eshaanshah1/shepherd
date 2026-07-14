# Worktree lifecycle — provisioning feedback + archive / restore

**Date:** 2026-07-14
**Status:** approved, implementing
**Repo area:** `spike/seam1/Sources` (WorktreeService, AgentStore, SidebarView, SplitContainer, SplitTree) + `Tests`

Two features in the same subsystem (git worktree tabs), shipped together and
sequenced provisioning-first. The archive design is lifted from **superzed**
(`thread_worktree_archive.rs`): two detached WIP commits + a GC-protection ref,
adapted to Shepherd's model and given a literal 90-day retention.

---

## Feature 1 — Worktree provisioning feedback (ships first)

**Problem:** `AgentStore.newWorktreeTab` runs `git fetch origin` + `git worktree
add` off-main and only opens the tab *after* git returns. A slow fetch looks
frozen — nothing appears in the sidebar or content area until it's done.

**Fix:** provision the tab optimistically with a transient loading state, then
mount the real terminal once the directory exists.

- **Model:** add `var provisioning: Bool = false` to `Pane` (SplitTree.swift).
  Not in `Pane.Codable`'s `CodingKeys`, so it never persists (a restored pane is
  never mid-provision).
- **Flow:** `newWorktreeTab` (local branch) immediately appends a tab with
  `provisioning = true`, `userTitle = <branch name>`, `cwd = <dest>`, selects it,
  then kicks off git off-main.
  - Success → clear `provisioning` on that pane → `GhosttyTerminal` mounts and
    opens the shell in the now-existing `dest`.
  - Failure → remove the tab and show the existing `NSAlert` with git's stderr
    (chosen failure UX).
- **Content render:** `SplitContainer`'s leaf branch renders a
  `WorktreeProvisioningView` (centered, Theme-styled — "Creating worktree
  `<name>`" + a `ScrambleText` animation) whenever `pane.provisioning`. The
  `GhosttyTerminal` surface only mounts after the flag clears, so the PTY never
  `cd`s into a missing dir. Each `ForEach(node.panes)` row still yields exactly
  one layout subview, so `PaneLayout` is unaffected.
- **Sidebar:** while provisioning, `TabRow` renders a breathing dot +
  `ScrambleText` (random characters that grow in length, then reset and grow
  again) in place of the normal glyph/title — the row reads as "loading".
- **`ScrambleText`** (new, reusable): a `Timer`-driven view that re-randomizes a
  mono string and grows its length each tick up to a max, then loops. Used big in
  the content view and small in the sidebar row. `.focusable(false)`.

**Scope:** local worktree creation only. Remote/mirror creation (forwarded to the
host via `cmdNewWorktreeTab`) stays as-is — the provisioning tab is not broadcast
until it finishes (v1 limitation).

---

## Feature 2 — Worktree archive / restore

Turns Shepherd's throwaway worktree tabs into resumable, disk-reclaiming
sessions. Today closing a worktree tab leaks the directory on disk (git worktree
never removed); archive reclaims it while keeping the work fully recoverable.

### Archive mechanics (no branch mutation)

Given a worktree at `root` on branch `B` with tip `H`, snapshot uncommitted work
as two detached commits, touching neither the branch nor the persistent index:

1. `stagedTree = git write-tree` (current index) →
   `stagedCommit = git commit-tree stagedTree -p H -m "shepherd-archive: staged"`.
2. Using a temp index (`GIT_INDEX_FILE`): `read-tree H`, `add -A .`,
   `worktreeTree = write-tree` (captures tracked mods, new files, deletions) →
   `worktreeCommit = git commit-tree worktreeTree -p stagedCommit -m "shepherd-archive: worktree"`.
3. Protection ref `refs/shepherd/archived-worktrees/<id>` → `worktreeCommit`
   (keeps the whole chain alive against `git gc`).
4. `git worktree remove --force <root>` — reclaims the disk (force is safe; the
   dirty state is already snapshotted).

The branch `B` ref is untouched and still points at `H`.

### Restore mechanics

Reproduces the exact staged/unstaged split, including deletions:

1. `git worktree add --detach <dest> <worktreeCommit>` — a clean checkout of the
   full snapshot (deletions handled correctly).
2. If `B` still exists: `git -C <dest> symbolic-ref HEAD refs/heads/<B>` — repoint
   HEAD to the branch (at `H`) without touching the working tree. Else stay
   detached at `H`.
3. `git -C <dest> read-tree <stagedCommit>` — set the index to the staged
   snapshot (leaves the working tree alone).

Result: HEAD = `B`@`H`, index = staged snapshot, working tree = full snapshot —
`git status` shows exactly what it showed at archive time. Then open a tab in
`<dest>`; if the archive carried a Claude `sessionID`, set it on the new pane so
the existing resume path (`takeResumeInput` → `claude --resume <id>`) picks the
agent back up.

### Data model + store

`ArchivedWorktree` (pure, `Codable`, `WorktreeArchive.swift`):
`id, workspaceID, repoDir, branch, name, dest, headCommit, archivedAt, sessionID?`;
`protectionRef` is derived (`refs/shepherd/archived-worktrees/<id>`). Persisted
under a new UserDefaults key `shepherd.archived-worktrees.v1` as JSON — matches
Shepherd's persistence pattern (no SQLite).

### Expiry (GC on launch, literal durations)

On `AgentStore` init (after `restore`), `expireArchives(archives, now:,
retentionDays:)` (pure, testable) partitions by **literal elapsed time**:
`now.timeIntervalSince(archivedAt) >= retentionDays * 86400`. No `Calendar`
day-boundary rounding. Retention = **90 days** (named constant). Each expired
archive: delete the protection ref **and** `git branch -D <B>` (full removal —
chosen expiry scope), then drop the row. A git error on one archive doesn't block
the others.

### UI

- **Worktree detection** via git (`Git.isLinkedWorktree(cwd)`), lazily on hover —
  no new pane field. Works for any linked worktree, not just Shepherd-created
  ones.
- **Close flow:** the context-menu "Close Tab" and ⌘W (`closeSelected`, only
  fires for a non-split tab) route through `requestCloseTab`. For a non-remote,
  single-pane worktree tab it shows an **Archive / Discard / Cancel** alert:
  Archive → archive; Discard → `git worktree remove --force` + close (reclaims
  disk, no leak); Cancel → nothing. Non-worktree tabs close unchanged.
- **Explicit action:** `TabRow` right-click → "Archive Worktree", shown only when
  the hover git-check found a linked worktree in a non-remote workspace.
- **Restore surface:** each expanded workspace folder gets a collapsible
  **"Archived (N)"** subsection under its tab rows — dimmed rows with an archive
  glyph, `name · branch · <age>d`; tap = Restore, right-click = Restore / Delete.
  Age is literal days (`7d`, `30d`, `89d`); under a day shows hours / "today".

**Scope:** local workspaces only. Remote/mirror workspaces disable the
archive/restore UI (consistent with the existing "worktree git errors on a mirror
are a v1 limitation" stance). A manual "Delete" uses the same full-removal
semantics as expiry (branch included).

---

## Files touched

- `SplitTree.swift` — `Pane.provisioning`.
- `WorktreeArchive.swift` (new) — `ArchivedWorktree`, `expireArchives`,
  `archiveAgeString`, protection-ref name. Pure; unit-tested.
- `WorktreeProvisioningView.swift` (new) — `WorktreeProvisioningView` +
  `ScrambleText`.
- `WorktreeService.swift` — `Git` shell additions: env-aware `run`,
  `isLinkedWorktree`, `worktreeInfo`, `archiveWorktree`, `restoreWorktree`,
  `deleteArchive`, `removeWorktree`.
- `AgentStore.swift` — provisioning flow rewrite; `archivedWorktrees` store +
  load/save + GC-on-launch; `archiveWorktreeTab` / `restoreWorktree` /
  `deleteArchive` / `requestCloseTab` / discard + a shared worktree-error alert;
  `newTab(inWorkspace:cwd:sessionID:)`.
- `SplitContainer.swift` — provisioning render branch.
- `SidebarView.swift` — TabRow provisioning row + hover worktree-status + Archive
  menu + `requestCloseTab` wiring; `ArchivedSection`.
- `project.yml` — add the two new app sources + the test file to `sources:`.
- `Tests/WorktreeArchiveTests.swift` (new) — round-trip, expiry boundary, age.
- `.claude/adr/0018-worktree-archive-and-provisioning.md` (new).

## Testing

Pure coverage in `ShepherdModelTests` (`WorktreeArchiveTests.swift`):
`ArchivedWorktree` Codable round-trip, `expireArchives` at the literal 90-day
boundary (just-under kept, just-over expired), and `archiveAgeString` day math.
Then `xcodegen generate`, build Debug, and run the test target.

## Known limitations (v1)

- Archive/restore/provisioning are local-only; mirror workspaces don't get them.
- Orphaned archives (owning workspace deleted) don't surface in the sidebar but
  still expire via GC.
- Restore of a linked worktree assumes the main repo at `repoDir` still exists.
