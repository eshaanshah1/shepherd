# Sidebar: Shipped and Not Shipped — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The task rail has exactly two regions — an unlabelled **active** list that new tasks are appended to and that never re-orders itself, and a **Shipped** block below it holding dimmed one-line rows. Moving between them is a gesture the user makes, never something the app decides. A search field at the very top filters both.

**Architecture:** Almost all of it is one file. `extensions/tasks/src/index.ts` computes the three attention sections (`Waiting on you` / `In flight` / `Resting`) on the fly from each task's agent state and pins a `Shipped this week` row to the window bottom with `foot: true`; replacing that with two regions is a rewrite of ~60 lines in `getChildren` plus a new pure ordering module beside `model/expiry.ts`. Three things outside that file: the search needs a declared seam (a tree view has no way to accept a query today), the ship button needs a `confirm` on the row contract (the shell has no confirm primitive at all), and two glyph names need adding to the allow-list. The `archive`/`restore` **vocabulary is unchanged in code** — only labels and icons say Ship.

**Tech Stack:** TypeScript (ESM, `erasableSyntaxOnly`), vitest, pnpm workspaces, Electron.

**Decision record:** This plan IS the record — it came out of a design interview, and every choice below was made explicitly. The reasoning for the load-bearing ones is inline, marked **Why**, because the codebase currently argues with itself about this exact question (see the trap below).

## Global Constraints

- **Every command runs from `v2/` and takes `env -u NODE_OPTIONS`.** An ambient `NODE_OPTIONS` makes Electron exit 9 before running a line of our code, and the symptom is every check failing at once with no output explaining why.
- The gate for every task is `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`.
- **`pnpm smoke:m3` is required before this is called done.** It drives the real Electron app through the real bus. This plan changes the archive-on-close trigger, and that trigger is the exact thing whose unit tests all passed while it was broken in the app — a test that supplies both halves of a correlation cannot discover that the two halves disagree.
- **`v2/tooling/eslint/boundaries.js` IS the architecture diagram.** This plan adds no import that crosses a new boundary. `extensions/tasks/src/**` must not import from `extensions/tasks/ui/**`.
- **An extension never names a vendor, and the shell never knows what a task is** (ADR 0031). The search box and the confirm below are therefore *declared* by the extension and *drawn* by the shell — the shell must not learn that a row is a task, and must not filter rows itself.
- Comments follow the repo rule: the non-obvious *why*, never a narration of the change or a recap of the bug. One short line is the ceiling unless the reasoning is genuinely load-bearing.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- Work stays on branch **`sidebar-shipped-sections`** (already created).

## The trap that matters most: this file has flipped on this question before

`extensions/tasks/src/index.ts` contains two comments that contradict each other, roughly 700 lines apart:

- At the tree's declaration (~line 2795): *"A FLAT list, newest first. It was grouped by state, and the grouping was an invention: tasks are independent pieces of work, so bucketing them asserts a relationship they do not have."*
- At `getChildren` (~line 3117): *"A state-grouping was removed from here once, on the argument that it 'sorted live tasks into buckets they have no relationship through'. That argument was about categorising; this is about ORDER … The bucket names are the design's and are not negotiable per-state."*

So state-grouping was removed, argued back in, and the losing comment was never deleted. **This plan removes it again, and the removal is a product decision, not a cleanup.** Delete *both* stale comments and replace them with the one below, or the next reader will find the §5 argument, conclude the sections were lost by accident, and put them back.

**Why the sections go:** they encode *distance from needing you*, which is a machine's opinion about priority. The user's position is that a status dot already carries that, an active list is realistically 3–8 rows, and scanning 3–8 rows for a coloured dot is a glance. Against it: a blocked task in an append-ordered list of fifteen is row nine with an amber dot and nothing floats it. That was raised and accepted — **no re-ordering, no exceptions**, because a row that moves under the cursor when a task's state changes is the cost the append order exists to avoid. Do not reintroduce a "just one section for blocked" compromise.

