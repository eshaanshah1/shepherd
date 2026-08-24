# The Shell row: a terminal that is not a task

Date: 2026-08-24
Scope: `v2/` only. Nothing under `spike/` is touched.
Status: **built, with four changes made while building it.** ADR 0047 is the
record of what shipped; this file is the reasoning it came from, amended below
rather than rewritten, so the wrong turns stay legible.

## What changed after this was written

Read these four before trusting a section below. Each is marked inline where it
bites.

1. **`TreeItem.head` does not exist.** It was built, then reverted: the dock
   renders one section per view and merges rows only within a section, so a
   row-level position claim can only reorder its own siblings. The claim is
   `ViewProvider.head` — a view-level boolean. §2 is superseded.
2. **There is no head row at all.** `TreeView` now draws the tree's declared
   `title` as a `SectionLabel`, which `ComponentView` has always done and a tree's
   was read by nothing. A row at the rows' own size and weight read as a fourth
   sibling. So the region's name, count and click are not a row's: the name is the
   view's, the count is gone, and ⌘0 is the navigation. §1's parent row is
   superseded; `tasks` gains a `Tasks` heading as the accepted cost.
3. **A shell is a root with a PANE in it.** The pane-less home root was listed and
   drew a permanent `Empty` row standing for nothing that could not be closed. It
   is filtered out — which retires §3's undeletable-first-row cost rather than
   paying it — and a section left with nothing in it is not drawn at all.
4. **An exact root match beats its group's.** §1 assumed the dock's group
   comparison would light the head row; it lit *every* row of the group, because
   every shell is a tab of one group. Narrowed in the dock, with the group
   comparison kept as the fallback that keeps a task row lit.

Three of those four were found by looking at the rail. Forty-four green unit tests
reached none of them.

## What this is

One rail row, labelled `Shell`, whose children are the tabs of the home group.
It gives a terminal that belongs to no task a place in the only navigation the
app has, and it gives ⌘0 somewhere to land.

It is D9's loose tab, finally drawn. What D9 asked for was "its own persisted
list, cwd and title only, never a resumed agent". The list turns out to already
exist. What was missing was a surface.

## The problem, measured

Opening a task-less terminal already works. `⌘T` is `COMMANDS.newTab` →
`layout.newTab` (`packages/app/src/main/menu-template.ts:98`), whose group
defaults to the active root's and whose cwd defaults to the focused pane's
(`packages/core/src/layout/commands.ts:531`). On the home root that is a
plain shell with no task, no worktree and no branch. Inside a task it is another
tab of that task, in the worktree. Both are correct.

The gap is getting back. Three facts, together:

1. `window-1` is minted empty at launch (`packages/app/src/main/index.ts:1377`)
   and nothing contributes a rail row for it. Every row in the rail comes from a
   contributed view, and a row names a root (ADR 0035).
2. `TabStrip` draws only the siblings of the active group
   (`packages/app/src/renderer/app.tsx:571`), so a shell tab vanishes from the
   strip the moment you switch to a task.
3. The palette lists commands, not roots (`app.tsx:283-295`). Nothing but
   `smoke-support.ts:149` and `remote-present.ts:101` ever invokes
   `layout.openRoot { root: 'window-1' }`.

So the only route back to a loose shell is closing a task's tabs until
`closeRoot` falls through to `homeRoot` (`commands.ts:720`). A destructive
gesture is the navigation. That is what makes a bare terminal feel like it is
fighting the app: not that it cannot be opened, that it cannot be found.

## What was decided

Four answers, from the brainstorming conversation. Every section below is
downstream of one of them.

1. **One permanent row, tabs under it.** Not a section of peers, one row per
   shell. A one-off must cost a tab and never a rail row, because one-offs are
   the commonest case and ten abandoned ones would otherwise be ten entries in
   the work list.
2. **The row owns `window-1`.** Not a new group. The home root is already what
   everything falls back to, so making it the shells' home means finishing a
   task lands you among your shells instead of in an empty stage.
3. **⌘0 for the way back. ⌘T unchanged.** ⌘T's current meaning, another tab of
   where you are, is right in both places.
4. **Promote is an accelerator, not a migration.** A shell row offers to start a
   task on the repo it is sitting in. It does not carry the pane across.

## 1. The row

A new first-party extension, `extensions/shell/`, contributing one tree view.
`extensions/scratch/` is the shape to copy: `src/` for the service half, no `ui/`
at all, since a tree needs no React.

```
extensions/shell/
  package.json          manifest, id `shepherd.shell`
  src/manifest.ts       the typed copy, asserted identical by manifest.test.ts
  src/index.ts          activate: mirror the group, register the view, three verbs
  src/model/rows.ts     the cap, pure and total
```

