# Notification revamp — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A banner names its task, says something the state word cannot, teleports you into that task when clicked, and carries two buttons.

**Architecture:** The kernel declares one command id — `alerts.describe` — that any extension may register and `tasks` implements; `agent-relay` consults it only after routing has already decided a banner fires, and falls back to today's wording when nothing answers. Clicking pushes `EMIT.navigate` to the renderer, which reuses the `open(entry, 'jump')` teleport ⌘K already has.

**Tech Stack:** TypeScript, Electron, vitest, pnpm workspaces. All paths below are relative to `v2/`.

**Spec:** `docs/superpowers/specs/2026-08-30-notifications-design.md`

## Global Constraints

- Every new decision is a pure function with a unit test; Electron types stay behind the injected seams (`NotificationHandle`, `AlertSink`) that already exist.
- No extension name may appear in `packages/app/src/main` or `packages/core`. `alerts.describe` is a kernel id; `tasks` is never named there.
- A failure is logged, never swallowed — `system-alerts.ts`'s standing rule.
- Before each commit: `pnpm -r test`, `pnpm typecheck`, `pnpm lint` (from `v2/`).
- Commit subjects are imperative and unprefixed, matching this repo's log.

---

### Task 1: `editor.stat` — how much changed

**Files:**
- Modify: `extensions/editor/src/status.ts` (add `readNumstat`, `DiffStat`)
- Modify: `extensions/editor/src/git.ts` (add `statOf`)
- Modify: `extensions/editor/src/manifest.ts` (add `stat: 'editor.stat'`)
- Modify: `extensions/editor/src/index.ts` (register the command beside `editor.changes`)
- Test: `extensions/editor/src/status.test.ts`, `extensions/editor/src/git.test.ts`

**Interfaces:**
- Produces: `interface DiffStat { readonly files: number; readonly added: number; readonly removed: number }`;
  `readNumstat(stdout: string): DiffStat`; `statOf(git: GitRunner, root: string, base?: string): Promise<DiffStat>`;
  command `editor.stat({ root, base? }) -> DiffStat`.

- [ ] **Step 1: Write the failing parser test** in `status.test.ts`

```ts
describe('readNumstat', () => {
  it('sums a numstat', () => {
    expect(readNumstat('12\t3\tsrc/a.ts\n0\t7\tsrc/b.ts\n')).toEqual({ files: 2, added: 12, removed: 10 });
  });
  it('counts a binary file without counting its lines', () => {
    expect(readNumstat('-\t-\tlogo.png\n')).toEqual({ files: 1, added: 0, removed: 0 });
  });
  it('answers zero for nothing', () => {
    expect(readNumstat('')).toEqual({ files: 0, added: 0, removed: 0 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail.** `pnpm --filter @shepherd/ext-editor test` — expected: `readNumstat` is not exported.

- [ ] **Step 3: Implement `readNumstat` in `status.ts`**

```ts
export interface DiffStat {
  readonly files: number;
  readonly added: number;
  readonly removed: number;
}

/**
 * `git diff --numstat`, summed.
 *
 * A binary file reports `-` for both counts and is still a changed FILE, so it
 * counts once and contributes no lines. The alternative is a stat that says
 * `0 files` for a turn that replaced an icon.
 */
export function readNumstat(stdout: string): DiffStat {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    files += 1;
    added += Number.parseInt(parts[0] ?? '', 10) || 0;
    removed += Number.parseInt(parts[1] ?? '', 10) || 0;
  }
  return { files, added, removed };
}
```

- [ ] **Step 4: Run it and watch it pass.**

- [ ] **Step 5: Write the failing `statOf` test** in `git.test.ts`, in that file's existing fake-runner style

```ts
describe('statOf', () => {
  it('adds untracked files to the numstat', async () => {
    const git = runner({
      'diff --numstat': '3\t1\tsrc/a.ts\n',
      'ls-files --others --exclude-standard': 'new.ts\nalso-new.ts\n',
    });
    expect(await statOf(git, '/root')).toEqual({ files: 3, added: 3, removed: 1 });
  });

  it('answers zero outside a repository', async () => {
    const git = { gitRead: async () => ({ ok: false as const, code: 128, stdout: '', stderr: 'not a git repository' }) };
    expect(await statOf(git, '/root')).toEqual({ files: 0, added: 0, removed: 0 });
  });
});
```

- [ ] **Step 6: Run it and watch it fail.**

- [ ] **Step 7: Implement `statOf` in `git.ts`**

```ts
/**
 * How much this checkout has changed — the numbers a row and a banner draw.
 *
 * TWO calls, for `listStatus`'s reason: `git diff` cannot see a file git has
 * never heard of, and an agent's first act is often to write one. An untracked
 * file counts as a changed FILE and contributes no lines, because counting its
 * lines would mean reading every one of them.
 *
 * `base` widens the question from "what is uncommitted" to "what has this
 * checkout changed since it forked", exactly as it does for `listStatus` — an
 * agent commits, and the answer must not empty itself when it does.
 *
 * A failure is zero rather than a throw: this decorates a row and a banner, and
 * neither is worth failing for.
 */