## File map

| File | Responsibility | Task |
| --- | --- | --- |
| `extensions/tasks/src/model/order.ts` *(new)* | Pure: active order, shipped order, and the shipped cap. | 1 |
| `extensions/tasks/src/model/order.test.ts` *(new)* | Its tests. | 1 |
| `extensions/tasks/src/model/index.ts` | Barrel export. | 1 |
| `packages/ui/src/glyphs.ts` | `ship` / `unship` in the allow-list — and `check`, which is missing today. | 2 |
| `extensions/tasks/src/index.ts` | The two regions; the ship/unship buttons; shelve/materialize split; the killed trigger; the query. | 3, 5, 6, 7, 8 |
| `extensions/tasks/src/index.test.ts` | Its tests — the section assertions all change. | 3, 5, 6, 8 |
| `extensions/tasks/ui/card-data.ts` | `shipped?: boolean` on `CardData`. | 4 |
| `extensions/tasks/ui/task-card.tsx` | The dimmed one-line form. | 4 |
| `extensions/tasks/ui/task-card.test.tsx` | Its tests. | 4 |
| `packages/sdk/src/api-layout.ts` | `confirm?` on a row action; `search?` on a tree view. | 7, 8 |
| `packages/app/src/renderer/view-dock.tsx` | Draw the search field; ask the confirm; stop pinning a foot. | 7, 8 |
| `packages/app/src/renderer/view-dock.test.tsx` | Its tests. | 7, 8 |
| `packages/app/src/renderer/extension-ui.ts` | Thread the search declaration to the dock. | 8 |
| `extensions/tasks/src/manifest.ts` | Declare `tasks.filter`. | 8 |

---

### Task 1: Ordering and the cap (pure)

**Files:**
- Create: `extensions/tasks/src/model/order.ts`
- Create: `extensions/tasks/src/model/order.test.ts`
- Modify: `extensions/tasks/src/model/index.ts` (barrel)

**Interfaces:**

```ts
/** Live tasks, oldest first — a new task is APPENDED and nothing above it moves. */
export function activeOrder<T extends Ordered>(tasks: readonly T[]): readonly T[]

/** Shipped tasks, most recently shipped first. */
export function shippedOrder<T extends Ordered>(tasks: readonly T[]): readonly T[]

/** The shipped rows to draw, and how many are not being drawn. */
export function capShipped<T>(tasks: readonly T[], cap: number, all: boolean): {
  readonly shown: readonly T[];
  readonly hidden: number;
}

interface Ordered {
  readonly createdAt: number;
  readonly activatedAt?: number;
  readonly archivedAt?: number;
}
```

**Why `activatedAt`:** un-shipping a three-week-old task must put it at the *bottom* of the active list, because you un-shipped it to work on it now. Sorting by `createdAt` would drop it at the very top, above everything current, and shift every row below it. So the active sort key is `activatedAt ?? createdAt` — a field written on un-ship and nowhere else. No migration: every existing record has no `activatedAt` and falls back to `createdAt`, which is where it already sits.

**Note the deliberate divergence from `model/expiry.ts`:** that module refuses to fall back `archivedAt → createdAt`, because dating a shelving to when the *work started* would delete a snapshot early. Ordering has no such consequence — the worst case is a pre-`archivedAt` record sorting by the wrong timestamp — so `shippedOrder` does fall back. Say so in a comment or a reader will "fix" one of the two to match the other.

- [ ] **Step 1: Write the failing tests.** Cover: a task created later sorts after one created earlier; a task with `activatedAt` sorts by it and not by `createdAt`; `shippedOrder` puts the newest `archivedAt` first; a record with no `archivedAt` falls back to `createdAt`; `capShipped` with `all: true` returns everything and `hidden: 0`; with fewer items than the cap returns everything and `hidden: 0`; with more returns exactly `cap` and the correct remainder. Ties must be **stable** — assert two tasks with identical timestamps keep their input order, because an unstable sort makes rows swap places on an unrelated refresh, which is the exact thing append order promises cannot happen.
- [ ] **Step 2: Implement.** `SHIPPED_CAP = 8`, exported from this module. Hardcoded, not a setting — a setting for it is a preference nobody has asked for and a settings key is a permanent contract.
- [ ] **Step 3: Export from the barrel, run the gate.**