Three verbs, and only the first has a `title`, so only the first is in the
palette:

- `shell.reveal` — what ⌘0 runs (§4)
- `shell.promote` — the row action (§5)
- `shell.expandTabs` — the `… +N` toggle, the shape `tasks.expandTabs` already
  has. No title: it means nothing without a row somebody clicked.

Manifest: `id: 'shepherd.shell'`, `activation: ['onStartup']`,
`permissions: ['views', 'layout']`. No `storage`: everything it draws it reads
from `layout.listRoots`, and everything it needs to remember the layout already
persists. No `process.exec`.

It subscribes to the agent-state topic and declares **no permission for it**,
which is deliberate and is the thing to read `extensions/tasks`' manifest comment
about before changing: `events.on` is membership-gated only, while `attention.set`
is what the `attention` permission guards. Nothing here writes state, and
declaring the permission would be the actual violation of ADR 0026's
single-writer rule.

The view is `kind: 'tree'`, `title: 'Shell'`, no `search`.

The parent row — **SUPERSEDED (amendment 2): there is no parent row.** The
section is named by the view's own `title`. Kept for the reasoning about what a
region has to say about itself:

- `id: 'shell'`, `label: 'Shell'`
- `description`: the number of child rows. Not the number of *live* shells: the
  home root with no panes is still a row, and a count that disagreed with the
  rows under it would make one of them invisible in both places at once, which
  is the trap `tasks` records on its `Shipped` heading.
- `root`: the first root of the group that has panes. This is what draws the row
  as selected, and because every shell shares one group, `groupOfRoot` lights it
  whichever shell you are on (`view-dock.tsx:520`).
- `command: { id: 'shell.reveal' }` — the row's click is the same verb ⌘0 runs,
  so the two gestures cannot mean different things. Not a collapse toggle: see
  below, there is no drawer.
- **no `collapsed`.** On an ordinary row it draws nothing (`view-dock.tsx:547`),
  and a chevron that expands nothing is the affordance lie `section` exists to
  avoid.
- `head: true` (see §2)
- `tint`: the rollup over its children, and **absent when no child has agent
  state**. `view-dock.tsx:724` draws no mark for a row that declares none, which
  is right: a rail of plain shells is not five states, it is nothing happening.
  A `claude` in any shell reaches this row, which is what makes one row enough.

### The rail has no nested children, so "under it" means order

`ViewDock` reads a tree with `bridge.children(type)` and **passes no parent**
(`packages/app/src/renderer/view-dock.tsx:149`), and `disclosure` in the row
renderer is `isFoot && row.collapsed !== undefined` (`:547`) — so an ordinary
row's `collapsed` draws no chevron and nothing fetches a second level. `tasks`'
own `children(parent)` branch (`extensions/tasks/src/index.ts:4004`) is
unreachable from the dock; the rail is one flat list.

That is not a gap to fill here. The rail's existing nesting is **order plus an
anchor row**: `tasks` sends `Shipped`, then day headings, then rows, and
`mergeRows` groups them by the anchor each one follows. `shell` does the same,
with `head: true` as its anchor. The children are siblings; the grouping is what
makes them read as children.

It also removes a drawer. With the cap at three, the Shell row's whole cost is at
most four rows, so there is nothing to collapse and the row's click is free to
navigate rather than to expand. `Shipped` needs a drawer because it can hold 28
rows; this cannot.

Shell rows, one per root of the group, sent immediately after the head row:

- `id: 'shell:<root>'`, `label` straight from `listRoots` (never derived here,
  and `'Empty'` for a root with no panes, the way `tasks` does it)
- `root: <root>`, which is the identity the dock derives its highlight from
- `command: { id: 'layout.switchRoot', args: { root } }`. A row may name any
  command its extension is permitted to invoke, and this one holds `layout`.
  There is no need for a `reveal` verb of its own: `tasks.reveal` exists because
  a task's row may have to restore a worktree first, and a shell has none.
- `tint` only when there is agent state for the root's session, so starting
  `claude` in a loose shell gives its row a mark through the machinery that
  already exists, and this extension never learns what an agent is.

### How it reads the group

The same mirror `tasks` keeps, and for the same reason: reads do not cross the
port, so an extension subscribes to an announcement and re-reads through a
command. `extensions/tasks/src/index.ts:715-756` is the pattern to follow line
for line, including reading the answer defensively, because `ok` says the call
succeeded rather than that the value has a shape.

`layout.listRoots` is the single authority. Filter to `group === 'window-1'`.