export async function statOf(git: GitRunner, root: string, base?: string): Promise<DiffStat> {
  const opts = { cwd: root, timeoutMs: LIST_MS };
  const [changed, untracked] = await Promise.all([
    git.gitRead(base === undefined ? ['diff', '--numstat'] : ['diff', '--numstat', base], opts),
    git.gitRead(['ls-files', '--others', '--exclude-standard'], opts),
  ]);
  const stat = changed.ok ? readNumstat(changed.stdout) : { files: 0, added: 0, removed: 0 };
  const extra = untracked.ok
    ? untracked.stdout.split('\n').filter((line) => line.trim() !== '').length
    : 0;
  return { ...stat, files: stat.files + extra };
}
```

- [ ] **Step 8: Run it and watch it pass.**

- [ ] **Step 9: Register the command.** `stat: 'editor.stat'` in `EDITOR_COMMANDS` with a one-line doc comment, and in `index.ts` beside `editor.changes`:

```ts
  ctx.subscriptions.push(
    commands.register(EDITOR_COMMANDS.stat, {
      schema: s.object({ root: s.string(), base: s.optional(s.string()) }),
      handler: async (args) => await statOf(process, args.root, args.base),
    }),
  );
```

- [ ] **Step 10: Verify and commit.**

```bash
pnpm -r test && pnpm typecheck && pnpm lint
git add extensions/editor/src
git commit -m "editor.stat: how much a checkout changed"
```

---

### Task 2: The alert spec, and a notification that can carry it

**Files:**
- Modify: `packages/sdk/src/` — add `alert.ts` and export it from `packages/sdk/src/index.ts`
- Modify: `packages/app/src/main/system-alerts.ts`
- Test: `packages/app/src/main/system-alerts.test.ts`

**Interfaces:**
- Produces: `AlertGoto { task: string; face?: string }`; `AlertAction`; `AlertSpec`;
  `AlertSink.notify(alert: AlertSpec & { readonly sessionId: string }): void`;
  `SystemAlertOptions.dispatch?: (action: AlertAction | { readonly goto: AlertGoto }) => void`;
  `SystemAlertOptions.create?: (alert: { title: string; subtitle?: string; body: string; actions?: readonly { type: 'button'; text: string }[] }) => NotificationHandle`;
  `NotificationHandle.on(event: 'failed' | 'show' | 'click' | 'action', handler: (event: unknown, arg?: Error | number) => void): void`.

- [ ] **Step 1: Add the types** in `packages/sdk/src/alert.ts` (types only, no test)

```ts
export interface AlertGoto {
  readonly task: string;
  /** A face slot (`agents`, `diff`, …). Absent means "the shell decides". */
  readonly face?: string;
}

/**
 * A button on a banner: a VERB the shell runs, or a PLACE it goes.
 *
 * `{command, args}` is the shape a row's answers and its `later` options already
 * cross the port with, and for the same reason — the shell runs what it was
 * handed and never learns that any particular extension exists.
 */
export type AlertAction =
  | { readonly label: string; readonly command: string; readonly args?: unknown }
  | { readonly label: string; readonly goto: AlertGoto };