---

### Task 2: The glyphs

**Files:** `packages/ui/src/glyphs.ts`

**A live bug to fix on the way past:** the task row's existing `primaryAction` declares `icon: 'check'` (`extensions/tasks/src/index.ts:3307`), and `check` **is not in `NAMED_GLYPHS`**. `namedGlyph` falls back to `IconDots`, so the hover button on every task row draws three dots today and always has. The allow-list's own comment predicts this — *"a name that is not here draws the fallback rather than nothing, because a hover action with no glyph is an invisible button"* — and nothing tests that a declared icon resolves.

- [ ] **Step 1: Add `ship: IconShip`, `unship: IconArrowBackUp`, `check: IconCheck`.** One line each, which the file says is the point.
- [ ] **Step 2: Add a test that every icon name declared anywhere in `extensions/**` resolves to something other than the fallback.** This is the test whose absence let `check` ship. Grep-based is fine and honest; a hand-maintained list is not, because it will drift the same way.

---

### Task 3: Two regions (the core change)

**Files:** `extensions/tasks/src/index.ts` (`getChildren`, ~3109–3401), `extensions/tasks/src/index.test.ts`

**What goes:**
- `waiting`, `inFlight`, `resting` and the `section()` helper — delete them.
- `foot: true` on the shipped row. **The dock's foot machinery stays** (`view-dock.tsx:307-309, 611-620` and its tests): `foot` is a general `TreeItem` capability and tasks is merely its only current user. Removing a shell capability to change one extension's layout is the wrong direction of blast radius.
- The `Shipped this week` label. It has never been windowed to a week — `done` is every archived task ever — so the label has been lying since it shipped. It becomes `Shipped` plus a true count.

**What the rows become, in order:**
1. Every live task, `activeOrder`, **no heading above them**. Full `tasks.card` as today.
2. The `Shipped` divider — `section: true`, `label: 'Shipped'`, `description: String(done.length)` (the *true total*, including rows past the cap), drawn **only when `done.length > 0`**. This reverses today's deliberate "draw it even at zero so the foot does not move"; that argument was about a row pinned to the window bottom, and a divider that flows after the active list has nothing to hold still.
3. `capShipped(shippedOrder(done), SHIPPED_CAP, tabsExpanded.has(SHIPPED_KEY))` — dimmed one-line rows.
4. When `hidden > 0`, a final row reading `Show all N` whose command is the existing `TASK_COMMANDS.expandTabs` with `SHIPPED_KEY`. **Reuse that command, do not add one:** it already means "this row is showing a subset, toggle it", it already holds its state in the in-memory `tabsExpanded` set, and the shipped drawer is already one of its keys.

**Rows in the shipped region:**
- `component: 'tasks.card'` with `shipped: true` in `data` (Task 4).
- **No `collapsed`, no children.** An archived task's tabs were captured into its record and closed; a chevron here opens nothing.
- `primaryAction` = `{ id: TASK_COMMANDS.restore, label: 'Unship', icon: 'unship' }`. Un-ship is `tasks.restore` — there is no new command, because restoring *is* un-shipping.
- `actions` keeps Reveal / Delete, with Restore relabelled to match.

**Rows in the active region:**
- `primaryAction` = `{ id: TASK_COMMANDS.archive, label: 'Ship', icon: 'ship' }` — the same button that exists today, renamed and given a glyph that resolves. Task 7 adds its guard.

