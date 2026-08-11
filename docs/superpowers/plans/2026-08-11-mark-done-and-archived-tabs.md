# Mark Done & Archived Tabs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A checkmark on a task row marks it done; archiving preserves every tab, its splits, its cwds and its last 1000 lines of screen; restoring paints all of that back and leaves each agent's resume command staged at the prompt, unsubmitted.

**Architecture:** Three additive seams and one constant. `TreeItem` gains `primaryAction` (the hover control `Row` already has a slot for). `sessions.capture` exposes `SessionMirror.capture`, which already serializes scrollback and has no verb. `sessions.create` gains a `seed` so a restored pane's history is replayed by the **mirror** — meaning a phone attaching later sees it too. `ARCHIVE_TTL_MS` goes from 30 days to 7.

**Tech Stack:** TypeScript (node type-stripping — **no parameter properties, no enums**), Electron, React 19, vitest, pnpm workspaces.

## Global Constraints

- **Every command runs from `v2/` and takes `env -u NODE_OPTIONS`.** An ambient `NODE_OPTIONS` makes Electron exit 9 before any of our code runs.
- Full gate: `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`, then `env -u NODE_OPTIONS pnpm smoke:m3`.
- **`cd` is intercepted by zoxide in this shell.** Use absolute paths — a bare `cd v2` jumps to the primary checkout and you will test the wrong tree.
- `v2/tooling/eslint/boundaries.js` **is** the architecture diagram.
- **An extension never names a vendor.** `kindId` and `resumeTarget` are stored **unread** and handed back unread (D11).
- **`@shepherd/ui` is the design system; do not hand-roll a control.**
- **Answers from `commands.invoke` are `unknown`, and a cast is not a check.**
- Spec: `docs/superpowers/specs/2026-08-11-mark-done-and-archived-tabs.md`.

## File Structure

**Create:**
- `v2/extensions/tasks/src/model/archive-tabs.ts` — **pure**: a layout answer + a record → `ArchivedTab[]`, and back.
- `v2/extensions/tasks/src/model/archive-tabs.test.ts`

**Modify:**
- `v2/packages/sdk/src/api-layout.ts` — `TreeItem.primaryAction`.
- `v2/packages/app/src/renderer/view-dock.tsx` — draw it.
- `v2/packages/core/src/session/commands.ts` — `sessions.capture`.
- `v2/packages/core/src/session/host.ts`, `v2/packages/core/src/session/protocol.ts`, `v2/packages/daemon/src/*` — the `seed`.
- `v2/extensions/tasks/src/store.ts` — `TaskRecord.tabs`.
- `v2/extensions/tasks/src/index.ts` — capture on archive, rebuild on restore, the `primaryAction` on the row.
- `v2/extensions/tasks/src/model/expiry.ts` — 7 days.
- `v2/packages/app/src/main/smoke-m3.ts` — the gate.

---

### Task 1: `TreeItem.primaryAction`, and the row draws it

**Files:**
- Modify: `v2/packages/sdk/src/api-layout.ts`, `v2/packages/app/src/renderer/view-dock.tsx`
- Test: `v2/packages/app/src/renderer/view-dock.test.tsx`

**Interfaces:**
- Produces: `TreeItem.primaryAction?: { id: string; label: string; icon?: string; args?: unknown }`.

- [ ] **Step 1: Write the failing tests**

```tsx
it('draws a row’s primary action, named, in the trailing slot', async () => {
  const rows: readonly TreeItem[] = [
    { id: 't1', label: 'One', primaryAction: { id: 'tasks.archive', label: 'Mark done', icon: 'check', args: { task: 't1' } } },
  ];
  const view = mount(<ViewDock views={bridge(TREE, [], rows)} />);
  await settle();
  const button = one(view.container, 'row-primary-action');
  expect(button.getAttribute('aria-label')).toBe('Mark done');
  view.unmount();
});

it('runs it as the CONTRIBUTING EXTENSION, and does not also run the row', async () => {
  // D14: the click is the user's, the command id is the extension's. And a
  // control inside a clickable row must not fire the row underneath it.
  const calls: Call[] = [];
  const rows: readonly TreeItem[] = [
    {
      id: 't1',
      label: 'One',
      command: { id: 'tasks.reveal', args: { task: 't1' } },
      primaryAction: { id: 'tasks.archive', label: 'Mark done', args: { task: 't1' } },
    },
  ];
  const view = mount(<ViewDock views={bridge(TREE, calls, rows)} />);
  await settle();
  act(() => one(view.container, 'row-primary-action').click());
  await settle();
  expect(calls).toEqual([
    { via: 'invoke', type: TREE[0]!.type, command: 'tasks.archive', args: { task: 't1' } },
  ]);
  view.unmount();
});

it('draws nothing for a row that declares none', async () => {
  const view = mount(<ViewDock views={bridge(TREE, [], [{ id: 't1', label: 'One' }])} />);
  await settle();
  expect(all(view.container, 'row-primary-action')).toHaveLength(0);
  view.unmount();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test -- view-dock`