### The cap

Capped at three rows with a `… +N` overflow, collapsed by default. `tasks` caps
for the reason that applies here too: a parent with eight children pushes every
other row off the rail.

`capTabRows` lives in `extensions/tasks/src/model/tab-rows.ts` and cannot be
imported. The boundary lint is the architecture, not a preference: an extension
reaches `sdk` and `ui`, never another extension. So `shell` gets its own, and a
smaller one, in `src/model/rows.ts`:

- cap 3, overflow row included in the count
- **ranked by urgency, creation order as the tie-break**, the same bargain
  `capTabRows` strikes and for the same reason: a cap that kept shell 1 and
  shell 2 would hide exactly the one that wants you. The order is `shell`'s own,
  pinned to `agents-core`'s union by the compiler (§2).
- **expanded is creation order, and does not promote.** A full list has no room
  problem to solve, and one that reshuffled as agents finished would move the row
  you were reaching for out from under the cursor.
- expanded also emits the way back, exactly as `capTabRows` does. A one-way
  expansion makes a rail that is all one row.

If a third consumer of this cap ever appears, it moves to the SDK. Two is not
enough to share.

## 2. `head` on `TreeItem` — SUPERSEDED (amendment 1)

> Reverted. The field could not work at the row level; the claim is
> `ViewProvider.head`. The reasoning about why section order was undeclarable is
> unchanged and is why the view-level field exists.

The rail cannot currently put this row above the task list. `mergeRows` collects
rows above any heading into a `TOP` group in the order the views were asked
(`packages/app/src/renderer/merge-rows.ts:44-58`), and view order is registration
order, which is activation order, which nothing declares. `TreeItem` has `foot`
and no counterpart.

So add `head?: boolean` to `TreeItem` (`packages/sdk/src/api-layout.ts`, beside
`foot` at :361), documented in `foot`'s own words: it says a position, not a
meaning. The dock still does not know what a shell is, and a contribution that
never sets it flows from the top as before.

`merge-rows.ts` gains one branch: a `head` row anchors a group the way `section`
and `foot` already do (`merge-rows.ts:61-63` is the anchor test), and its group
is emitted **before `TOP`**. Emitting it in Map order is not enough: `group(TOP)`
is seeded eagerly at `:56`, so `TOP` is always the first key and `tasks`' own
un-headed rows would draw above the Shell row.

`view-dock.tsx` needs no change. `top` renders `shown` in order (`:415`), so a
group emitted first is drawn first. The head row is **not pinned** the way `foot`
is, so it scrolls with the list; ⌘0 is the guarantee that it is always reachable,
and pinning is a follow-up if the rail ever gets long enough to need it.

**And nothing else.** An earlier draft of this spec put the urgency order in the
SDK too. That was the wrong home: the words being ordered are `agents-core`'s
state vocabulary (`AGENT_STATES` — `shell`, `idle`, `working`, `blocked`,
`needsCheck`, `error`), not the kernel's, and teaching the SDK about agent states
is the widening the taxonomy rules exist to prevent.

`shell` declares its own order instead, and keeps it honest the way `claude-code`
already does: **type-import `AgentState` from `@shepherd/ext-agents-core/state`**
(one extension may type-import another, never value-import — `boundaries.js`'s
`allowTypeImports`), and let a `Record<AgentState, number>` make `pnpm typecheck`
fail if a seventh state is ever added. Six words duplicated with a compiler
holding them to the union beats a runtime call for a constant.

The alternative was `foot: true`, which works today and needs no SDK change. It
puts the row at the bottom of the rail, next to `Shipped`, in an order neither
extension declares. Rejected in chat.

## 3. The group is `window-1`

`groupOf('window-1')` is `'window-1'` (`store.ts:430`), and the roots of that
group are `window-1` itself plus every `window-1/tab-N` that `⌘T` has minted. The
Shell row draws exactly that set. No new group, no kernel change, no new opaque
string.

What this buys: `closeGroup` and `closeRoot` both fall back to `homeRoot`
(`commands.ts:580`, `:720`), so closing your last task now lands you in your
shells rather than on the empty stage. The empty state appears when you have no
shells either, which is the honest condition for it.

**The wrinkle, stated rather than hidden — and since RETIRED (amendment 3): the
pane-less home root is not a row, so there is nothing undeletable to see.** `closeRoot` refuses the home root
outright (`commands.ts:689`), and closing its last pane empties it rather than
closing it (`store.ts:220`). So the first child row of the Shell row can never be
closed. Its label becomes `Empty` and clicking it shows the empty stage. This is
today's behaviour with a row pointing at it, and it makes the Shell row the place
where "nothing is on screen" lives. Accepted.