- [ ] **Step 1: Update the tests first, and expect a lot of them to change.** `index.test.ts:1248`, `1254`, `1411`, `1425`, `2189`, `2199` all assert the old sections or the old foot. Rewrite them as assertions about the new shape: rows before the divider are live and in append order; the divider carries the true total; at most `SHIPPED_CAP` shipped rows are drawn plus a `Show all` row; no divider at all when nothing is shipped; a shipped row declares no children.
- [ ] **Step 2: Implement `getChildren`'s new body.**
- [ ] **Step 3: Delete both stale comments** described in the trap section and write the replacement.
- [ ] **Step 4: Run the gate.**

---

### Task 4: The dimmed one-line shipped row

**Files:** `extensions/tasks/ui/card-data.ts`, `extensions/tasks/ui/task-card.tsx`, `extensions/tasks/ui/task-card.test.tsx`

Add `readonly shipped?: boolean` to `CardData`. When set, `TaskCard` renders **mark · title · elapsed** on one line at reduced emphasis, and draws no diff, no repo chips, no tab marks, no summary. One component, one boolean — not a second component, because it is the same record and shared styling between two components drifts.

**The mark stays.** `markOf` already maps `archived → 'shipped'`, so a shipped row draws the shipped mark rather than a resting ring. Keep that: it is what tells you a row in this region is finished rather than idle. The dimming is opacity/colour on the row, not the removal of its status.

- [ ] **Step 1: Test that a `shipped: true` card renders no diff / repos / tab strip, and still renders its mark and title.**
- [ ] **Step 2: Implement. Style in the existing card CSS, not inline.**
- [ ] **Step 3: Run the gate.**

---

### Task 5: Split shelving from the lifecycle flip

**Files:** `extensions/tasks/src/index.ts` (`tasks.archive` ~2602, `tasks.reveal` ~2484, `tasks.restore` ~2713)

Three verbs currently each do two things at once, and the new design needs the halves separately. Extract two local helpers and express all three verbs in terms of them:

```
shelve(task)      → capture resume targets, snapshot each worktree into refs/shepherd/*,
                    capture tabs, close the root, rm -rf the task root. Returns warnings.
                    Touches NO lifecycle field.
materialize(task) → provision the worktrees, replay the archives, consume them,
                    rebuild the tabs / resume the sessions. Touches NO lifecycle field.
```

Then:
- `tasks.archive` = `shelve` + `lifecycle: 'archived'` + `archivedAt`.
- `tasks.restore` = `lifecycle: 'running'` + **`activatedAt: now`** + `materialize`. The new field is what puts an un-shipped task at the bottom of the active list.
- `tasks.reveal` on an archived task = **`materialize` only** (today it invokes `tasks.restore`, at `index.ts:2506`). This is the behaviour change that makes an always-visible shipped list safe: clicking a shipped row rebuilds its worktrees so you can look at the work, and the row stays shipped. Un-shipping is the explicit `Unship` button from Task 3.

**Why this is not optional:** with Shipped collapsed behind a drawer, "clicking it brings it back" was a reasonable reading of a deliberate gesture. With shipped rows permanently on screen and dimmed, a stray click on something from three weeks ago would silently drag it into the active list and re-provision git. The comment at `index.ts:2490` (*"An archived task is brought BACK by looking at it"*) must be rewritten, not left contradicting the code.

- [ ] **Step 1: Test that revealing an archived task materializes it and leaves `lifecycle === 'archived'`; that `tasks.restore` flips it and stamps `activatedAt`; that a restored task sorts last in the active list.**
- [ ] **Step 2: Extract the helpers.** Pure refactor first — assert the existing archive and restore tests still pass unchanged before wiring `reveal` to `materialize`.
- [ ] **Step 3: Point `reveal` at `materialize`, rewrite the comment, run the gate.**

---

### Task 6: Closing panes frees the disk; it does not ship

**Files:** `extensions/tasks/src/index.ts` (the `ROOT_CLOSED_TOPIC` handler, ~1030–1054)