export interface AlertSpec {
  readonly title: string;
  readonly subtitle?: string;
  readonly body: string;
  /** At most two. macOS folds the rest into a dropdown nobody opens. */
  readonly actions?: readonly AlertAction[];
  readonly click?: AlertGoto;
}
```

- [ ] **Step 2: Write the failing tests** in `system-alerts.test.ts`, extending `fakeNotification` to record its options and to fire `click`/`action`

```ts
it('carries the subtitle and the action labels to the OS', () => {
  const { log } = recorder();
  let seen: Parameters<NonNullable<Parameters<typeof createSystemAlerts>[0]['create']>>[0] | undefined;
  const alerts = createSystemAlerts({
    logger: log,
    isSupported: () => true,
    dispatch: () => {},
    create: (options) => { seen = options; return fakeNotification().handle; },
  });

  alerts.notify({
    sessionId: 's1',
    title: 'Notification revamp',
    subtitle: 'Turn finished',
    body: '3 files · +42 −7',
    actions: [{ label: 'Diff', goto: { task: 't1', face: 'diff' } }],
  });

  expect(seen?.title).toBe('Notification revamp');
  expect(seen?.subtitle).toBe('Turn finished');
  expect(seen?.actions).toEqual([{ type: 'button', text: 'Diff' }]);
});

it('dispatches the click and the buttons, and nothing for an index that is not there', () => {
  const { log } = recorder();
  const fake = fakeNotification();
  const dispatched: unknown[] = [];
  const alerts = createSystemAlerts({
    logger: log,
    isSupported: () => true,
    create: () => fake.handle,
    dispatch: (action) => dispatched.push(action),
  });

  alerts.notify({
    sessionId: 's1',
    title: 'Notification revamp',
    body: 'waiting',
    click: { task: 't1' },
    actions: [{ label: 'Later today', command: 'tasks.snooze', args: { task: 't1', until: 'today' } }],
  });

  fake.fire('click');
  fake.fire('action', 0);
  fake.fire('action', 9);

  expect(dispatched).toEqual([
    { goto: { task: 't1' } },
    { label: 'Later today', command: 'tasks.snooze', args: { task: 't1', until: 'today' } },
  ]);
});

