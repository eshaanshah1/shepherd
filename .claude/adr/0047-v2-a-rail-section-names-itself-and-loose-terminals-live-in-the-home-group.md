# 0047. (v2) A rail section names itself, and loose terminals live in the home group

Status: Accepted
Date: 2026-08-24
Scope: `v2/` only.
Extends: [0031](0031-v2-a-contributed-view-declares-itself-and-a-row-click-is-the-extensions.md), [0035](0035-v2-a-row-names-its-root-and-the-shell-derives-the-highlight.md).
Design: [`../../docs/superpowers/specs/2026-08-24-shell-row-loose-terminals-design.md`](../../docs/superpowers/specs/2026-08-24-shell-row-loose-terminals-design.md)

## Context

Opening a terminal that belongs to no task already worked. `⌘T` is
`layout.newTab`, whose group defaults to the active root's, and on the home root
that is a plain shell with no task, no worktree and no branch.

Getting back to one did not. Three facts, together: `window-1` is minted empty at
launch and nothing contributed a rail row for it; `TabStrip` draws only the
siblings of the active group, so a shell vanishes from the strip the moment you
switch to a task; and the palette lists commands, not roots. The only route back
was closing a task's tabs until `closeRoot` fell through to `homeRoot` — a
destructive gesture as the navigation.

This is D9's "loose tab", and D9 budgeted for a store it does not need:
`main/index.ts` opens every persisted root at launch and a restored pane
reattaches to the session the daemon still holds ([0036](0036-v2-a-session-outlives-the-app-so-a-pane-must-be-able-to-find-it-again.md),
[0041](0041-v2-agent-state-outlives-the-app-so-the-daemon-holds-the-hook-socket.md)),
so loose shells and their live processes always came back. What was missing was a
surface.

## Decision

**The shells are the home root's group, and the rail draws a section for them
whose name comes from the view rather than from a row.**

### The group is `window-1`, not a group of its own

`closeGroup` and `closeRoot` both fall back to `homeRoot`, so making it the
shells' home means finishing a task lands you among them instead of on an empty
stage. A separate group would leave the fallback destination and the shells as
two different places, which is the same lostness with an extra row.

The cost this was accepted with was an undeletable first row: `closeRoot` refuses
the home root and closing its last pane empties it rather than closing it, so
`window-1` was always in the list. **That cost is retired rather than paid** — a
shell is a root with a PANE in it, the pane-less home root is filtered out, and
the root that cannot be closed is not a row at all. Which also means a section
with nothing left in it is empty, and an empty section is not drawn.

### A section is named by its view, and the name is not a row

`TreeView` never rendered a tree's declared `title`. `ComponentView` has drawn
its own since it shipped, so `tasks.tree`'s `Tasks` and every later tree's title
were dead strings — invisible while the rail held one list, because the sky strip
named it.

The extension's first attempt was a head ROW carrying the region's name, its
count and its click. On screen it read as a fourth sibling of the rows under it,
and `styles.css`' drawer-handle note had already written down why: *a heading may
be quiet or it may be small; it may not be both while the thing it heads is
neither.* A row at the rows' own size and weight is neither.

So `TreeView` draws `view.title` as a `SectionLabel` and the extension sends no
head row. What that gives up is worth stating: a `SectionLabel` is deliberately
not a button, so the region has no click of its own — `⌘0` is the navigation —
and it cannot be lit as a whole, so while the active shell is behind the overflow
row nothing in the rail is highlighted.

### A view claims the head of the rail; a row cannot

Section order was `views.list()`'s order, which is registration order, which is
activation order — so one section sat above another by luck, and the luck changed
whenever anything touched the activation list.

`TreeItem.head` was built first and reverted. It could not have worked: the dock
renders **one section per view** and calls `mergeRows` once per section, so a row
claiming to be first can only reorder its own siblings. `ViewProvider.head` is
the same claim at the level that can carry it. A boolean rather than a number,
because a number invites a second view picking a bigger one; ties keep
registration order.

### An exact root match beats its group's

[0035](0035-v2-a-row-names-its-root-and-the-shell-derives-the-highlight.md) has
the row name a root and the shell derive the highlight, comparing GROUPS so a
task's row stays lit on the task's second tab. That comparison answers true for
every row of the group, which was correct only while one group meant one row.

Every shell is a tab of one group, so the whole region lit at once. The rule
narrows: if any drawn row names the active root exactly, only that row lights;
otherwise the group comparison stands. A task's tab rows are not drawn, so a task
row is unaffected — and when the active shell is hidden behind the overflow,
nothing matches exactly and nothing lights.

## Consequences

- `tasks` gains a `Tasks` heading it did not have. That is the visible cost of
  drawing a field that was always declared, and it was accepted deliberately.
- `TreeItem.head` does not exist. Anyone wanting a contributed row above another
  contribution's rows wants `ViewProvider.head` on the view.
- **The rail has no nested children, and this is the thing to read before
  reaching for them.** `ViewDock` reads a tree with `children(type)` and passes
  no parent, and `disclosure` is `isFoot && row.collapsed !== undefined` — so
  `TreeItem.collapsed` on an ordinary row draws no chevron and nothing fetches a
  second level. `tasks`' own `children(parent)` branch is unreachable from the
  dock. The rail's nesting is order plus an anchor row, which is what `Shipped`
  and its day headings are.
- A blank `label` from `layout.listRoots` means `$HOME`. Core renders the home
  directory as an empty string deliberately, saying a caller that wants `~` can
  say so; `shell` is that caller, and it matters because a shell `shell.reveal`
  opens has no cwd and lands there.
- **Three of these were found by looking at the rail, not by testing it**: the
  section shrinking below its content and painting over the one below it
  (`.sh-side-view` had `min-height: 0` and a default `flex-shrink`, while
  `:has(.sh-rows-foot)` gives the growth to whichever section has a foot), every
  row of the group drawing selected, and the `Empty` row. Forty-four green unit
  tests reached none of them, which is the class this repo keeps recording.