Closing a task's last pane currently invokes `tasks.archive`, which both tears the worktrees down **and** ships the task. The ship half contradicts the design. The teardown half is the only thing on this machine that reclaims a worktree, and **that is not a small number** — measured on the user's install:

| | Size |
| --- | --- |
| One active task's worktree | **838 MB** |
| └─ `node_modules` inside it | 807 MB |
| └─ the checkout itself | 31 MB |
| Every shipped task on the machine, combined | **16 KB** |

So a shipped task costs kilobytes and an active one costs most of a gigabyte, because provisioning installs dependencies into every worktree. Deleting the teardown along with the auto-ship would have meant every task the user opens and drifts away from holds ~840 MB indefinitely.

**New behaviour on `groupEmpty` — one rule, no lifecycle branch:** `shelve(task)`, and **never touch the lifecycle.** Closing the panes snapshots the uncommitted work and removes the worktrees, whatever state the task is in. A running task stays in the active list; a shipped one stays shipped. Nothing moves between regions without the user pressing a button.

**This introduces a task that is active with no worktrees on disk**, which is new. Three consequences:

- **`shelve()` writes `shelvedAt`**, and `materialize()` clears it. That field is the marker for "the work is in a snapshot, not in a directory".
- **`tasks.reveal` materializes whenever `shelvedAt !== undefined || lifecycle === 'archived'`** — not on lifecycle alone. The lifecycle clause is only there for records archived before this field existed; new ones carry both. Do not use `archives.length > 0` as the marker: a task with no repos shelves to an empty `archives` and still needs its generated root re-materialized.
- **Its status dot is the ordinary resting mark**, and its row description says `shelved`. No new mark: nothing is happening to it, which is what resting means, and the word carries the part a colour cannot. Clicking it re-provisions, which for a JS repo means a dependency install — so the row shows `busy` throughout, which `whileBusy` already does.

- [ ] **Step 1: Test that closing a running task's pane group shelves it and it stays `running` with `shelvedAt` set; that closing an archived task's group re-shelves it and it stays `archived`; that revealing a shelved running task materializes it and clears `shelvedAt`; that a shelved task's row says so.**
- [ ] **Step 2: Implement.** Rewrite the handler's comment block — it currently argues at length that closing every window means the task is done, which is the half being reversed.
- [ ] **Step 3: `pnpm smoke:m3`.** This trigger is the one that shipped broken with a green unit suite. Do not skip it here.

---

### Task 6b: Shipped work stops expiring

**Files:** `extensions/tasks/src/index.ts` (`sweep`, ~1077–1093), `extensions/tasks/src/model/expiry.ts` *(delete)*, `extensions/tasks/src/model/expiry.test.ts` *(delete)*, `extensions/tasks/src/model/index.ts`

An archived task is deleted 7 days after shipping — record, scrollback and all. Its git snapshot survives in `refs/shepherd/*` (the delete leaves those alone, deliberately) but nothing in the app can reach it again.

**That sweep is removed.** It reclaims **16 KB** across every shipped task on the machine, while the region it empties is now a permanent, searchable record of finished work. Deleting a user's history to free kilobytes is a bad trade, and it was only ever a reasonable one when Shipped was a collapsed drawer nobody read — which is what the module's own justification says (*"a shelf that fills up is one nobody trusts"*).

**Delete the module, do not leave it unused.** This is the opposite call from `foot: true` in Task 3, and the difference is the point: `foot` is a general *capability* another extension could use, whereas `expiry.ts` is a *policy* this app no longer has. An unused policy module whose tests assert a behaviour the app does not perform is worse than no module — the next reader will wire it back up.

- [ ] **Step 1: Delete the sweep, its call site (~line 3417), the `ARCHIVE_TTL_MS`/`expired` import, the module, its test, and the barrel export.**
- [ ] **Step 2: Check `index.test.ts` for expiry assertions** and remove them. Anything asserting a task disappears with age is now asserting the opposite of the design.
- [ ] **Step 3: Run the gate.**