it('draws no buttons at all when nothing can dispatch them', () => {
  const { log } = recorder();
  let seen: { actions?: readonly unknown[] } | undefined;
  const alerts = createSystemAlerts({
    logger: log,
    isSupported: () => true,
    create: (options) => { seen = options; return fakeNotification().handle; },
  });

  alerts.notify({ sessionId: 's1', title: 't', body: 'b', actions: [{ label: 'Diff', goto: { task: 't1' } }] });

  expect(seen?.actions).toBeUndefined();
});
```

- [ ] **Step 3: Run and watch all three fail.** `pnpm --filter @shepherd/app test src/main/system-alerts.test.ts`

- [ ] **Step 4: Implement.** `notify` takes an `AlertSpec & {sessionId}`; `create` receives `subtitle` and `actions` mapped to `{type:'button', text: label}`; `on('click')` dispatches `{goto: spec.click}` when there is one; `on('action')` dispatches `spec.actions[index]` guarded by an index check. A missing `dispatch` means no `actions` reach the OS and no handlers are wired — a button that cannot fire must not be drawn. The existing `failed`/`show`/`isSupported` paths and their wording are untouched.

- [ ] **Step 5: Run and watch them pass.**

- [ ] **Step 6: Verify and commit.**

```bash
pnpm -r test && pnpm typecheck && pnpm lint
git add packages/sdk/src packages/app/src/main/system-alerts.ts packages/app/src/main/system-alerts.test.ts
git commit -m "A banner carries a subtitle, buttons and a destination"
```

---

### Task 3: The relay asks who this session is

**Files:**
- Create: `packages/app/src/main/alert-spec.ts`
- Create: `packages/app/src/main/alert-spec.test.ts`
- Modify: `packages/app/src/main/agent-relay.ts` (delete its local `title()`, add `describe`)
- Modify: `packages/app/src/main/agent-ipc.ts` (supply `describe`)

**Interfaces:**
- Consumes: `AlertSpec` (Task 2).
- Produces: `ALERTS_DESCRIBE = 'alerts.describe'`;
  `resolveAlert(described: unknown, fallback: { readonly state: string; readonly reason?: string }): AlertSpec`;
  `AgentRelayOptions.describe?: (input: { sessionId: string; paneId: string; state: string; reason?: string; turnFinished: boolean }) => Promise<unknown>`.

- [ ] **Step 1: Write the failing tests** in `alert-spec.test.ts`

```ts
describe('resolveAlert', () => {
  it('reads a described spec', () => {
    expect(resolveAlert({ title: 'Revamp', subtitle: 'Turn finished', body: '3 files' }, { state: 'needsCheck' }))
      .toEqual({ title: 'Revamp', subtitle: 'Turn finished', body: '3 files' });
  });

  it('answers the old wording when nothing described it', () => {
    expect(resolveAlert(null, { state: 'blocked', reason: 'approve Bash' }))
      .toEqual({ title: 'Waiting on you', body: 'approve Bash' });
  });

  it('answers the old wording when the spec has no title', () => {
    expect(resolveAlert({ body: 'x' }, { state: 'error' })).toEqual({ title: 'Turn failed', body: 'error' });
  });

  it('falls back to the state word when there is no reason to give', () => {
    expect(resolveAlert(null, { state: 'needsCheck' })).toEqual({ title: 'Turn finished', body: 'needsCheck' });
  });

  it('drops an action it cannot read rather than the whole spec', () => {
    const spec = resolveAlert(
      { title: 'Revamp', body: 'x', actions: [{ label: 'Diff', goto: { task: 't1' } }, { label: 'broken' }] },
      { state: 'needsCheck' },
    );
    expect(spec.actions).toEqual([{ label: 'Diff', goto: { task: 't1' } }]);
  });

  it('keeps at most two actions', () => {
    const spec = resolveAlert(
      {
        title: 'Revamp',
        body: 'x',
        actions: [
          { label: 'One', goto: { task: 't1' } },
          { label: 'Two', goto: { task: 't1' } },
          { label: 'Three', goto: { task: 't1' } },
        ],
      },
      { state: 'needsCheck' },
    );
    expect(spec.actions).toHaveLength(2);
  });

  it('drops a click that names no task', () => {
    expect(resolveAlert({ title: 'Revamp', body: 'x', click: {} }, { state: 'needsCheck' }).click).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement `alert-spec.ts`** — a defensive reader in the shape `row-facts.ts` established (every field optional, a wrong shape dropped rather than thrown on), carrying `agent-relay.ts`'s `title(state)` across unchanged, and exporting `ALERTS_DESCRIBE`. Its header says why the reader is defensive: the spec crossed a port from an extension this code has never seen.

- [ ] **Step 4: Run and watch them pass.**

- [ ] **Step 5: Wire the relay.** Replace the `options.alerts.notify({ title: title(change.to), … })` tail of the subscription with:

```ts
    /*
     * ASKED, and only now.
     *
     * Alerts are rare and suppressed alerts are common, so the git read and the
     * transcript tail behind this are paid once per banner and never for a change
     * nobody will see. Nothing registered, a rejection, or a session that belongs
     * to no task all mean the same thing: the wording this file used before there
     * was anything to ask.
     */
    const described =
      options.describe === undefined
        ? null
        : await options
            .describe({
              sessionId,
              paneId: pane as string,
              state: change.to,
              ...(reason === undefined ? {} : { reason }),
              turnFinished: change.turnFinished === true,
            })
            .catch(() => null);
    options.alerts.notify({ ...resolveAlert(described, { state: change.to, reason }), sessionId });
```

  with `reason` read from `change.alertReason` as it is today. The bus handler becomes `async`; note in a comment that nothing awaits it, which is fine because everything before the `decide()` call is synchronous.

- [ ] **Step 6: Supply `describe` from `agent-ipc.ts`** — invoke `ALERTS_DESCRIBE` through the `CommandRegistry` as `KERNEL`, answering `null` when the result is not `ok` (an unregistered command included). `AgentIpcOptions` grows the registry it needs.

- [ ] **Step 7: Verify and commit.**

```bash
pnpm -r test && pnpm typecheck && pnpm lint
git add packages/app/src/main
git commit -m "The relay asks what an alert should say"
```

---

### Task 4: `tasks` answers, in its own words

**Files:**
- Create: `extensions/tasks/src/alert.ts`
- Create: `extensions/tasks/src/alert.test.ts`
- Modify: `extensions/tasks/src/index.ts` (register `alerts.describe`)
- Modify: `extensions/tasks/src/manifest.ts` (declare it)

**Interfaces:**
- Consumes: `AlertSpec`/`AlertAction` (Task 2), `editor.stat` (Task 1), `agents.lastSaid`.
- Produces:

```ts
export interface AlertInput {
  readonly task: { readonly id: string; readonly title: string };
  readonly state: string;
  readonly reason?: string;
  readonly lastSaid?: string;
  readonly stat?: { readonly files: number; readonly added: number; readonly removed: number };
}
export function alertFor(input: AlertInput): AlertSpec;
```

- [ ] **Step 1: Write the failing tests** in `alert.test.ts`

```ts
const task = { id: 't1', title: 'Notification revamp' };

it('names the task and says why it is blocked', () => {
  expect(alertFor({ task, state: 'blocked', reason: 'approve Bash' })).toEqual({
    title: 'Notification revamp',
    subtitle: 'Waiting on you',
    body: 'approve Bash',
    click: { task: 't1' },
    actions: [
      { label: 'Open', goto: { task: 't1', face: 'agents' } },
      { label: 'Later today', command: 'tasks.snooze', args: { task: 't1', until: 'today' } },
    ],
  });
});

it('says what a finished turn changed, and offers both faces', () => {
  const spec = alertFor({ task, state: 'needsCheck', stat: { files: 3, added: 42, removed: 7 }, lastSaid: 'Done.' });
  expect(spec.subtitle).toBe('Turn finished');
  expect(spec.body).toBe('3 files · +42 −7');
  expect(spec.click).toEqual({ task: 't1', face: 'diff' });
  expect(spec.actions).toEqual([
    { label: 'Diff', goto: { task: 't1', face: 'diff' } },
    { label: 'Agents', goto: { task: 't1', face: 'agents' } },
  ]);
});

it('says one file, singular', () => {
  expect(alertFor({ task, state: 'needsCheck', stat: { files: 1, added: 2, removed: 0 } }).body).toBe('1 file · +2 −0');
});

it('falls back to the last thing the agent said when nothing changed', () => {
  const spec = alertFor({ task, state: 'needsCheck', stat: { files: 0, added: 0, removed: 0 }, lastSaid: 'Nothing to do.' });
  expect(spec.body).toBe('Nothing to do.');
  expect(spec.click).toEqual({ task: 't1', face: 'agents' });
});

it('never repeats the task name as its own summary', () => {
  expect(alertFor({ task, state: 'needsCheck', lastSaid: 'notification revamp' }).body).toBe('finished a turn');
});

it('trims a long last line to something a banner can hold', () => {
  const said = 'x'.repeat(300);
  const body = alertFor({ task, state: 'needsCheck', lastSaid: said }).body;
  expect(body.length).toBeLessThanOrEqual(160);
  expect(body.endsWith('…')).toBe(true);
});

it('carries the error, and one way back in', () => {
  const spec = alertFor({ task, state: 'error', reason: 'API error' });
  expect(spec.subtitle).toBe('Turn failed');
  expect(spec.body).toBe('API error');
  expect(spec.actions).toEqual([{ label: 'Open', goto: { task: 't1', face: 'agents' } }]);
});
```

- [ ] **Step 2: Run and watch them fail.** `pnpm --filter @shepherd/ext-tasks test src/alert.test.ts`

- [ ] **Step 3: Implement `alert.ts`** — pure, no IO: the state table, the `files · +n −m` formatting (singular at one), the "never the title again" rule `summaryFor` already applies in `index.ts`, and the 160-character trim.

- [ ] **Step 4: Run and watch them pass.**

- [ ] **Step 5: Register `alerts.describe` in `index.ts`**, near `tasks.reveal`:

```ts
  ctx.subscriptions.push(
    commands.register(ALERTS_DESCRIBE, {
      schema: s.object({
        sessionId: s.string(),
        paneId: s.string(),
        state: s.string(),
        reason: s.optional(s.string()),
        turnFinished: s.boolean(),
      }),
      handler: async (args) => {
        const task =
          store.list().find((candidate) => panesOf(candidate).includes(args.paneId)) ??
          store.list().find((candidate) => candidate.sessions.some((session) => session.id === args.sessionId));
        if (task === undefined) return null;
        const [stat, lastSaid] = await Promise.all([statFor(task, args.state), saidFor(task, args.sessionId)]);
        return alertFor({
          task: { id: task.id, title: task.title },
          state: args.state,
          ...(args.reason === undefined ? {} : { reason: args.reason }),
          ...(stat === undefined ? {} : { stat }),
          ...(lastSaid === undefined ? {} : { lastSaid }),
        });
      },
    }),
  );
```

  with two local helpers beside it: `statFor` invokes `editor.stat` once per repo worktree (`${rootOf(task)}/${repo.name}`) and sums them, only when the state is a finished turn, answering `undefined` on any failure; `saidFor` asks `agents.lastSaid` the way the rail already does, answering `undefined` on any failure. Both degrade rather than throw — a banner is not worth failing for, and the fallback wording is one layer up.

- [ ] **Step 6: Declare the command in `manifest.ts`** beside the others, with a comment recording that the id is the kernel's and this extension is one possible answerer.

- [ ] **Step 7: Verify and commit.**

```bash
pnpm -r test && pnpm typecheck && pnpm lint
git add extensions/tasks/src
git commit -m "A task says what its banner should read"
```

---

### Task 5: Clicking reaches the page

**Files:**
- Create: `packages/app/src/main/alert-dispatch.ts`
- Create: `packages/app/src/main/alert-dispatch.test.ts`
- Modify: `packages/app/src/shared/channels.ts` (`EMIT.navigate`)
- Modify: `packages/app/src/shared/bridge.ts` (the `nav` surface)
- Modify: `packages/app/src/preload/api.ts`
- Modify: `packages/app/src/main/agent-ipc.ts` (build the dispatcher, pass it to the sink)

**Interfaces:**
- Consumes: `AlertAction`, `AlertGoto` (Task 2).
- Produces: `EMIT.navigate = 'nav:goto'` carrying `NavigateMessage { readonly task: string; readonly face?: string }`;
  `alertDispatcher(options: { registry: CommandRegistry; raise: () => void; navigate: (message: NavigateMessage) => void; onFailure: (command: string, message: string) => void }): (action: AlertAction | { goto: AlertGoto }) => void`.

- [ ] **Step 1: Write the failing tests** in `alert-dispatch.test.ts`

```ts
it('raises the window and pushes the destination for a goto', () => {
  const seen: unknown[] = [];
  const dispatch = alertDispatcher({
    registry: { invoke: async () => ({ ok: true, value: null }) } as never,
    raise: () => seen.push('raised'),
    navigate: (message) => seen.push(message),
    onFailure: () => seen.push('failed'),
  });

  dispatch({ goto: { task: 't1', face: 'diff' } });

  expect(seen).toEqual(['raised', { task: 't1', face: 'diff' }]);
});

it('runs a verb as the user, and does not move the window for it', async () => {
  const seen: unknown[] = [];
  const dispatch = alertDispatcher({
    registry: {
      invoke: async (id: string, args: unknown, who: unknown) => { seen.push([id, args, who]); return { ok: true, value: null }; },
    } as never,
    raise: () => seen.push('raised'),
    navigate: () => seen.push('navigated'),
    onFailure: () => seen.push('failed'),
  });

  dispatch({ label: 'Later today', command: 'tasks.snooze', args: { task: 't1', until: 'today' } });
  await Promise.resolve();

  expect(seen).toEqual([['tasks.snooze', { task: 't1', until: 'today' }, USER]]);
});

it('reports a verb that failed rather than dropping it', async () => {
  const failures: string[] = [];
  const dispatch = alertDispatcher({
    registry: { invoke: async () => ({ ok: false, error: { code: 'no-such-command', message: 'no tasks.snooze' } }) } as never,
    raise: () => {},
    navigate: () => {},
    onFailure: (command, message) => failures.push(`${command}: ${message}`),
  });

  dispatch({ label: 'Later today', command: 'tasks.snooze' });
  await Promise.resolve();

  expect(failures).toEqual(['tasks.snooze: no tasks.snooze']);
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement `alert-dispatch.ts`** in `menuDispatcher`'s shape, attributing to `USER` — a button press is a user gesture — with a header saying why a `goto` raises and a verb does not: `Later today` from a banner is a way of saying "not now", and a window that jumped to the task you just deferred is the opposite of what was asked for.

- [ ] **Step 4: Run and watch them pass.**

- [ ] **Step 5: Wire it.** `EMIT.navigate` in `channels.ts` with a comment on why main sends a task id and not a face decision (the face is the page's own vocabulary — `nav.ts` — and main forwards an opaque string); `nav: { onGoto }` in `bridge.ts`'s surface table and `preload/api.ts`, mirroring `agents.onChanged`; in `agent-ipc.ts`, `raise` shows and focuses the first live window and `navigate` sends to every live `webContents`, the way `publish` does.

- [ ] **Step 6: Verify and commit.**

```bash
pnpm -r test && pnpm typecheck && pnpm lint
git add packages/app/src
git commit -m "A banner's click reaches the page"
```

---

### Task 6: The page teleports

**Files:**
- Modify: `packages/app/src/renderer/takeover.tsx`
- Test: `packages/app/src/renderer/takeover.test.tsx`

**Interfaces:**
- Consumes: `NavigateMessage` (Task 5), delivered through a `onGoto` prop on `useTakeover` so the test can fire it without a preload.

- [ ] **Step 1: Write the failing tests** in `takeover.test.tsx`, in that file's existing render harness

```ts
it('teleports to the task a banner named, clearing the stack', () => {
  const { view, goto } = render({ rows: working });
  // walk in so there is a stack to clear
  view().home.onOpen(entryOf('a'));
  view().home.onOpen(entryOf('b'));

  goto({ task: 'a' });

  expect(view().nav.at).toMatchObject({ kind: 'task', id: 'a' });
  expect(view().nav.stack).toEqual([]);
});

it('opens the face the banner asked for', () => {
  const { view, goto } = render({ rows: working, faces: ALL });
  goto({ task: 'a', face: 'diff' });
  expect(view().nav.at).toMatchObject({ kind: 'task', id: 'a', face: 'diff' });
});

it('still moves the window for a task it has no row for yet', () => {
  const { view, goto, invoked } = render({ rows: working });
  goto({ task: 'ghost' });
  expect(view().nav.at).toEqual({ kind: 'home' });
  expect(invoked()).toEqual([['tasks.reveal', { task: 'ghost' }]]);
});
```

- [ ] **Step 2: Run and watch them fail.** `pnpm --filter @shepherd/app test src/renderer/takeover.test.tsx`

- [ ] **Step 3: Implement** — a `useEffect` in `useTakeover` subscribing to `onGoto`: resolve the id against `byId`; with no face, `open(entry, 'jump')`; with one, run the entry's verb and `jump` to that face through `nearestFace`; an id with no row invokes the reveal verb with `{task}` and leaves `nav` untouched. A comment records why this is `jump` and not `go`: a banner is not a step down from where you were, and `esc` after it must go Home — the same argument `jump` carries for ⌘K.

- [ ] **Step 4: Run and watch them pass.**

- [ ] **Step 5: Verify and commit.**

```bash
pnpm -r test && pnpm typecheck && pnpm lint
git add packages/app/src/renderer
git commit -m "A banner's task is a teleport, not a push"
```

---

### Task 7: See it work

- [ ] **Step 1:** `pnpm build` and launch the ad-hoc-signed `Shep.app` (not `pnpm dev` — an unsigned build's banners are refused before they are drawn).
- [ ] **Step 2:** Run two tasks. Let one finish a turn with changes on disk, and let one block on a permission prompt.
- [ ] **Step 3:** Check each banner names its own task, carries the right second line, and shows its buttons.
- [ ] **Step 4:** From another app, click the finished one's body — it should land on that task's Diff, and `esc` should go Home rather than back into the other task.
- [ ] **Step 5:** Click `Later today` on the blocked one — its row moves to Later and the window does not move.
- [ ] **Step 6:** Write what actually happened into the spec as a measured note. If macOS drew only one button, say so: the two-button claim is the thing this step is testing.