Expected: FAIL — no `row-primary-action` testid.

- [ ] **Step 3: Declare it in the SDK**

In `v2/packages/sdk/src/api-layout.ts`, on `TreeItem`, after `actions`:

```ts
  /**
   * The row's ONE verb worth a control of its own — drawn in the trailing slot,
   * revealed on hover and on keyboard focus within the row.
   *
   * Declared by the extension for the reason `actions` is: the shell cannot know
   * a row's verbs, and a sidebar that hardcoded a checkmark would be a sidebar
   * that knows what a task is (ADR 0031). Attributed to the CONTRIBUTING
   * EXTENSION, never to the user (D14) — the click is genuinely the user's, the
   * command id behind it is not, and they cannot see it.
   *
   * **Singular on purpose.** A row with three hover buttons is a toolbar, and
   * `actions` already exists for everything else. `label` is required for
   * `IconButton`'s reason: an icon-only control has no accessible name.
   *
   * A client with another surface may draw it as a swipe, a button, or not at
   * all — it is a field on a row, not a desktop gesture.
   */
  readonly primaryAction?: {
    readonly id: string;
    readonly label: string;
    readonly icon?: string;
    readonly args?: unknown;
  };
```

- [ ] **Step 4: Draw it**

In `view-dock.tsx`'s `renderRow`, pass an `IconButton` into `Row`'s trailing slot when `row.primaryAction !== undefined`:

```tsx
              trailing={
                row.primaryAction === undefined ? undefined : (
                  <IconButton
                    icon={raiseIcon(row.primaryAction.icon)}
                    size="sm"
                    label={row.primaryAction.label}
                    title={row.primaryAction.label}
                    data-testid="row-primary-action"
                    onClick={(event) => {
                      // The row underneath has its own command; a control inside
                      // it must not fire both.
                      event.stopPropagation();
                      void bridge?.invoke(entry.key, row.primaryAction!.id, row.primaryAction!.args);
                    }}
                  />
                )
              }
```

Match `Row`'s actual prop for the trailing slot and the file's existing `bridge.invoke` call shape — the assertion that matters is the `via: 'invoke'` attribution, which the test pins. Add `check` to the dock's `ACTION_ICONS` allow-list if it is not already there.

- [ ] **Step 5: Run the tests**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test -- view-dock`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add v2/packages/sdk/src/api-layout.ts v2/packages/app/src/renderer
git commit -m "feat(views): a row may declare one primary action, drawn on hover"
```

---

### Task 2: `sessions.capture`

**Files:**
- Modify: `v2/packages/core/src/session/commands.ts`
- Test: `v2/packages/core/src/session/commands.test.ts`

**Interfaces:**
- Produces: command `sessions.capture { session: string; lines?: number }` → `{ bytes: string }` (base64).

- [ ] **Step 1: Write the failing test**

```ts
it('captures a session’s screen as bytes', async () => {
  const h = harness();                        // the file's existing helper
  const id = h.host.create({ cwd: '/tmp' });
  h.write(id, 'hello\r\n');

  const result = await h.registry.invoke('sessions.capture', { session: String(id) }, USER);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const { bytes } = result.value as { bytes: string };
  expect(Buffer.from(bytes, 'base64').toString('utf8')).toContain('hello');
});

it('refuses a session that is not there, rather than answering empty', async () => {
  // An empty capture and a missing session are different facts, and a caller
  // archiving a pane needs to be able to tell them apart.
  const h = harness();
  const result = await h.registry.invoke('sessions.capture', { session: 'ghost' }, USER);
  expect(result.ok).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- session`