---

### Task 6c: The ignored-files warning must summarize, not enumerate

**Files:** `extensions/tasks/src/model/archive.ts` (`planArchive`, ~50–70), `extensions/tasks/src/model/archive.test.ts`

Shelving a worktree already deletes `node_modules` — `git worktree remove --force` deletes gitignored files (`provision.ts:244`) and the task root is then `rm -rf`'d. Nothing needs adding for that.

What does need fixing is the warning built beside it. `planArchive` joins **every** ignored path into one string:

```ts
`${state.ignoredPaths.length} ignored file(s) will be DELETED and are not in the archive: ` +
  `${state.ignoredPaths.join(', ')}. Git-ignored files are not captured by the snapshot.`
```

Measured in the shepherd worktree: **42,643 ignored paths, 42,170 of them under `node_modules`** — roughly **1.7 MB in a single warning string**, which `tasks.archive` returns across the IPC port and `index.ts:2705` writes to the log as one line. Every shelve of a JS repo does this, and Task 6 makes shelving happen far more often than shipping ever did.

It is also the wrong information. A per-file list of a dependency tree is noise; the actionable fact is which top-level directories go.

**Summarize by top level, cap the detail:** report the count, then the distinct first path segments (`node_modules/`, `dist/`, …) rather than the paths, and list individual files only when there are few enough to be worth reading — a handful, not tens of thousands. The message stays one line and stays honest about the count.

- [ ] **Step 1: Test that many paths under one directory produce a message naming the directory and not the files; that the total count is still reported; that a couple of loose files are still named individually; that the message length is bounded regardless of input size.**
- [ ] **Step 2: Implement in the pure model — this is `planArchive`'s decision, and it is already a pure function with tests.**
- [ ] **Step 3: Run the gate.**

---

### Task 7: The ship guard

**Files:** `packages/sdk/src/api-layout.ts`, `packages/app/src/renderer/view-dock.tsx`, `extensions/tasks/src/index.ts`, `view-dock.test.tsx`

The ship button is about to become a hover-discoverable one-click control on every row, and pressing it kills the task's panes — including a running agent mid-turn. Shipping an idle task should stay instant; shipping a live one should ask.

**There is no confirm primitive in the SDK** — verified, nothing in `api-layout.ts` and no `Confirm` in `@shepherd/ui`. The extension cannot raise one itself either: its service half is in a utility process with no React. So the row **declares the question and the shell asks it**, which is the rule every other row verb already follows:

```ts
// On TreeItemAction / primaryAction:
/** Ask this before invoking. Absent means invoke immediately. */
readonly confirm?: string;
```

The dock raises the existing `Modal` from `@shepherd/ui` with that string, and invokes only on confirm. The shell still knows nothing about tasks — it draws a question it was handed.

Tasks sets `confirm` on the ship action **only when the task has a live agent** — `markFor(task, stateOf(task))` is `working` or `waiting`. An idle or failed task ships on one click.

- [ ] **Step 1: Test that an action with no `confirm` invokes immediately; that one with `confirm` invokes only after confirmation and not on dismiss; that a task with a working agent declares it and a resting one does not.**
- [ ] **Step 2: Add the field, the dock's modal, and the extension's condition.**
- [ ] **Step 3: Run the gate.**

---

### Task 8: The search field

**Files:** `packages/sdk/src/api-layout.ts`, `packages/app/src/renderer/extension-ui.ts`, `packages/app/src/renderer/view-dock.tsx`, `extensions/tasks/src/manifest.ts`, `extensions/tasks/src/index.ts`, tests for each

A `TreeDataProvider` is `children(parent)` and nothing else, so today there is nowhere for a query to live. The extension must own it: only the extension knows the full shipped list (the shell never receives the rows past the cap) and only the extension controls `collapsed`. A shell-side filter over the rows it happens to have could do neither.