## 4. The gestures

`⌘T` is unchanged. Another tab of where you are: a shell on the Shell row, a
worktree tab inside a task.

`⌘0` is new, in the Pane submenu, running `shell.reveal`. **Read
`menu-template.ts`'s opening note before adding it**: AppKit resolves a menu key
equivalent before the page sees the keystroke, so a menu item does not compete
with a contributed overlay on the same key, it silently deletes it. ⌘0 is free.
The menu holds `⌘,` `⌘T` `⌘D` `⌘⇧D` `⌘W` and `⌘⌥`+arrows; `tasks` holds `⌘N` and
`⌘⇧F`; no `resetZoom` role is registered anywhere in the menu, so the ⌘0 many
apps spend on zoom is unspent here; and nothing in `packages/app/src` or
`packages/ui/src` binds the digit.

The digit is also the better word for what this does. It reads as tab zero, home,
the thing before the work, and it leaves ⌘1 through ⌘9 free for per-tab switching
if that is ever wanted.

`shell.reveal` is navigation, not creation, and is idempotent:

1. Read the group's roots.
2. `layout.switchRoot` to the **first root of the group that has panes**, in
   creation order.
3. If none has panes, `layout.openRoot { root: 'window-1' }` with no `cwd`, then
   switch to it.

Step 3 passes no cwd deliberately. `defaultSessionSpec` omits it when a pane has
none and main fills it from `shellDefaults()`, whose cwd is `systemHome()`
(`packages/platform/darwin/src/shell.ts`). So a fresh shell opens in `$HOME`
without this extension reaching `node:os`, which it may not do.

First in creation order, not last focused. Per-group last-focused is not tracked
and teaching the kernel about it is a larger change than this earns; a fixed
landing spot is predictable and the tab strip is right there for the rest. Noted
as an open question below.

## 5. Promote

A `TreeItemAction` on a child row: `Start a task here`, invoking `tasks.create`
with the shell's cwd as its repo. Extension to extension through the command
registry, the way `tasks` already reaches `agents-core`
(`extensions/tasks/src/index.ts:800`).

`tasks.create` declares no `permission`, so this needs no grant beyond being a
loaded extension. D9b's rule still applies: membership in `grants` is required
even for a command with no permission, and a loaded extension has it.

It does not move the pane. A root is fixed to its group at mint
(`store.ts:209-213`), and a task's agent runs in a fresh worktree anyway, so the
shell's cwd would be the wrong directory once the task exists. This saves typing
a path into the composer. That is the whole of the claim.

It needs the pane's cwd, and **`layout.listRoots` already answers with it**:
every root carries `panes: [{ pane, cwd, userTitle, session, … }]`
(`packages/core/src/layout/commands.ts:657-660`). No kernel change, and the
mirror §1 describes is the only read this needs.

Cut this section before the others if the piece needs to be smaller. Everything
above works without it.

## 6. What is already free

Worth writing down, because D9's plan budgeted for both.

**Persistence.** `main/index.ts:1378` opens every persisted root at launch, and a
restored pane reattaches to the session the daemon still holds (ADR 0036, ADR
0041). Loose shells and their live processes already survive a relaunch. D9's
"own persisted list" needs no store; the list was always there with nowhere to be
drawn.

**Marks.** `agents-core` tracks any pane running `claude`, so a loose shell that
becomes an agent gets its mark through the existing channel.

**The fourth use case.** A shell for `pnpm dev` beside a task is already served
by `⌘T` inside the task: in the worktree, tracked as one of that task's tabs,
visible in that task's rail row. It should not pull on this design.

## 7. Empty, one item, failed, loading

- **No shells.** SUPERSEDED (amendment 3). The whole section is not drawn: the
  home root has no panes and so is not a shell, and a heading over blank space
  with no way to fill it reads as broken rather than as quiet. ⌘0 is the way back,
  and it opens a shell when there is none.
- **One shell.** One child row. The row's shape does not change as shells are
  added.
- **Failed.** A shell whose process exited is an existing case (ADR 0028:
  liveness is the shell coming back). No new state, no sixth mark.
- **Loading.** None. `listRoots` is a local command and the mirror is warm before
  the first row is asked for.

## 8. What this does not do

- **No reaper.** Dead shells accumulate under a collapsed, capped row. If that
  turns out to bite, the answer is a row action that closes every shell with no
  live process, not a timer.
- **No titles.** D9 said "cwd and title only". A shell's name is
  `displayTitle`'s answer, which is the user's name if set, else the program's
  OSC title, else a tail of the cwd. `layout.rename` already sets the first. A
  second naming path would be a second answer to a question that has one.