Expected: FAIL — `no command sessions.capture`.

- [ ] **Step 3: Implement**

```ts
    registry.register(SESSION_COMMANDS.capture, {
      // No title: not a palette verb. It answers with bytes.
      permission: 'sessions',
      schema: s.object({ session: s.string(), lines: s.optional(s.int()) }),
      /**
       * What this session's screen looks like right now, scrollback included.
       *
       * `SessionMirror.capture` has done this since remote landed — it is how a
       * viewer attaching mid-stream is shown what it missed — and it had no
       * verb. Archiving a task is the second caller, and it wants exactly the
       * same bytes for exactly the same reason: something will have to be shown
       * this screen later, having never seen it live.
       *
       * **Base64**, because a command's answer crosses an IPC port and a JSON
       * envelope. The bytes are a terminal's own encoding and are not text.
       */
      handler: (args) => {
        const mirror = host.mirror(toSessionId(args.session));
        if (mirror === undefined) throw new Error(`no session ${args.session}`);
        let captured = new Uint8Array();
        mirror.capture((snapshot) => void (captured = snapshot), args.lines ?? DEFAULT_CAPTURE_LINES);
        return { bytes: Buffer.from(captured).toString('base64') };
      },
    }),
```

with `export const DEFAULT_CAPTURE_LINES = 1000;` and `capture: 'sessions.capture'` in `SESSION_COMMANDS`. If `SessionHost` exposes no `mirror(id)`, add one returning `SessionMirror | undefined` — a getter, not a new copy.

- [ ] **Step 4: Run the tests**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- session`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add v2/packages/core/src/session
git commit -m "feat(sessions): sessions.capture — the mirror's screen, as bytes"
```

---

### Task 3: a session may be created with its screen already on it

**Files:**
- Modify: `v2/packages/core/src/session/host.ts`, `v2/packages/core/src/session/protocol.ts`, `v2/packages/core/src/session/mirror.ts`, `v2/packages/daemon/src/*` (the create path)
- Test: `v2/packages/core/src/session/mirror.test.ts`, `v2/packages/core/src/session/host.test.ts`

**Interfaces:**
- Produces: `SessionSpec.seed?: Uint8Array` (or base64 `string` where it crosses the wire), and `SessionMirror.seed(bytes)`.

- [ ] **Step 1: Write the failing tests**

```ts
it('replays a seeded screen to the first viewer, before any output', () => {
  // The restored pane's whole point: it must show what was there before the new
  // pty says anything.
  const mirror = new SessionMirror({});
  mirror.seed(new TextEncoder().encode('previous work\r\n'));

  const seen: string[] = [];
  mirror.capture((snapshot) => seen.push(new TextDecoder().decode(snapshot)));
  expect(seen.join('')).toContain('previous work');
});

it('a seeded mirror still records what the live pty says after it', () => {
  const mirror = new SessionMirror({});
  mirror.seed(new TextEncoder().encode('before\r\n'));
  mirror.write(new TextEncoder().encode('after\r\n'));

  const seen: string[] = [];
  mirror.capture((snapshot) => seen.push(new TextDecoder().decode(snapshot)));
  const text = seen.join('');
  expect(text).toContain('before');
  expect(text).toContain('after');
});
```

Plus, in `host.test.ts`, that `create({ cwd, seed })` produces a session whose mirror already carries the seed.

- [ ] **Step 2: Run them and watch them fail**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- session`
Expected: FAIL — `mirror.seed is not a function`.

- [ ] **Step 3: Implement**

On `SessionMirror`:

```ts
  /**
   * Put a previously captured screen into this mirror, before anything has run.
   *
   * The mirror is the ONE authority on what a viewer that arrives late should
   * see, which is exactly what a restored pane is — it arrives late to a screen
   * whose pty is long gone. Seeding here rather than writing the bytes into one
   * renderer's xterm is what makes the replay reach every viewer, including a
   * phone that attaches an hour after the restore.
   *
   * Feeds the same path a live write does, so nothing downstream has a second
   * case: what comes back out of `capture` is one screen, not a recording and a
   * session.
   */
  seed(bytes: Uint8Array): void {
    this.write(bytes);
  }