**The seam** — a tree view declares that it wants a search field:

```ts
| {
    readonly kind: 'tree';
    readonly data: TreeDataProvider;
    readonly title?: string;
    /**
     * A field above the rows. Each change invokes `command` with `{ query }`;
     * the provider is expected to answer differently and fire `onDidChange`.
     */
    readonly search?: { readonly command: string; readonly placeholder?: string };
  }
```

The dock draws the field **at the very top of the sidebar, above every view**, debounced, and invokes the command. This mirrors how the shipped drawer's expand already works: a command mutates in-memory extension state and calls `changed()`.

**Tasks' side** — a `tasks.filter` command (declared in the manifest **without a `title`**, following `tasks.presentation`: an untitled command stays out of the ⌘K palette, and "Tasks: Filter" there would be a verb with no meaning to pick). It stores the query in a module-level `let` beside `tabsExpanded` — in memory, never persisted, because after a restart nobody has typed anything.

**Matching:** `fuzzyFilter` from `@shepherd/sdk` (the same function ⌘K uses) over **the task title plus its repo names**, so `railsapp` finds every task touching that repo.

**Filtering behaviour when the query is non-empty:**
- Both regions narrow to matches. The divider stays, so you can see which side a hit is on.
- **Shipped matches are not capped.** Search is how you reach the 40th shipped task; a cap here would make the cap a dead end.
- The divider's count becomes the number of *matching* shipped tasks — a total that ignores the filter is a number that contradicts the rows under it.
- **A matching active row is drawn expanded**, revealing its tabs, so a multi-repo hit can be jumped into directly. This is the one place the query touches `collapsed`, and it is why the query has to be the extension's.
- No new keyboard shortcut. ⌘F is the terminal's find and must not be taken; click to focus.

- [ ] **Step 1: Test the extension half** — a query narrows both regions; a shipped match past `SHIPPED_CAP` is returned; the divider count reflects the filter; a matching active row comes back expanded; an empty query restores the capped, unexpanded shape exactly.
- [ ] **Step 2: Test the shell half** — a view declaring `search` draws a field, a view without one draws none, and typing invokes the declared command with the query.
- [ ] **Step 3: Implement, SDK field first, then dock, then extension.**
- [ ] **Step 4: Run the gate.**

---

### Task 9: Verify for real

- [ ] **Step 1: Full gate** — `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`.
- [ ] **Step 2: `env -u NODE_OPTIONS pnpm smoke:m3`.**
- [ ] **Step 3: `env -u NODE_OPTIONS pnpm ship --dev`** and hand it to the user in Shep Night. A green suite is not a working rail, and the things this plan changes are visual: whether the divider sits where the reference image puts it, whether dimmed rows are dim enough to ignore and legible enough to read, and whether the ship button is discoverable on hover without being easy to hit by accident.

## Decisions taken, for the next reader

| Question | Answer |
| --- | --- |
| Auto-ship on pane close | Killed. Worktrees stay on disk until shipped; that cost is accepted. |
| Clicking a shipped row | Opens it, stays shipped. Un-ship is its own button. |
| Active order | Oldest first, appended, never re-ordered — `activatedAt ?? createdAt`. |
| Shipped bound | Most recent 8, true total on the divider, `Show all` for the rest. |
| Shipped layout | Flows after the active list. Not pinned; `foot: true` unused but not removed. |
| Shipped rows | One line, dimmed, keeps its mark, no children. |
| Attention routing | Gone. The dot is the whole signal. No blocked-first exception. |
| Active heading | None. |
| Empty shipped | No divider. |
| Un-ship position | Bottom of the active list. |
| Ship guard | None when idle, declared `confirm` when an agent is live. |
| Search matches | Title + repo names, fuzzy, reaches past the cap, expands hits. |
| Search ownership | Extension holds the query; the view declares the field. |
| `archive` → `ship` | UI labels and icons only. Command ids, lifecycle values and stored records unchanged. |
