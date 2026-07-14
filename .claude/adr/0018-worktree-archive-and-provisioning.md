# 0018. Worktree archive/restore + provisioning feedback

Status: Accepted
Date: 2026-07-14

## Context
Shepherd creates git worktree tabs (`# shepherd:` folder → *New Worktree Tab…*),
but the lifecycle had two rough edges:

1. **Creation looked frozen.** `newWorktreeTab` ran `git fetch origin` + `git
   worktree add` off-main and only opened the tab *after* git returned. A slow
   fetch left nothing on screen — no sidebar row, no content — until it finished.
2. **Closing leaked disk.** Closing a worktree tab dropped the tab but never ran
   `git worktree remove`, so the directory lived on disk forever, and any
   uncommitted work in it was neither reclaimed nor recoverable on purpose.

superzed (`thread_worktree_archive.rs`) solves (2) elegantly: snapshot the
uncommitted work as detached commits, pin them with a GC-protection ref, remove
the directory, and restore later. We lift that design and add a retention policy.

## Decision

### Provisioning feedback
`newWorktreeTab` opens the tab **immediately** with a transient
`Pane.provisioning` flag (branch name as title, target dir as cwd), then runs git
off-main. `SplitContainer` renders a `WorktreeProvisioningView` (loading screen +
`ScrambleText`) for a provisioning pane and **holds off mounting the
`GhosttyTerminal`** until the flag clears — so the PTY never `cd`s into a
not-yet-existent directory. The sidebar row shows a breathing dot + scramble.
Success clears the flag (surface mounts); failure removes the tab and shows the
existing error alert. `provisioning` is never persisted (not in `Pane.Codable`).

### Archive / restore
Archive snapshots the worktree without mutating the branch:
- `stagedTree = write-tree` → `commit-tree -p HEAD` = **staged snapshot**;
- a temp-index (`GIT_INDEX_FILE`) `read-tree HEAD` + `add -A` + `write-tree` →
  `commit-tree -p staged` = **full working snapshot** (mods, new, deletions);
- pin the chain under `refs/shepherd/archived-worktrees/<id>` (survives `git gc`);
- `git worktree remove --force` reclaims the disk. The branch is untouched.

Restore recreates the exact state, deletions included, by checking out the full
snapshot **detached**, then repointing HEAD to the branch and resetting the index
to the staged snapshot:
```
git worktree add --detach <dest> <worktreeCommit>
git -C <dest> symbolic-ref HEAD refs/heads/<branch>   # if the branch still exists
git -C <dest> read-tree <stagedCommit>
```
This reproduces `git status` byte-for-byte. A stored Claude `sessionID` rides the
restored tab so the existing resume path (`takeResumeInput` → `claude --resume`)
picks the agent back up.

### Retention (literal, 90 days)
Archives persist under `shepherd.archived-worktrees.v1` (UserDefaults JSON — no
SQLite, matching Shepherd's persistence). On launch, `expireArchives` drops any
archive whose age is `>= 90 * 86400` seconds and **fully removes** it (protection
ref **and** `git branch -D`). Expiry uses **literal elapsed time**, not
`Calendar` day boundaries — "7d" means exactly 7×24h, deliberately avoiding
"since the start of the calendar day" rounding. A manual *Delete* uses the same
full-removal semantics.

### UI + triggers
- Worktree detection is a lazy on-hover `git rev-parse` check (`isLinkedWorktree`)
  — no new pane field, and it works for any linked worktree.
- Both trigger paths (chosen: "both"): a `TabRow` right-click **Archive Worktree**
  (shown only for a detected worktree), and closing a worktree tab (⌘W /
  context-menu, routed through `requestCloseTab`) offers **Archive / Discard /
  Cancel** — Discard removes the directory so it no longer leaks.
- Restore surface (chosen: per-folder): each expanded workspace folder shows a
  collapsible **"Archived (N)"** subsection; tap a row to restore, right-click to
  restore or delete.

## Scope / limitations (v1)
- Local workspaces only. Remote/mirror workspaces don't get archive/restore or the
  provisioning tab (consistent with the existing "worktree git errors on a mirror
  are a host-side v1 limitation" stance).
- Orphaned archives (owning workspace deleted) don't surface in the sidebar but
  still expire via GC.
- Restore assumes the main repo at `repoDir` still exists.

## Consequences
- Worktree tabs become resumable, disk-reclaiming sessions instead of throwaways.
- The pure model (`WorktreeArchive`) + git-arg round-trip are unit-tested
  (`WorktreeArchiveTests`); the git plumbing was verified end-to-end against a
  scratch repo (staged/unstaged/new/deleted files all round-trip).
- Files: `WorktreeArchive.swift`, `WorktreeProvisioningView.swift` (new); `Git`
  shell additions in `WorktreeService.swift`; store/flow in `AgentStore.swift`;
  render branch in `SplitContainer.swift`; sidebar in `SidebarView.swift`;
  `Pane.provisioning` in `SplitTree.swift`.