```

Thread `seed` through `SessionSpec` → the daemon's create message (base64 on the wire) → the mirror, applied **before** the pty is attached.

- [ ] **Step 4: Run the tests**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/core test && env -u NODE_OPTIONS pnpm --filter @shepherd/daemon test`
Expected: PASS.

- [ ] **Step 5: Prove it across the real daemon**

Run: `env -u NODE_OPTIONS pnpm smoke:daemon`
Expected: PASS — the daemon is a separate process and a field that does not cross its protocol is a field that silently does nothing.

- [ ] **Step 6: Commit**

```bash
git add v2/packages/core/src/session v2/packages/daemon
git commit -m "feat(sessions): a session may be created with its screen already on it"
```

---

### Task 4: the archive shape, purely

**Files:**
- Create: `v2/extensions/tasks/src/model/archive-tabs.ts`, `v2/extensions/tasks/src/model/archive-tabs.test.ts`
- Modify: `v2/extensions/tasks/src/store.ts`

**Interfaces:**
- Produces: `ArchivedPane`, `ArchivedTab`, `archiveTabsFrom(input): readonly ArchivedTab[]`, `historyPath(taskId, root, pane): string`, and `TaskRecord.tabs?: readonly ArchivedTab[]`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('archiveTabsFrom', () => {
  it('keeps one entry per root, in order, with its splits', () => {
    const tabs = archiveTabsFrom({
      group: 'task:t1',
      roots: [
        { root: 'task:t1', tree: LEAF_A, focusedPane: 'a', panes: [{ pane: 'a', cwd: '/wt', userTitle: null }] },
        { root: 'task:t1/tab-2', tree: LEAF_B, focusedPane: 'b', panes: [{ pane: 'b', cwd: '/wt/api', userTitle: 'logs' }] },
      ],
      sessions: [],
    });
    expect(tabs.map((tab) => tab.root)).toEqual(['task:t1', 'task:t1/tab-2']);
    expect(tabs[1]?.panes[0]?.cwd).toBe('/wt/api');
  });

  it('carries a pane’s session identity UNREAD', () => {
    // D11: `kindId` and `resumeTarget` come from the agent kind that captured
    // them and go back through the same seam. This function must not look
    // inside either — it only has to keep them attached to the right pane.
    const tabs = archiveTabsFrom({
      group: 'task:t1',
      roots: [{ root: 'task:t1', tree: LEAF_A, focusedPane: 'a', panes: [{ pane: 'a', cwd: '/wt', userTitle: null }] }],
      sessions: [{ pane: 'a', sessionId: 's-1', kindId: 'some-vendor', resumeTarget: 'opaque-blob' }],
    });
    expect(tabs[0]?.panes[0]).toMatchObject({
      sessionId: 's-1',
      kindId: 'some-vendor',
      resumeTarget: 'opaque-blob',
    });
  });

  it('leaves a pane with no session unmarked rather than inventing one', () => {
    const tabs = archiveTabsFrom({
      group: 'task:t1',
      roots: [{ root: 'task:t1', tree: LEAF_A, focusedPane: 'a', panes: [{ pane: 'a', cwd: null, userTitle: null }] }],
      sessions: [],
    });
    expect(tabs[0]?.panes[0]?.sessionId).toBeUndefined();
  });
});