- **No shell as a degenerate task.** D9's refusal stands. A zero-repo task drags
  the lifecycle, the folder and `TaskRootSynth` into the path that exists to
  cost nothing.
- **No special case in the dock.** `view-dock.tsx` is not touched at all; `head`
  lands in the SDK and in `merge-rows.ts`. The dock's claim is that adding
  `tasks` needed no change to it, and "the window's own root" is exactly the
  exception sketch §2b refuses.

## 9. Files touched

**New**

- `v2/extensions/shell/` (package.json, tsconfig, vitest config, `src/manifest.ts`,
  `src/index.ts`, `src/model/rows.ts`, and a test per file)

**Modified**

- `v2/packages/sdk/src/api-layout.ts` — `head?: boolean` on `TreeItem`
- `v2/packages/app/src/renderer/merge-rows.ts` — the `head` group, emitted first
- `v2/packages/app/src/main/menu-template.ts` — ⌘0 in the Pane submenu
- `v2/packages/app/src/shared/commands.ts` — the command id ⌘0 invokes
- `v2/packages/app/src/main/index.ts` — register the extension
- `v2/tsconfig.json` root references — **do not skip this.** M3 found
  `extensions/tasks` missing from it, so `pnpm typecheck` never looked at the
  package and a planted type error produced no output. **It is missing four
  packages right now**: `extensions/scratch`, `extensions/github`,
  `extensions/worktree-hook` and `extensions/transcripts` are all absent from the
  references list while `pnpm typecheck` is `tsc -b` at the root, so none of them
  is typechecked by it today. Adding those four is a separate change from this
  one and wants its own mutation test per package; adding `extensions/shell` is
  part of this one.
- `v2/tooling/eslint/boundaries.js` — only if the new package needs an edge, and
  with the reason in the rule's own comment

Nothing in `packages/core`, and nothing in `packages/app/src/renderer` beyond
`merge-rows.ts`.

## 10. Testing

- `rows.ts`: pure and total, tested the way `tab-rows.ts` is. Under the cap, at
  it, over it, expanded, one item, and a shell whose state the order does not
  recognise ranking as the quiet case rather than ahead of everything.
- The rollup: absent with no agent anywhere, and the loudest child's state when
  there is one.
- The mirror: a `listRoots` answer that is not an array, and one whose rows are
  missing `group`, must produce no rows rather than a `TypeError`. This is the
  defect the composer's first unit test found, and a cast is not a check.
- `merge-rows.ts`: a `head` row's group is emitted **before** un-headed rows from
  another source (the ordering that eager `group(TOP)` would otherwise get
  wrong), a `head` and a `foot` in one list keep their two ends, and two sources
  both claiming `head` merge on the label the way headings do.
- `shell.reveal`: switches when a shell exists, opens when the group is empty,
  and is idempotent under repeats.
- ⌘0 reaches `shell.reveal` through `MENU_INVOCATIONS`.

**No new smoke.** The rule from the M4 punch list: a smoke exists to cover a
correlation a unit test structurally cannot, not because a piece shipped. The
correlation worth covering here, a row's `root` and the dock's highlight, is
already covered by `smoke:m3` for task tabs and is the same code path.

What is **not** machine-checkable and must be looked at: the row's position, the
mark slot staying empty without collapsing, and the divider under the row.
Three of the composer's defects were properties of the CSS rather than the
markup, and 2,000 green tests could not see any of them.

## 11. Docs to update

- `docs/superpowers/plans/2026-08-07-v2-m3-plan.md:479` — D9's section. Its
  design does not change; its status does.
- `docs/superpowers/plans/2026-08-12-v2-m4-punch-list.md:50-62` — item 3 says
  what D9 still wants is "the persisted Scratch list". That was wrong: the list
  persists already. What it wanted was a surface.
- `docs/superpowers/plans/2026-08-08-v2-handoff.md:63` — "What is left" item 1.
- `CLAUDE.md` — the "Scratch (D9) and then M4" line.
- A new ADR for §3, the decision that the shells' group is the home root, with
  the undeletable first tab recorded as its accepted cost.

## Open questions

1. **⌘0's landing tab.** First in creation order, decided above. Last focused per
   group is nicer and needs kernel state. Revisit if the fixed landing annoys in
   use.
2. ~~**Promote's cwd source.**~~ Resolved while planning: `layout.listRoots`
   already returns each root's panes with their cwd. §5.
3. **The divider.** The mockup put a rule between the Shell row and the task
   list. Whether that is a real separator or just the section gap is a question
   for the eye, not the spec.