describe('historyPath', () => {
  it('is one file per pane, under the task', () => {
    expect(historyPath('t1', 'task:t1/tab-2', 'p9')).toBe('t1/task_t1_tab-2/p9.term');
  });

  it('never lets a root id escape its directory', () => {
    // Root ids contain `:` and `/` by construction (`task:t1/tab-2`), and a path
    // built by concatenation would write outside the archive dir.
    expect(historyPath('t1', '../../etc', 'p1')).not.toContain('..');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- archive-tabs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Write `archive-tabs.ts` with the two types from the spec, a total `archiveTabsFrom` that joins roots to sessions by pane id, and a `historyPath` that **sanitises every segment** (`replace(/[^A-Za-z0-9._-]/g, '_')`) so a root id cannot escape the directory. Pure — no `fs`, no host, no commands.

Then in `store.ts` add `tabs` to `TaskRecord` and to its schema (`s.optional(s.array(...))`), with a comment that it is additive and absent on every record written before it.

- [ ] **Step 4: Run the tests**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- archive-tabs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/tasks/src/model/archive-tabs.ts v2/extensions/tasks/src/model/archive-tabs.test.ts v2/extensions/tasks/src/store.ts
git commit -m "feat(tasks): the archived shape of a task's tabs, purely"
```

---

### Task 5: archiving captures the group

**Files:**
- Modify: `v2/extensions/tasks/src/index.ts`
- Test: `v2/extensions/tasks/src/index.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 4.
- Produces: `tasks.archive` writing `record.tabs` and `<dataDir>/.archives/<taskId>/…/*.term`.

- [ ] **Step 1: Write the failing tests**

```ts
it('captures every tab BEFORE it closes the group', async () => {
  // `layout.closeGroup` is what kills the ptys, and a mirror dies with its
  // session. Capturing after it would archive N empty screens and nothing
  // would report a fault, because nothing would have failed.
  const h = harness({ tasks: [task({ sessions: [{ id: 's1', role: 'orchestrator', pane: 'p1', root: 'task:t1' }] })] });
  await h.run('tasks.archive', { task: 't1' });

  const captured = h.trace.indexOf('invoke sessions.capture');
  const closed = h.trace.indexOf('invoke layout.closeGroup');
  expect(captured).toBeGreaterThanOrEqual(0);
  expect(closed).toBeGreaterThan(captured);
});

it('records each tab with its panes, and writes a history file per pane', async () => {
  const h = harness({ /* two roots in the group, one session */ });
  await h.run('tasks.archive', { task: 't1' });

  const stored = (await h.run<{ tabs?: { root: string; panes: { history?: string }[] }[] }[]>('tasks.list'))[0];
  expect(stored?.tabs?.map((tab) => tab.root)).toEqual(['task:t1', 'task:t1/tab-2']);
  const history = stored?.tabs?.[0]?.panes[0]?.history;
  expect(history).toBeDefined();
  expect(existsSync(join(h.dataDir, '.archives', history!))).toBe(true);
});

it('archives a pane WITHOUT history when its screen cannot be read', async () => {
  // A session that has already exited has no mirror. A task you cannot archive
  // because one pane's history could not be captured is a worse outcome than a
  // tab that comes back blank.
  const warnings: string[] = [];
  const h = harness({
    onWarn: (line) => warnings.push(line),
    invoke: (id) => (id === 'sessions.capture' ? { ok: false, error: { code: 'handler-failed', message: 'no session', commandId: id } } : undefined),
  });
  await h.run('tasks.archive', { task: 't1' });

  const stored = (await h.run<{ lifecycle: string; tabs?: { panes: { history?: string }[] }[] }[]>('tasks.list'))[0];
  expect(stored?.lifecycle).toBe('archived');
  expect(stored?.tabs?.[0]?.panes[0]?.history).toBeUndefined();
  expect(warnings.some((line) => line.includes('history'))).toBe(true);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test`
Expected: FAIL — no `sessions.capture` invocation, no `tabs` on the record.

- [ ] **Step 3: Implement**

In `tasks.archive`, **before** `closeTaskRoot(task)`:

1. `layout.listRoots { group: taskRootId(task.id) }` for the group's roots (read defensively);
2. for each root, `layout.tree`-equivalent read — if there is no command that answers a root's tree, add `tree` and `panes` to `layout.listRoots`' answer rather than inventing a second read;
3. per pane with a session, `sessions.capture { session, lines: 1000 }`, `mkdirSync` the archive dir and write the decoded bytes to `historyPath(...)`;
4. build `tabs` with `archiveTabsFrom` and `store.put({ ...task, tabs })`.

Wrap each capture in its own try/catch: one unreadable screen must not fail the archive.

- [ ] **Step 4: Run the tests**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/tasks/src
git commit -m "feat(tasks): archiving captures every tab, its splits and its screen"
```

---

### Task 6: restoring rebuilds the screen — and stages the resume line unsubmitted

**Files:**
- Modify: `v2/extensions/tasks/src/index.ts`
- Test: `v2/extensions/tasks/src/index.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4, 5.
- Produces: `tasks.restore` rebuilding the group.

**The claim this task is about:** restoring rebuilds the **screen**, not the agent. Nothing is relaunched; the resume line is typed and left at the prompt.

- [ ] **Step 1: Write the failing tests**

```ts
it('reopens every archived tab, in order, in the task’s group', async () => {
  const h = harness({ tasks: [archivedWithTabs()] });
  await h.run('tasks.restore', { task: 't1' });

  const opened = h.invoked.filter((call) => call.id === 'layout.openRoot' || call.id === 'layout.newTab');
  expect(opened).toHaveLength(2);
  expect(h.invoked.find((call) => call.id === 'layout.openRoot')?.args).toMatchObject({
    root: 'task:t1',
    group: 'task:t1',
  });
});

it('seeds each pane with the screen it had', async () => {
  const h = harness({ tasks: [archivedWithTabs()] });
  await h.run('tasks.restore', { task: 't1' });

  const opened = h.invoked.find((call) => call.id === 'layout.openRoot');
  expect((opened?.args as { seed?: string }).seed).toBeDefined();
});

it('stages the resume line WITHOUT a newline, so nothing runs', async () => {
  /*
   * The whole correction. `setInitialInput` documents a newline as an Enter
   * press, so a staged line that ends in one would relaunch every agent of a
   * task somebody restored in order to glance at it.
   */
  const h = harness({ tasks: [archivedWithTabs()] });
  await h.run('tasks.restore', { task: 't1' });

  const staged = h.invoked.find((call) => call.id === 'layout.openRoot')?.args as { initialCommand?: string };
  expect(staged.initialCommand).toBeDefined();
  expect(staged.initialCommand).not.toContain('\n');
});

it('stages nothing in a pane that had no agent', async () => {
  const h = harness({ tasks: [archivedWithPlainShellTab()] });
  await h.run('tasks.restore', { task: 't1' });

  const second = h.invoked.find((call) => call.id === 'layout.newTab')?.args as { initialCommand?: string };
  expect(second.initialCommand).toBeUndefined();
});

it('restores a record written before tabs existed exactly as it always did', async () => {
  // `tabs` is additive and absent on every older record; that path must not
  // have changed at all.
  const h = harness({ tasks: [archivedWithoutTabs()] });
  await h.run('tasks.restore', { task: 't1' });
  expect(h.invoked.some((call) => call.id === 'layout.newTab')).toBe(false);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test`
Expected: FAIL — restore opens one root and stages nothing.

- [ ] **Step 3: Implement**

In `tasks.restore`, after the worktrees are back and only when `task.tabs` is present: for each tab in order, open its root (first) or `layout.newTab` (rest) with `group`, `cwd`, the base64 `seed` read back from its history file, and `initialCommand` = the resume line **with no trailing newline** when that pane has a `resumeTarget`. Rebuild splits from `tab.tree` through `layout.split`, then `layout.rename` each pane that had a `userTitle`.

Reuse whatever builds the resume line today (`resumeSession`'s own construction) rather than writing a second one — and make sure the shared builder does not append a newline for this caller.

- [ ] **Step 4: Run the tests**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/tasks/src
git commit -m "feat(tasks): restore rebuilds the tabs and STAGES each resume line"
```

---

### Task 7: the checkmark, and a week

**Files:**
- Modify: `v2/extensions/tasks/src/index.ts`, `v2/extensions/tasks/src/model/expiry.ts`
- Test: `v2/extensions/tasks/src/index.test.ts`, `v2/extensions/tasks/src/model/expiry.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('offers Mark done on a live task, and nothing on an archived one', async () => {
  const h = harness({ tasks: [task(), task({ id: 't2', lifecycle: 'archived' })] });
  expect((await rowOf(h, 't1'))?.primaryAction).toMatchObject({ id: 'tasks.archive', label: 'Mark done' });
  expect((await rowOf(h, 't2'))?.primaryAction).toBeUndefined();
});
```

```ts
it('expires an archived task after a week', () => {
  expect(ARCHIVE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  expect(expired([{ id: 't1', archivedAt: 0 }], 7 * 24 * 60 * 60 * 1000)).toEqual(['t1']);
  expect(expired([{ id: 't1', archivedAt: 0 }], 6 * 24 * 60 * 60 * 1000)).toEqual([]);
});
```

(Match `expiry.test.ts`'s existing helper names.)

- [ ] **Step 2: Run them and watch them fail**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test`
Expected: FAIL — no `primaryAction`; TTL is 30 days.

- [ ] **Step 3: Implement**

On the task row, beside `command` / `presents` / `actions`:

```ts
              // The one verb worth a button: finishing with a task is the
              // gesture you make most, and it was two clicks into a context
              // menu. An archived task offers none — the verb that is available
              // is the one that changes its state, which is the rule `actions`
              // beside it already follows.
              ...(task.lifecycle === 'archived'
                ? {}
                : {
                    primaryAction: {
                      id: TASK_COMMANDS.archive,
                      label: 'Mark done',
                      icon: 'check',
                      args: { task: task.id },
                    },
                  }),
```

In `expiry.ts`, change the constant to `7 * 24 * 60 * 60 * 1000` and extend its comment:

```ts
/**
 * **7 literal days.** Was 30. An archive now carries a task's tabs and their
 * screens, which makes it a real shelf rather than a tombstone — and a shelf
 * that fills up is one nobody trusts. Literal days for the reason it always
 * was: a user asking "does this still exist" is counting days.
 */
```

And in the sweep that deletes an expired task, remove its archive directory:

```ts
      // The history files outlive nothing: the record that names them is going,
      // and without this they would sit under `.archives` with nothing left in
      // the app that could ever mention them again.
      rmSync(`${ctx.dataDir}/.archives/${id}`, { recursive: true, force: true });
```

- [ ] **Step 4: Run the tests**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/tasks/src
git commit -m "feat(tasks): Mark done on hover; an archive lives a week"
```

---

### Task 8: the gate

**Files:**
- Modify: `v2/packages/app/src/main/smoke-m3.ts`

- [ ] **Step 1: Add the scenario**

After the existing tabs scenario, and using the file's own `step` / `check` / `invoke` / `until` helpers:

```ts
  step('archiving a two-tab task keeps its tabs and their screens');
  await invoke('tasks.archive', { task: composed.id });
  const archived = ((await invoke('tasks.list')) as { id: string; tabs?: { root: string; panes: { history?: string }[] }[] }[])
    .find((t) => t.id === composed.id);
  check((archived?.tabs ?? []).length === 2, `both tabs were archived: ${JSON.stringify(archived?.tabs?.map((t) => t.root))}`);
  check(
    (archived?.tabs ?? []).some((tab) => tab.panes.some((pane) => pane.history !== undefined)),
    'at least one pane kept its screen',
  );

  step('restoring brings the tabs back and starts NOTHING');
  const before = ((await invoke('sessions.list')) as { id: string }[]).length;
  await invoke('tasks.restore', { task: composed.id });
  const roots = (await invoke('layout.listRoots', { group: `task:${composed.id}` })) as { root: string }[];
  check(roots.length === 2, `both tabs came back: ${JSON.stringify(roots.map((r) => r.root))}`);
  // One pty per restored pane and not one more: the resume line is STAGED, so
  // no agent process may have been launched by the restore itself.
  const after = ((await invoke('sessions.list')) as { id: string }[]).length;
  check(after === before + roots.length, `restore opened panes without launching agents (${before} -> ${after})`);
```

- [ ] **Step 2: Run the gate**

Run: `env -u NODE_OPTIONS pnpm smoke:m3`
Expected: PASS.

- [ ] **Step 3: Run everything**

Run: `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test && env -u NODE_OPTIONS pnpm smoke:m3`
Expected: all PASS.

- [ ] **Step 4: Try it in the real app**

Run: `env -u NODE_OPTIONS pnpm ship --dev`. In Shep Night: hover a task and click the checkmark; confirm it sinks to DONE, then click it to restore and confirm its tabs come back with their scrollback and the resume line sitting **unrun** at the prompt.

- [ ] **Step 5: Commit**

```bash
git add v2/packages/app/src/main/smoke-m3.ts
git commit -m "test(smoke): an archived task restores its tabs without starting agents"
```

---

## Notes for the implementer

- **Capture before close, always.** `layout.closeGroup` kills the ptys and a mirror dies with its session; capturing afterwards archives empty screens and reports no fault, because nothing failed.
- **`kindId` and `resumeTarget` are opaque.** Store them, hand them back, never branch on them (D11).
- **The staged line must not end in a newline.** That single character is the difference between "your work is back on screen" and "restoring a task spawned five agents".
- **A path built from a root id needs sanitising.** Root ids contain `:` and `/` by construction.
