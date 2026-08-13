# Snapshot Archived Tabs Until Unarchive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Viewing a shelved task renders the screens it was archived with — no worktrees, no git, no ptys — and only an explicit Restore puts the real thing back.

**Architecture:** The layout kernel learns one new idea: a pane may be `readOnly`, carrying a `snapshotFile` path instead of a session. The renderer's session registry never creates a session for such a pane and writes the file's bytes into its emulator once. `layout.openRoot` gains a `tree` argument so a root can open with a shape, which serves both the snapshot view and (finally) the live restore. `tasks.reveal` stops calling `materialize`; `tasks.restore` becomes the one verb that does.

**Tech Stack:** TypeScript, Electron, React, `@xterm/xterm` (renderer) / `@xterm/headless` (main), `node:sqlite` KV, Vitest.

**Spec:** [`docs/superpowers/specs/2026-08-13-snapshot-archived-tabs-design.md`](../specs/2026-08-13-snapshot-archived-tabs-design.md)

## Global Constraints

- **Every command runs from `v2/` and takes `env -u NODE_OPTIONS`.** An ambient `NODE_OPTIONS` makes Electron exit 9 before running a line of our code. Example: `env -u NODE_OPTIONS pnpm test`.
- **The gate before calling any task/layout work done is `env -u NODE_OPTIONS pnpm smoke:m3`.** A green unit suite is not a working app — this repo has the scars (the archive-on-close bug passed every unit test because each supplied both halves of the correlation).
- **`v2/tooling/eslint/boundaries.js` IS the architecture diagram.** A package imports something because a line there says so. This plan adds no new cross-package import; if you find yourself needing one, stop and say so.
- **An extension never names a vendor, and the kernel never names a task.** The layout kernel learns "replay bytes from this file", not "this is an archive". The shell draws a button from an extension-supplied label + command id, never from a hardcoded `tasks.restore`.
- **`packages/app/src/shared/**` may not import a runtime VALUE.** The sandboxed preload loads that barrel; a value there fails the preload script and takes the window with it. Types only.
- **Answers from a command are `unknown`, and a cast is not a check.** Read defensively across the port.
- Full check line: `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`

## File Structure

**Core (kernel):**
- `packages/core/src/layout/pane.ts` — `Pane` gains `readOnly` + `snapshotFile`.
- `packages/core/src/layout/serialize.ts` — both fields round-trip.
- `packages/core/src/layout/store.ts` — `OpenOptions.tree`; `RootPlaceholder.action`; `placeholderOf` widened to "no live panes".
- `packages/core/src/layout/commands.ts` — `layout.openRoot` accepts `tree`; `PLACEHOLDER` schema accepts `action`.

**App (shell):**
- `packages/app/src/shared/channels.ts` — `layout:snapshotBytes` channel + DTO; `LayoutSnapshot.placeholder` gains `action`.
- `packages/app/src/shared/bridge.ts` — `layout.snapshotBytes(paneId)`.
- `packages/app/src/preload/api.ts` — one line wiring it.
- `packages/app/src/main/ipc.ts` — the handler that reads the file.
- `packages/app/src/renderer/pane-sessions.ts` — a read-only pane wants no session and is born showing its bytes.
- `packages/app/src/renderer/archived-banner.tsx` (new) — the "Archived — Restore" bar.
- `packages/app/src/renderer/app.tsx` — renders the banner over a root that has panes.

**Extension:**
- `extensions/tasks/src/model/archive-tabs.ts` — `snapshotTreeFor(tab, dir)`, pure.
- `extensions/tasks/src/index.ts` — `reveal` stops materializing; `restore` closes snapshot roots and materializes; `rebuildTabs` passes `tree`; the sidebar's Restore action.

**Gate:**
- `packages/app/src/main/smoke-m3.ts` — the two assertions that matter.

---

### Task 1: A pane may be read-only

**Files:**
- Modify: `v2/packages/core/src/layout/pane.ts:19-47`
- Modify: `v2/packages/core/src/layout/serialize.ts:38-64`, `:96-112`
- Test: `v2/packages/core/src/layout/store.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Pane.readOnly: boolean` and `Pane.snapshotFile: string | null`
  - `PaneInit.readOnly?: boolean`, `PaneInit.snapshotFile?: string | null`
  - `PersistedPane.readOnly?: true`, `PersistedPane.snapshotFile?: string`
  - `makePane({ readOnly: true, snapshotFile: '/x.term' })` → a pane with both set.

- [ ] **Step 1: Write the failing test**

Append to `v2/packages/core/src/layout/store.test.ts`:

```ts
describe('a read-only pane', () => {
  it('round-trips readOnly and snapshotFile through serialize/deserialize', () => {
    const pane = makePane({ id: paneId('p-1'), cwd: '/w', readOnly: true, snapshotFile: '/a/p-1.term' });
    const persisted = serializeNode(leaf(pane));

    expect(persisted).toEqual({
      kind: 'leaf',
      pane: { cwd: '/w', id: 'p-1', readOnly: true, snapshotFile: '/a/p-1.term' },
    });

    const back = deserializeNode(persisted);
    expect(back.kind).toBe('leaf');
    if (back.kind !== 'leaf') throw new Error('expected a leaf');
    expect(back.pane.readOnly).toBe(true);
    expect(back.pane.snapshotFile).toBe('/a/p-1.term');
  });

  it('writes neither field for an ordinary pane, so an old reader sees what it always did', () => {
    const persisted = serializeNode(leaf(makePane({ id: paneId('p-2') })));
    expect(persisted).toEqual({ kind: 'leaf', pane: { id: 'p-2' } });
  });

  it('reads a record written before read-only panes existed as an ordinary pane', () => {
    const back = deserializeNode({ kind: 'leaf', pane: { id: 'p-3' } });
    if (back.kind !== 'leaf') throw new Error('expected a leaf');
    expect(back.pane.readOnly).toBe(false);
    expect(back.pane.snapshotFile).toBeNull();
  });

  it('refuses a snapshotFile that is not a string, rather than rendering a blank pane', () => {
    expect(() => deserializeNode({ kind: 'leaf', pane: { snapshotFile: 7 } })).toThrow(
      'pane.snapshotFile must be a string',
    );
  });
});
```

Add whatever of `makePane`, `paneId`, `leaf`, `serializeNode`, `deserializeNode` the file does not already import — check its existing import block first and extend it rather than adding a second one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- store.test.ts`
Expected: FAIL — `readOnly` is not a property of `PaneInit` (a typecheck error), or the equality assertions fail.

- [ ] **Step 3: Add the fields to `Pane`**

In `v2/packages/core/src/layout/pane.ts`, add to `Pane` after `initialCommand`:

```ts
  /**
   * This pane shows a captured screen and NEVER gets a session.
   *
   * The one case where a pane with no session binding is correct rather than a
   * failure: an archived task's tabs are rendered from what was on screen when
   * it was shelved, and provisioning a worktree to look at old work is the cost
   * this exists to avoid. Persisted, unlike every other live-state field here —
   * a snapshot is not work in flight, it is what the pane *is*.
   */
  readonly readOnly: boolean;
  /**
   * Where the bytes it replays live. Absolute, and read by MAIN, not here.
   *
   * A path and nothing more: the kernel does not learn that these came from an
   * archive, or that a task exists. Whoever wrote the file named it.
   */
  readonly snapshotFile: string | null;
```

Add to `PaneInit`:

```ts
  readOnly?: boolean;
  snapshotFile?: string | null;
```

And to the object `makePane` returns:

```ts
    readOnly: init.readOnly ?? false,
    snapshotFile: init.snapshotFile ?? null,
```

- [ ] **Step 4: Make both fields persist**

In `v2/packages/core/src/layout/serialize.ts`, add to `PersistedPane`:

```ts
  /**
   * Present only for a pane that shows a captured screen. Absent — not `false` —
   * on every ordinary pane, so a payload written by this build is byte-identical
   * to one written before the field existed for every layout that has no
   * snapshot in it.
   */
  readonly readOnly?: true;
  /** The file that pane replays. Absolute. */
  readonly snapshotFile?: string;
```

Extend `serializePane`'s local type and body:

```ts
export function serializePane(pane: Pane, sessionId?: string): PersistedPane {
  const out: {
    userTitle?: string;
    cwd?: string;
    id?: string;
    sessionId?: string;
    readOnly?: true;
    snapshotFile?: string;
  } = {};
  if (pane.userTitle !== null && pane.userTitle !== '') out.userTitle = pane.userTitle;
  if (pane.cwd !== null && pane.cwd !== '') out.cwd = pane.cwd;
  out.id = pane.id;
  if (sessionId !== undefined && sessionId !== '') out.sessionId = sessionId;
  if (pane.readOnly) out.readOnly = true;
  if (pane.snapshotFile !== null && pane.snapshotFile !== '') out.snapshotFile = pane.snapshotFile;
  return out;
}
```

In `deserializeNode`'s leaf branch, read them alongside the id:

```ts
    const persistedId = optionalString(pane['id'], 'pane.id');
    const snapshotFile = optionalString(pane['snapshotFile'], 'pane.snapshotFile');
    return leaf(
      makePane(
        {
          userTitle: optionalString(pane['userTitle'], 'pane.userTitle'),
          cwd: optionalString(pane['cwd'], 'pane.cwd'),
          readOnly: pane['readOnly'] === true,
          snapshotFile,
          ...(persistedId === null ? {} : { id: paneId(persistedId) }),
        },
        random,
      ),
    );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- store.test.ts`
Expected: PASS, including the pre-existing tests in that file.

- [ ] **Step 6: Full check and commit**

```bash
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
git add v2/packages/core/src/layout/pane.ts v2/packages/core/src/layout/serialize.ts v2/packages/core/src/layout/store.test.ts
git commit -m "layout: a pane may be read-only, showing a file instead of a session"
```

---

### Task 2: A root can open with a shape

**Files:**
- Modify: `v2/packages/core/src/layout/store.ts:108-126` (`OpenOptions`), `:342-380` (`open`)
- Modify: `v2/packages/core/src/layout/commands.ts:268-397` (`layout.openRoot`)
- Test: `v2/packages/core/src/layout/store.test.ts`

**Interfaces:**
- Consumes: Task 1's `PersistedPane.readOnly` / `snapshotFile`.
- Produces:
  - `OpenOptions.tree?: PersistedNode` — applies to the MINT only.
  - `layout.openRoot` accepts `tree?: unknown`, validated by `deserializeNode`.

- [ ] **Step 1: Write the failing test**

Append to the `describe('a read-only pane')` block in `store.test.ts`:

```ts
  it('opens a root with the shape it is given, ids and ratios included', () => {
    const store = makeStore(); // use whatever this file's existing store helper is called
    store.open('r-1', undefined, {
      tree: {
        kind: 'split',
        axis: 'column',
        ratio: 0.25,
        first: { kind: 'leaf', pane: { id: 'p-a', readOnly: true, snapshotFile: '/a.term' } },
        second: { kind: 'leaf', pane: { id: 'p-b', readOnly: true, snapshotFile: '/b.term' } },
      },
    });

    const tree = store.tree(rootId('r-1'));
    expect(tree?.kind).toBe('split');
    if (tree?.kind !== 'split') throw new Error('expected a split');
    expect(tree.axis).toBe('column');
    expect(tree.ratio).toBeCloseTo(0.25);
    expect(store.panes(rootId('r-1'))).toEqual(['p-a', 'p-b']);
  });

  it('mints an ordinary single-pane root when the given shape cannot be read', () => {
    const store = makeStore();
    store.open('r-2', undefined, { tree: { kind: 'split', axis: 'sideways' } as never });
    expect(store.panes(rootId('r-2'))).toHaveLength(1);
    expect(store.tree(rootId('r-2'))?.kind).toBe('leaf');
  });
```

Replace `makeStore()` and `rootId` with the helpers this test file already uses — read the top of `store.test.ts` and match it exactly rather than introducing a second construction style.

- [ ] **Step 2: Run the test to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- store.test.ts`
Expected: FAIL — `tree` is not a property of `OpenOptions`.

- [ ] **Step 3: Add `tree` to `OpenOptions` and honour it in `open`**

In `store.ts`, add to `OpenOptions` (after `group`):

```ts
  /**
   * The SHAPE to mint this root with — splits, ratios and pane ids — instead of
   * one pane.
   *
   * Applies to the mint alone, exactly like `empty` and `group`: a restored root
   * already has the panes the user left there, and re-deciding its shape here
   * would let the second caller of `open` rearrange the first caller's window.
   *
   * It exists because `split` takes an axis and no path, so a tree of ratios
   * could not be reproduced through it — which is why a restored task's tabs
   * came back FLAT for two milestones. One argument here serves both the
   * snapshot view and the live restore, so the two cannot drift into showing
   * the same task two different ways.
   */
  readonly tree?: PersistedNode;
```

Import `type PersistedNode` from `./serialize.ts` — the file already imports `deserializeNode` from there.

In `open`, insert the shaped mint between the `empty` branch and the single-pane mint (i.e. after the `if (options.empty === true) {...}` block ending at `:362`):

```ts
    if (options.tree !== undefined) {
      let shaped: SplitNode | undefined;
      try {
        shaped = deserializeNode(options.tree, this.#newPane);
      } catch (error) {
        // The same bargain `#restore` strikes: a shape that cannot be read costs
        // one layout, and throwing here would cost the caller its root entirely.
        // Falling through mints the ordinary single pane below.
        this.#log.warn(`could not open ${id} with the given shape: ${messageOf(error)}`);
      }
      if (shaped !== undefined) {
        const state: RootState = {
          id: rootId(id),
          group: options.group ?? id,
          tree: shaped,
          focusedPaneId: firstLeafId(shaped),
          zoomedPaneId: null,
          viewport: { x: 0, y: 0, width: 0, height: 0 },
          placeholder: undefined,
        };
        this.#roots.set(state.id, state);
        this.#changed(state.id);
        return state.id;
      }
    }
```

`firstLeafId`, `SplitNode` and `messageOf` are all already in scope in this file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- store.test.ts`
Expected: PASS

- [ ] **Step 5: Expose it on `layout.openRoot`**

In `commands.ts`, add to the `openRoot` schema (beside `placeholder` at `:332`):

```ts
        /**
         * The shape to mint this root with, in `serialize.ts`'s own vocabulary —
         * what `layout.listRoots` hands out as `tree`.
         *
         * `s.unknown()` rather than a schema of its own: `deserializeNode` is
         * already the validator for this format and writing a second one here is
         * a second thing to keep in step with it. It runs inside `store.open`.
         *
         * Ignored when the root already has panes, like every other pane-shaping
         * argument on this verb.
         */
        tree: s.optional(s.unknown()),
```

In the handler, pass it through both mint paths. The `store.hasRoot(root)` branch at `:387` is a root that exists but is empty; a shape cannot be applied through `split`, so `tree` only reaches `store.open`:

```ts
        store.open(args.root, init, {
          ...(args.group === undefined ? {} : { group: args.group }),
          ...(args.tree === undefined ? {} : { tree: args.tree as PersistedNode }),
        });
        stageSeed(root, args.seed);
        return { root: args.root, pane: store.focused(root), created: true };
```

Import `type PersistedNode` from `./serialize.ts` in `commands.ts`.

- [ ] **Step 6: Test the command surface**

Append to `store.test.ts` (or to `commands`' own test file if one exists — check for `packages/core/src/layout/commands.test.ts` first and prefer it):

```ts
  it('opens a root through the command with the shape it was given', async () => {
    const h = layoutHarness(); // match this file's existing command-test helper
    await h.run('layout.openRoot', {
      root: 'r-3',
      tree: {
        kind: 'split',
        axis: 'row',
        ratio: 0.5,
        first: { kind: 'leaf', pane: { id: 'p-c' } },
        second: { kind: 'leaf', pane: { id: 'p-d' } },
      },
    });
    expect(h.store.panes(rootId('r-3'))).toEqual(['p-c', 'p-d']);
  });
```

- [ ] **Step 7: Full check and commit**

```bash
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
git add v2/packages/core/src/layout/
git commit -m "layout: a root can be opened with a shape, not just a pane"
```

---

### Task 3: A placeholder may sit over a root with panes, and may carry a verb

**Files:**
- Modify: `v2/packages/core/src/layout/store.ts:245-271` (`RootPlaceholder`, `samePlaceholder`), `:536-549` (`placeholderOf`)
- Modify: `v2/packages/core/src/layout/commands.ts:81` (`PLACEHOLDER` schema)
- Modify: `v2/packages/app/src/shared/channels.ts:247-255` (`LayoutSnapshot.placeholder`)
- Test: `v2/packages/core/src/layout/store.test.ts`

**Interfaces:**
- Consumes: Task 1's `Pane.readOnly`.
- Produces:
  - `RootPlaceholder.action?: { readonly command: string; readonly label: string; readonly args?: Readonly<Record<string, unknown>> }`
  - `placeholderOf(root)` answers for a root whose panes are ALL read-only.
  - `LayoutSnapshot.placeholder` carries the same optional `action`.

- [ ] **Step 1: Write the failing test**

```ts
  it('answers with a placeholder over a root whose panes are all read-only', () => {
    const store = makeStore();
    store.open('r-4', undefined, {
      tree: { kind: 'leaf', pane: { id: 'p-e', readOnly: true, snapshotFile: '/e.term' } },
    });
    store.setPlaceholder(rootId('r-4'), {
      line: 'Archived',
      action: { command: 'x.restore', label: 'Restore', args: { task: 't1' } },
    });

    expect(store.placeholderOf(rootId('r-4'))?.action?.label).toBe('Restore');
  });

  it('still refuses one over a root with a LIVE pane — the case the guard exists for', () => {
    const store = makeStore();
    store.open('r-5');
    store.setPlaceholder(rootId('r-5'), { line: 'Creating the worktree' });
    expect(store.placeholderOf(rootId('r-5'))).toBeUndefined();
  });

  it('refuses one over a mixed root, where a live pane is present', () => {
    const store = makeStore();
    store.open('r-6', undefined, {
      tree: {
        kind: 'split',
        axis: 'row',
        ratio: 0.5,
        first: { kind: 'leaf', pane: { id: 'p-f', readOnly: true, snapshotFile: '/f.term' } },
        second: { kind: 'leaf', pane: { id: 'p-g' } },
      },
    });
    store.setPlaceholder(rootId('r-6'), { line: 'Archived' });
    expect(store.placeholderOf(rootId('r-6'))).toBeUndefined();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- store.test.ts`
Expected: FAIL — `action` is not a property of `RootPlaceholder`, and the first case returns `undefined`.

- [ ] **Step 3: Widen the type and the guard**

In `store.ts`, add to `RootPlaceholder`:

```ts
  /**
   * One verb the shell offers alongside the line, supplied by whoever set it.
   *
   * A command id and a label, exactly like `TreeItem.command` — so the shell
   * draws a button for something it has never heard of. The alternative was the
   * shell knowing `tasks.restore` exists, which is the special case ADR 0031
   * exists to prevent.
   */
  readonly action?: {
    readonly command: string;
    readonly label: string;
    readonly args?: Readonly<Record<string, unknown>>;
  };
```

Extend `samePlaceholder` so an action change still announces (the function is the reason an unchanged placeholder does not push a snapshot per tick):

```ts
function samePlaceholder(a: RootPlaceholder | undefined, b: RootPlaceholder | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.line !== b.line) return false;
  if (a.action?.command !== b.action?.command) return false;
  if (a.action?.label !== b.action?.label) return false;
  if (JSON.stringify(a.action?.args ?? {}) !== JSON.stringify(b.action?.args ?? {})) return false;
  const left = a.names ?? [];
  const right = b.names ?? [];
  return left.length === right.length && left.every((name, i) => name === right[i]);
}
```

Replace `placeholderOf`'s body and rewrite its comment — the reason for the guard is what changes, not the guard's existence:

```ts
  /**
   * What this root says about itself — and **nothing at all while a live pane is
   * in it**.
   *
   * The guard used to be "no panes", and the reason was never the panes: it was
   * that a stale line is the one way this feature can lie — `Creating the
   * worktree` drawn over a running agent. A root of READ-ONLY panes has no
   * running agent and nothing on its way, so the lie is unreachable there and
   * the guard narrows to what it was always about. `#seed` still clears the
   * placeholder when a real pane lands, so the state cannot accumulate
   * falsehoods.
   */
  placeholderOf(root: RootID): RootPlaceholder | undefined {
    const state = this.#roots.get(root);
    if (!state) return undefined;
    if (state.tree !== null && !allReadOnly(state.tree)) return undefined;
    return state.placeholder;
  }
```

Add the walk near `samePlaceholder`:

```ts
/** Every leaf of this tree shows a captured screen — nothing in it is live. */
function allReadOnly(node: SplitNode): boolean {
  return node.kind === 'leaf'
    ? node.pane.readOnly
    : allReadOnly(node.first) && allReadOnly(node.second);
}
```

- [ ] **Step 4: Carry `action` across the schema and the wire**

In `commands.ts:81`:

```ts
const PLACEHOLDER = s.object({
  line: s.string(),
  names: s.optional(s.array(s.string())),
  action: s.optional(
    s.object({ command: s.string(), label: s.string(), args: s.optional(s.unknown()) }),
  ),
});
```

In `channels.ts`, replace the inline placeholder type on `LayoutSnapshot` (`:255`) and update the comment above it — it currently asserts "Present ONLY alongside `tree: null`", which is no longer true:

```ts
  /**
   * Why this root is empty, or — for a root of read-only panes — what it is.
   *
   * Present alongside `tree: null` (the home root at launch, a task whose
   * worktrees are still being cut) and alongside a tree whose every pane is a
   * captured screen. Core refuses to answer with one over a root that holds a
   * LIVE pane, so the page still cannot draw a wait that is over.
   */
  readonly placeholder?: {
    readonly line: string;
    readonly names?: readonly string[];
    readonly action?: {
      readonly command: string;
      readonly label: string;
      readonly args?: Readonly<Record<string, unknown>>;
    };
  };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- store.test.ts`
Expected: PASS

- [ ] **Step 6: Full check and commit**

```bash
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
git add v2/packages/core/src/layout/ v2/packages/app/src/shared/channels.ts
git commit -m "layout: a placeholder may cover a root of read-only panes, and may offer a verb"
```

---

### Task 4: The bytes reach the renderer

**Files:**
- Modify: `v2/packages/app/src/shared/channels.ts:30` (the `INVOKE` map)
- Modify: `v2/packages/app/src/shared/bridge.ts:114` (the `layout` section)
- Modify: `v2/packages/app/src/preload/api.ts:64-67`
- Modify: `v2/packages/app/src/main/ipc.ts`
- Test: `v2/packages/app/src/preload/api.test.ts`

**Interfaces:**
- Consumes: Task 1's `Pane.snapshotFile`.
- Produces: `bridge.layout.snapshotBytes(paneId: string): Promise<IpcResult<{ bytes: Uint8Array }>>` — resolves the pane's `snapshotFile` in main, reads it, and answers its bytes. Errors with code `no-snapshot` when the pane has no file or the file cannot be read.

- [ ] **Step 1: Write the failing test**

Append to `v2/packages/app/src/preload/api.test.ts`, matching the file's existing harness:

```ts
  it('asks main for a pane snapshot on the layout channel', () => {
    void bridge.layout.snapshotBytes('p-1');
    expect(ipc.invoked).toContainEqual({ channel: 'layout:snapshotBytes', args: ['p-1'] });
  });
```

Match the exact assertion shape the surrounding tests use — read them first; the harness records invocations in its own format and this is the one place the plan cannot guess it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test -- api.test.ts`
Expected: FAIL — `snapshotBytes` is not a property of `bridge.layout`.

- [ ] **Step 3: Declare the channel and the API**

In `channels.ts`, add to the `INVOKE` map beside `layoutViewport`:

```ts
  layoutSnapshotBytes: 'layout:snapshotBytes',
```

In `bridge.ts`, add to the `layout` interface:

```ts
  /**
   * The captured screen a read-only pane shows.
   *
   * Asked ONCE, when the pane's terminal is built — not carried in the layout
   * envelope. That envelope is pushed on every change, and a screenful of
   * scrollback per read-only pane on each push is a cost paid forever for a
   * value that never changes.
   */
  snapshotBytes(paneId: string): Promise<IpcResult<{ readonly bytes: Uint8Array }>>;
```

In `preload/api.ts`, inside the `layout` object:

```ts
      snapshotBytes: (paneId) => invoke(INVOKE.layoutSnapshotBytes, paneId),
```

- [ ] **Step 4: Handle it in main**

In `v2/packages/app/src/main/ipc.ts`, register a handler beside the existing `layout:` ones:

```ts
  handle(INVOKE.layoutSnapshotBytes, async (_event, paneId: unknown) => {
    if (typeof paneId !== 'string' || paneId === '') {
      return fail('no-snapshot', 'a pane id is required');
    }
    const pane = layout.pane(toPaneId(paneId));
    const file = pane?.snapshotFile ?? null;
    if (file === null || file === '') {
      return fail('no-snapshot', `pane ${paneId} shows no captured screen`);
    }
    try {
      return succeed({ bytes: new Uint8Array(await readFile(file)) });
    } catch (error) {
      // A missing file is an archive that was expired or hand-cleaned. The pane
      // comes back BLANK rather than the root refusing to open — the same stance
      // `tasks`' own `readHistory` takes, one layer down.
      return fail('no-snapshot', `could not read ${file}: ${messageOf(error)}`);
    }
  });
```

Match `fail` / `succeed` / `handle` to whatever this file already uses — read its existing handlers and copy their shape exactly. `readFile` comes from `node:fs/promises`.

`LayoutStore.pane(id)` already exists (`store.ts:587`) and answers `Pane | null` across every root — no new lookup is needed, and adding one would be a second walk over the same trees.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test -- api.test.ts`
Expected: PASS

- [ ] **Step 6: Full check and commit**

```bash
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
git add v2/packages/app/src/shared/ v2/packages/app/src/preload/ v2/packages/app/src/main/ipc.ts v2/packages/core/src/layout/store.ts
git commit -m "app: main answers a read-only pane's captured screen over IPC"
```

---

### Task 5: A read-only pane holds a terminal and no session

**Files:**
- Modify: `v2/packages/app/src/renderer/pane-sessions.ts:255-284` (`attach`), `:349-370` (`suspend`), `:455-496` (`#buildTerminal`), `:174-179` (`PaneSessionRegistryOptions`)
- Modify: `v2/packages/app/src/renderer/main.tsx` (where the registry is constructed)
- Test: `v2/packages/app/src/renderer/pane-sessions.test.ts`

**Interfaces:**
- Consumes: Task 1's `Pane.readOnly` / `snapshotFile`; Task 4's `bridge.layout.snapshotBytes`.
- Produces: `PaneSessionRegistryOptions.snapshotBytes?: (paneId: string) => Promise<Uint8Array | null>` — injected, so the lifecycle tests keep running in jsdom with no bridge.

- [ ] **Step 1: Write the failing test**

Append to `v2/packages/app/src/renderer/pane-sessions.test.ts`, using the file's existing fake-terminal / fake-session harness:

```ts
describe('a read-only pane', () => {
  it('creates no session, however many times it is attached', async () => {
    const h = harness({ snapshotBytes: async () => new Uint8Array([0x68, 0x69]) });
    const pane = makePane({ id: paneId('p-1'), readOnly: true, snapshotFile: '/p-1.term' });

    h.registry.attach(pane, h.host());
    h.registry.detach(pane.id);
    h.registry.attach(pane, h.host());
    await h.settle();

    expect(h.session.created).toHaveLength(0);
  });

  it('is born showing the bytes main answers with', async () => {
    const h = harness({ snapshotBytes: async () => new Uint8Array([0x68, 0x69]) });
    const pane = makePane({ id: paneId('p-2'), readOnly: true, snapshotFile: '/p-2.term' });

    h.registry.attach(pane, h.host());
    await h.settle();

    expect(h.terminalFor('p-2')?.written).toContainEqual(new Uint8Array([0x68, 0x69]));
  });

  it('comes back blank rather than refusing when the file has gone', async () => {
    const h = harness({ snapshotBytes: async () => null });
    const pane = makePane({ id: paneId('p-3'), readOnly: true, snapshotFile: '/gone.term' });

    h.registry.attach(pane, h.host());
    await h.settle();

    expect(h.terminalFor('p-3')).not.toBeNull();
    expect(h.session.created).toHaveLength(0);
  });

  it('still creates a session for an ordinary pane', async () => {
    const h = harness({});
    h.registry.attach(makePane({ id: paneId('p-4') }), h.host());
    await h.settle();
    expect(h.session.created).toHaveLength(1);
  });
});
```

Adapt `harness`, `h.host()`, `h.settle()`, `h.terminalFor` and `h.session.created` to this file's actual helpers — read them first. If the fake terminal does not record writes, add a `written: Uint8Array[]` array to it (`test-terminals.ts`), pushed to in its `write`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test -- pane-sessions.test.ts`
Expected: FAIL — the first test sees one created session, and `snapshotBytes` is not an option.

- [ ] **Step 3: Take the option and stop wanting a session**

In `PaneSessionRegistryOptions`:

```ts
  /**
   * The captured screen a read-only pane shows, or null when it cannot be read.
   *
   * Injected rather than reached for, exactly like `session` and
   * `createTerminal`: this file is what makes the lifecycle tests runnable in
   * jsdom, and a direct `window.shepherd` here would need a bridge to exist for
   * a test about attach ordering.
   */
  readonly snapshotBytes?: (paneId: string) => Promise<Uint8Array | null>;
```

Store it in the constructor as `#snapshotBytes`.

In `attach`, replace `entry.wantSession = true;` with:

```ts
    // A read-only pane shows a file and must never reach `#sync`'s create
    // branch. This flag is the whole enforcement — the pane is otherwise an
    // ordinary entry, which is what keeps focus, fit, find and suspend working
    // for it with no second code path.
    entry.wantSession = !pane.readOnly;
```

In `suspend`, make the same substitution wherever it sets `wantSession = true`.

- [ ] **Step 4: Write the bytes when the terminal is built**

At the end of `#buildTerminal`, after the `viewDisposables.push(...)` call:

```ts
    /*
     * A read-only pane is born showing its file.
     *
     * Here rather than in `#sync` because this is the moment the emulator
     * exists, and because a suspended pane that wakes gets a FRESH terminal —
     * so the screen has to be rewritten then too, and hanging it off the build
     * is what makes that automatic rather than a case somebody remembers.
     */
    const file = entry.pane.snapshotFile;
    if (entry.pane.readOnly && file !== null && file !== '' && this.#snapshotBytes !== undefined) {
      void this.#snapshotBytes(entry.paneId)
        .then((bytes) => {
          // `entry.terminal`, not the local — the pane may have been suspended
          // or released while this was in flight, and writing into a disposed
          // emulator is the shape of a crash in a path nobody watches.
          if (bytes !== null && bytes.length > 0) entry.terminal?.write(bytes);
        })
        .catch((error: unknown) => this.#onError(error, `snapshot ${entry.paneId}`));
    }
```

- [ ] **Step 5: Wire the real implementation**

In `v2/packages/app/src/renderer/main.tsx`, where `PaneSessionRegistry` is constructed, add:

```ts
  snapshotBytes: async (paneId) => {
    const answer = await bridge.layout.snapshotBytes(paneId);
    return answer.ok ? answer.value.bytes : null;
  },
```

Match `bridge` to whatever that file calls the preload API.

- [ ] **Step 6: Mark the pane in the DOM for the smoke**

In `v2/packages/app/src/renderer/terminal-pane.tsx`, add to the `sh-pane` div beside `data-agent-state`:

```tsx
      data-readonly={pane.readOnly ? 'true' : ''}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test -- pane-sessions.test.ts`
Expected: PASS

- [ ] **Step 8: Full check and commit**

```bash
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
git add v2/packages/app/src/renderer/
git commit -m "renderer: a read-only pane shows its captured screen and starts nothing"
```

---

### Task 6: The archived banner

**Files:**
- Create: `v2/packages/app/src/renderer/archived-banner.tsx`
- Modify: `v2/packages/app/src/renderer/app.tsx:718` (the stage's render)
- Modify: `v2/packages/app/src/renderer/styles.css`
- Test: `v2/packages/app/src/renderer/app.test.tsx`

**Interfaces:**
- Consumes: Task 3's `LayoutSnapshot.placeholder.action`.
- Produces: `ArchivedBanner({ placeholder, onAction })` — a `<div className="sh-archived-banner">` with the line and, when an action is present, a button that calls `onAction(command, args)`.

- [ ] **Step 1: Write the failing test**

Append to `app.test.tsx`:

```tsx
  it('draws a banner over a root of read-only panes and runs its verb through commands.invoke', async () => {
    const h = renderApp({
      snapshots: {
        active: 'r-1',
        roots: [
          {
            root: 'r-1',
            group: 'g',
            tree: leaf(makePane({ id: paneId('p-1'), readOnly: true, snapshotFile: '/a.term' })),
            focusedPaneId: 'p-1',
            zoomedPaneId: null,
            sessions: {},
            placeholder: {
              line: 'Archived',
              action: { command: 'tasks.restore', label: 'Restore', args: { task: 't1' } },
            },
          },
        ],
      },
    });

    await userEvent.click(await h.findByRole('button', { name: 'Restore' }));
    expect(h.commands.invoked).toContainEqual(['tasks.restore', { task: 't1' }]);
  });

  it('draws no banner for a root with no placeholder', () => {
    const h = renderApp({ snapshots: placeholderSnapshots() });
    expect(h.queryByTestId('archived-banner')).toBeNull();
  });
```

Match `renderApp`, `h.commands.invoked` and the click helper to this file's existing patterns — `app.test.tsx` already asserts about `commands.invoke` (see its test at `:858`), so copy that assertion's exact shape.

- [ ] **Step 2: Run the test to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test -- app.test.tsx`
Expected: FAIL — no button named "Restore" is in the document.

- [ ] **Step 3: Write the component**

Create `v2/packages/app/src/renderer/archived-banner.tsx`:

```tsx
import type { ReactNode } from 'react';

/**
 * What a root of captured screens says about itself, and the one verb that ends
 * that state.
 *
 * The line and the label both come from whoever set the placeholder. This file
 * knows there is a string and a command id; it does not know what a task is, or
 * that `tasks.restore` exists — the rule ADR 0031 sets for a contributed row's
 * verbs, applied to a root.
 */
export interface ArchivedBannerProps {
  readonly placeholder: {
    readonly line: string;
    readonly action?: {
      readonly command: string;
      readonly label: string;
      readonly args?: Readonly<Record<string, unknown>>;
    };
  };
  readonly onAction: (command: string, args: Readonly<Record<string, unknown>>) => void;
}

export function ArchivedBanner({ placeholder, onAction }: ArchivedBannerProps): ReactNode {
  const action = placeholder.action;
  return (
    <div className="sh-archived-banner" data-testid="archived-banner">
      <span className="sh-archived-banner-line">{placeholder.line}</span>
      {action === undefined ? null : (
        <button
          type="button"
          className="sh-archived-banner-action"
          onClick={() => onAction(action.command, action.args ?? {})}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Render it over a root that has panes**

In `app.tsx`, the stage currently draws `EmptyState` when the active root's tree is null (`:718`). Add the banner as a sibling ABOVE the split view, for the case where a tree exists and a placeholder came anyway — which core now only answers for a root of read-only panes:

```tsx
{active?.tree !== null && active?.placeholder !== undefined ? (
  <ArchivedBanner
    placeholder={active.placeholder}
    onAction={(command, args) => {
      void commands.invoke(command, args);
    }}
  />
) : null}
```

Place it inside the same container the split view is in, before it, so the banner sits at the top of the stage. Use the same `commands.invoke` call site the file already funnels gestures through (`app.tsx:238`) rather than a second one.

- [ ] **Step 5: Style it**

In `styles.css`, add:

```css
/*
 * The bar over a root of captured screens. Painted in ROLE tokens, never a hue
 * (`@shepherd/ui`'s rule), and static — a pulse or a shimmer here would say
 * something is happening, and the whole point of this root is that nothing is.
 */
.sh-archived-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sh-space-2);
  padding: var(--sh-space-1) var(--sh-space-3);
  background: var(--sh-surface-raised);
  border-bottom: 1px solid var(--sh-border);
  color: var(--sh-ink-muted);
  font: var(--sh-type-label);
}

.sh-archived-banner-action {
  border: 1px solid var(--sh-border);
  border-radius: var(--sh-radius-1);
  background: transparent;
  color: var(--sh-accent);
  padding: var(--sh-space-1) var(--sh-space-2);
  cursor: pointer;
}
```

Check the exact token names against `packages/design-tokens` and `token-refs.css.test.ts` — that test fails the build for a token reference that does not exist, which is how you will find out if any name above is wrong.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test -- app.test.tsx token-refs.css.test.ts`
Expected: PASS

- [ ] **Step 7: Full check and commit**

```bash
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
git add v2/packages/app/src/renderer/
git commit -m "renderer: a root of captured screens says so, and offers the verb that ends it"
```

---

### Task 7: Revealing a shelved task shows its snapshot

**Files:**
- Modify: `v2/extensions/tasks/src/model/archive-tabs.ts` (add `snapshotTreeFor`)
- Modify: `v2/extensions/tasks/src/index.ts:2795-2990` (`tasks.reveal`)
- Test: `v2/extensions/tasks/src/model/archive-tabs.test.ts`, `v2/extensions/tasks/src/index.test.ts`

**Interfaces:**
- Consumes: Task 2's `layout.openRoot` `tree` argument; Task 3's placeholder `action`.
- Produces:
  - `snapshotTreeFor(tab: ArchivedTab, archiveDir: string): unknown | undefined` — the tab's stored `tree` with every leaf marked `readOnly: true` and given the absolute `snapshotFile` for that pane, or `undefined` when the tab stored no tree.
  - `openSnapshotTabs(task: TaskRecord): Promise<void>` in `index.ts`.

- [ ] **Step 1: Write the failing test for the pure part**

Append to `v2/extensions/tasks/src/model/archive-tabs.test.ts`:

```ts
describe('snapshotTreeFor', () => {
  const tab = {
    root: 'task:t1/tab-2',
    tree: {
      kind: 'split',
      axis: 'row',
      ratio: 0.4,
      first: { kind: 'leaf', pane: { id: 'p-1', cwd: '/w/a' } },
      second: { kind: 'leaf', pane: { id: 'p-2', cwd: '/w/b' } },
    },
    focusedPane: 'p-1',
    panes: [
      { pane: 'p-1', cwd: '/w/a', userTitle: null, history: 't1/task_t1_tab-2/p-1.term' },
      { pane: 'p-2', cwd: '/w/b', userTitle: null },
    ],
  } as const;

  it('marks every leaf read-only and gives the ones with a capture their file', () => {
    expect(snapshotTreeFor(tab, '/data/.archives')).toEqual({
      kind: 'split',
      axis: 'row',
      ratio: 0.4,
      first: {
        kind: 'leaf',
        pane: {
          id: 'p-1',
          cwd: '/w/a',
          readOnly: true,
          snapshotFile: '/data/.archives/t1/task_t1_tab-2/p-1.term',
        },
      },
      // No capture for this pane — read-only all the same, so it cannot start a
      // shell. It comes back blank, which is what an unreadable archive gives.
      second: { kind: 'leaf', pane: { id: 'p-2', cwd: '/w/b', readOnly: true } },
    });
  });

  it('drops a sessionId the archive happened to carry — nothing is live here', () => {
    const withSession = {
      ...tab,
      tree: { kind: 'leaf', pane: { id: 'p-1', sessionId: 's-9' } },
    } as const;
    expect(snapshotTreeFor(withSession, '/d')).toEqual({
      kind: 'leaf',
      pane: { id: 'p-1', readOnly: true, snapshotFile: '/d/t1/task_t1_tab-2/p-1.term' },
    });
  });

  it('answers undefined for a tab archived before trees were stored', () => {
    expect(snapshotTreeFor({ ...tab, tree: undefined }, '/d')).toBeUndefined();
  });

  it('answers undefined for a tree it cannot walk, rather than half of one', () => {
    expect(snapshotTreeFor({ ...tab, tree: { kind: 'sideways' } }, '/d')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- archive-tabs.test.ts`
Expected: FAIL — `snapshotTreeFor` is not exported.

- [ ] **Step 3: Write `snapshotTreeFor`**

Append to `v2/extensions/tasks/src/model/archive-tabs.ts`:

```ts
/**
 * The tab's stored shape, rewritten so every pane in it shows a FILE.
 *
 * Two things happen to each leaf and both are load-bearing:
 *
 *   - `readOnly: true`, on every leaf including the ones with no capture. A
 *     pane that fell through would spawn a shell in a directory the archive
 *     deleted, which is the exact failure this whole change removes; "blank" is
 *     the honest answer for a screen that was not saved.
 *   - `sessionId` is DROPPED. It is a claim the layout would try to reattach,
 *     and the session it names died when the task was shelved.
 *
 * The join is by pane id, which is the same key `archiveTabsFrom` used — the
 * tree's leaf id and `ArchivedPane.pane` are the same string by construction, so
 * there is one correlation here rather than two that can disagree.
 *
 * `undefined` for a tab with no tree, and for one whose tree cannot be walked:
 * the caller then opens the tab flat, which is what every restore did before
 * shapes were carried at all.
 */
export function snapshotTreeFor(tab: ArchivedTab, archiveDir: string): unknown | undefined {
  if (tab.tree === undefined || tab.tree === null) return undefined;
  const historyOf = new Map(tab.panes.map((pane) => [pane.pane, pane.history]));

  const walk = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null) throw new Error('not a node');
    const node = value as Record<string, unknown>;
    if (node['kind'] === 'leaf') {
      const pane = (node['pane'] ?? {}) as Record<string, unknown>;
      const id = typeof pane['id'] === 'string' ? pane['id'] : undefined;
      const history = id === undefined ? undefined : historyOf.get(id);
      const { sessionId: _dropped, ...rest } = pane;
      return {
        kind: 'leaf',
        pane: {
          ...rest,
          readOnly: true,
          ...(history === undefined ? {} : { snapshotFile: `${archiveDir}/${history}` }),
        },
      };
    }
    if (node['kind'] === 'split') {
      return {
        kind: 'split',
        axis: node['axis'],
        ratio: node['ratio'],
        first: walk(node['first']),
        second: walk(node['second']),
      };
    }
    throw new Error('not a node');
  };

  try {
    return walk(tab.tree);
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- archive-tabs.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test for `reveal`**

Append to `v2/extensions/tasks/src/index.test.ts`, matching its `harness` / `task` helpers:

```ts
  it('reveals a shelved task WITHOUT running git or creating a session', async () => {
    const h = (live = harness({
      tasks: [
        task({
          lifecycle: 'archived',
          shelvedAt: 1,
          tabs: [
            {
              root: 'task:t1/tab-2',
              tree: { kind: 'leaf', pane: { id: 'p-1', cwd: '/w' } },
              focusedPane: 'p-1',
              panes: [{ pane: 'p-1', cwd: '/w', userTitle: null, history: 't1/r/p-1.term' }],
            },
          ],
        }),
      ],
    }));

    await h.run('tasks.reveal', { task: 't1' });

    expect(h.exec).toHaveLength(0);
    const opened = h.invoked.filter((call) => call.id === 'layout.openRoot');
    expect(opened.some((call) => call.args['tree'] !== undefined)).toBe(true);
  });

  it('says the root is archived, and offers the verb that undoes it', async () => {
    const h = (live = harness({ tasks: [task({ lifecycle: 'archived', shelvedAt: 1 })] }));
    await h.run('tasks.reveal', { task: 't1' });

    const said = h.invoked.find((call) => call.id === 'layout.setPlaceholder');
    expect(said?.args['placeholder']).toMatchObject({
      action: { command: 'tasks.restore', label: 'Restore', args: { task: 't1' } },
    });
  });
```

`h.exec` is whatever the harness calls its record of `process.exec` invocations — the existing test at `index.test.ts:602` ("runs NO git at all for an archived task") already asserts this; read it and reuse its exact accessor.

- [ ] **Step 6: Run it to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- index.test.ts`
Expected: FAIL — `reveal` calls `materialize`, so git runs and no `tree` is passed.

- [ ] **Step 7: Rewrite `reveal`'s shelved branch**

In `index.ts`, replace the `if (isShelved(task)) { ... materialize ... }` block (`:2854-2861`) with:

```ts
        /**
         * A shelved task is SHOWN, not put back.
         *
         * Its worktrees are gone and its screens are on disk, so this opens each
         * tab as a root of read-only panes rendering exactly what was there when
         * it was shelved. No git, no directory, no pty — looking at work from
         * three weeks ago used to cost a provision (838 MB on the machine this
         * was measured for) and it now costs a file read per pane.
         *
         * Putting it back is `tasks.restore`, and only that. This used to call
         * `materialize` here, which meant a stray click re-provisioned git for
         * something you only wanted to read.
         */
        if (isShelved(task)) {
          await openSnapshotTabs(task);
        }
```

Add the function beside `rebuildTabs`:

```ts
  /**
   * Every tab of a shelved task, opened as captured screens.
   *
   * The shape comes back too (`snapshotTreeFor`), which the LIVE restore cannot
   * do through `layout.split` — so a snapshot is the more faithful of the two
   * until `rebuildTabs` passes a tree as well.
   *
   * Each root then says what it is, and offers the one verb that ends the state.
   * The label and the command id travel with it because the shell cannot know
   * either (ADR 0031).
   */
  async function openSnapshotTabs(task: TaskRecord): Promise<void> {
    const group = taskRootId(task.id);
    for (const tab of task.tabs ?? []) {
      const tree = snapshotTreeFor(tab, archiveDir());
      const first = tab.panes[0];
      const opened = await commands.invoke('layout.openRoot', {
        root: tab.root,
        group,
        ...(tree === undefined ? {} : { tree }),
        // Only when there is no tree to shape it: a flat fallback still must not
        // start a shell, so the single pane it mints is read-only too.
        ...(tree !== undefined
          ? {}
          : {
              ...(first?.cwd === undefined || first.cwd === null ? {} : { cwd: first.cwd }),
              ...(first?.userTitle === undefined || first.userTitle === null
                ? {}
                : { title: first.userTitle }),
            }),
      });
      if (!opened.ok) {
        ctx.log.warn(
          `task ${task.id}: tab ${tab.root} was not shown — ${opened.error.code}: ${opened.error.message}`,
        );
        continue;
      }
      const said = await commands.invoke('layout.setPlaceholder', {
        root: tab.root,
        placeholder: {
          line: 'Archived — this is what was on screen when the task was shelved.',
          action: { command: TASK_COMMANDS.restore, label: 'Restore', args: { task: task.id } },
        },
      });
      if (!said.ok) ctx.log.warn(`task ${task.id}: tab ${tab.root} has no banner`);
    }
    ctx.log.info(`task ${task.id}: showed ${(task.tabs ?? []).length} archived tab(s)`);
  }
```

Import `snapshotTreeFor` from `./model/archive-tabs.ts` alongside `archiveTabsFrom` and `historyPath`.

The tab with no `tree` mints an ordinary writable pane through `openRoot`'s single-pane path, which would start a shell — so also pass `readOnly: true` there. That needs `layout.openRoot` to accept it: add `readOnly: s.optional(s.boolean())` and `snapshotFile: s.optional(s.string())` to the `openRoot` schema in `commands.ts` and thread them into the `init` object beside `cwd`. Do this as part of this step and note it in the commit.

Also set the anchor root's placeholder: the `layout.openRoot` for `taskRootId(task.id)` further down in `reveal` (`:2883`) opens a plain shell at the task root for a task with no tabs. Guard it — a shelved task must not get one:

```ts
        const placeholder = placeholderFor(task);
        const shelvedWithNoTabs = isShelved(task) && (task.tabs ?? []).length === 0;
        const opened = await commands.invoke<{ created: boolean; pane: string | null }>('layout.openRoot', {
          root,
          cwd: rootOf(task),
          title: task.title,
          ...(shelvedWithNoTabs
            ? {
                empty: true,
                placeholder: {
                  line: 'Archived — no screens were captured for this task.',
                  action: { command: TASK_COMMANDS.restore, label: 'Restore', args: { task: task.id } },
                },
              }
            : placeholder === undefined
              ? {}
              : { empty: true, placeholder }),
        });
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test`
Expected: PASS. Existing tests that assert `reveal` materializes a shelved task will now fail — read each one and decide: a test asserting the OLD contract gets rewritten to assert the new one, and its comment updated to say why. Do not delete a test to make the suite green.

- [ ] **Step 9: Full check and commit**

```bash
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
git add v2/extensions/tasks/src/ v2/packages/core/src/layout/commands.ts
git commit -m "tasks: revealing a shelved task shows its captured screens, and provisions nothing"
```

---

### Task 8: Restore is the one verb that puts it back

**Files:**
- Modify: `v2/extensions/tasks/src/index.ts:3005-3031` (`tasks.restore`), `:1741-1800` (`rebuildTabs`), `:3656-3728` (the row's actions)
- Test: `v2/extensions/tasks/src/index.test.ts`

**Interfaces:**
- Consumes: Task 7's `openSnapshotTabs`; Task 2's `tree` argument.
- Produces: `tasks.restore` closes the task's snapshot roots, materializes, and flips lifecycle only when it was `archived`.

- [ ] **Step 1: Write the failing test**

```ts
  it('restores a shelved-but-active task without touching its lifecycle', async () => {
    const h = (live = harness({
      tasks: [task({ lifecycle: 'running', shelvedAt: 1, archives: [{ repo: 'shepherd' }] })],
    }));

    await h.run('tasks.restore', { task: 't1' });
    await h.settle();

    expect(h.store.get('t1')?.lifecycle).toBe('running');
    expect(h.store.get('t1')?.activatedAt).toBeUndefined();
    expect(h.exec.length).toBeGreaterThan(0);
  });

  it('un-ships a shipped task and dates it, so it lands at the bottom of the active list', async () => {
    const h = (live = harness({ tasks: [task({ lifecycle: 'archived', shelvedAt: 1 })] }));
    await h.run('tasks.restore', { task: 't1' });
    expect(h.store.get('t1')?.lifecycle).toBe('running');
    expect(h.store.get('t1')?.activatedAt).toBeDefined();
  });

  it('closes the snapshot roots before rebuilding, so a tab is not shown twice', async () => {
    const h = (live = harness({
      tasks: [
        task({
          lifecycle: 'archived',
          shelvedAt: 1,
          tabs: [{ root: 'task:t1/tab-2', focusedPane: 'p-1', panes: [{ pane: 'p-1', cwd: '/w', userTitle: null }] }],
        }),
      ],
    }));

    await h.run('tasks.reveal', { task: 't1' });
    await h.run('tasks.restore', { task: 't1' });
    await h.settle();

    const closed = h.invoked.filter((call) => call.id === 'layout.closeRoot');
    expect(closed.some((call) => call.args['root'] === 'task:t1/tab-2')).toBe(true);
  });

  it('rebuilds a restored tab with the shape it was archived with', async () => {
    const h = (live = harness({
      tasks: [
        task({
          lifecycle: 'archived',
          shelvedAt: 1,
          tabs: [
            {
              root: 'task:t1/tab-2',
              tree: {
                kind: 'split',
                axis: 'row',
                ratio: 0.3,
                first: { kind: 'leaf', pane: { id: 'p-1', cwd: '/w/a' } },
                second: { kind: 'leaf', pane: { id: 'p-2', cwd: '/w/b' } },
              },
              focusedPane: 'p-1',
              panes: [
                { pane: 'p-1', cwd: '/w/a', userTitle: null },
                { pane: 'p-2', cwd: '/w/b', userTitle: null },
              ],
            },
          ],
        }),
      ],
    }));

    await h.run('tasks.restore', { task: 't1' });
    await h.settle();

    const opened = h.invoked.find(
      (call) => call.id === 'layout.openRoot' && call.args['root'] === 'task:t1/tab-2',
    );
    expect(opened?.args['tree']).toMatchObject({ kind: 'split', ratio: 0.3 });
    // The flat fallback is gone for a tab that carried a shape.
    expect(h.invoked.filter((call) => call.id === 'layout.split')).toHaveLength(0);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- index.test.ts`
Expected: FAIL — `restore` flips lifecycle unconditionally, closes nothing, and `rebuildTabs` splits flat.

- [ ] **Step 3: Rewrite `tasks.restore`**

```ts
      /**
       * Put the work back — disk, git, panes and agents' resume lines.
       *
       * The ONLY thing that materializes a task now. `tasks.reveal` used to do
       * it as a side effect of being clicked, which meant reading three-week-old
       * work re-provisioned git for it; the two are separate, and this is the
       * half that costs something.
       *
       * The lifecycle flip is conditional, and that is the difference between
       * the two shelved states: a SHIPPED task is being un-shipped, so it goes
       * back to `running` and is dated to land at the bottom of the active list.
       * A task that was merely shelved (its panes were closed) never left the
       * active list, and dating it would shuffle a row for a reason the user did
       * not give.
       *
       * Optimistic: the record flips first so the row moves immediately, and the
       * git work follows behind a `busy` mark.
       */
      handler: (args) => {
        const task = store.get(args.task);
        if (task === undefined) throw new Error(`no task ${args.task}`);
        const shipped = task.lifecycle === 'archived';
        if (shipped) {
          store.put({ ...task, lifecycle: 'running', activatedAt: ctx.clock.now() });
          changed();
        }
        void whileBusy(task.id, 'restoring', async () => {
          // The snapshot roots go FIRST. They hold this task's tab ids, and
          // `layout.openRoot` is idempotent — rebuilding into them would find a
          // root that already has panes and hand back the read-only ones,
          // leaving the restore with nothing on screen and no error anywhere.
          await closeSnapshotTabs(task);
          await materialize(task);
        }).catch((error: unknown) => {
          ctx.log.error(`task ${task.id}: restoring threw — ${String(error)}`);
        });
        return { id: task.id, lifecycle: shipped ? 'running' : task.lifecycle };
      },
```

Add beside `openSnapshotTabs`:

```ts
  /** Drop this task's read-only roots. Nothing to drain: they hold no sessions. */
  async function closeSnapshotTabs(task: TaskRecord): Promise<void> {
    for (const tab of task.tabs ?? []) {
      const closed = await commands.invoke('layout.closeRoot', { root: tab.root });
      if (!closed.ok) {
        ctx.log.warn(`task ${task.id}: snapshot tab ${tab.root} did not close — ${closed.error.message}`);
      }
    }
  }
```

- [ ] **Step 4: Pass the shape through `rebuildTabs`**

In `rebuildTabs`, add the tree to the `layout.openRoot` call and skip the per-pane split loop when the shape came back. Replace the loop body's opening (`:1749-1770`) with:

```ts
      const first = tab.panes[0];
      const seed = readHistory(tab.panes[0]?.history);
      const staged = await stagedResumeLine(task, first);
      // The archived shape, with none of the snapshot marking: these panes are
      // about to be REAL. `snapshotTreeFor` is the read-only variant of the same
      // rewrite, and the two must not be confused — one starts nothing, this one
      // starts everything.
      const tree = liveTreeFor(tab);

      const opened = await commands.invoke('layout.openRoot', {
        root: tab.root,
        group,
        ...(tree === undefined ? {} : { tree }),
        ...(first?.cwd === undefined || first.cwd === null ? {} : { cwd: first.cwd }),
        ...(first?.userTitle === undefined || first.userTitle === null ? {} : { title: first.userTitle }),
        // A shaped open mints several panes at once, so there is no "the" pane
        // for `openRoot`'s own seed to land on — every pane of a shaped tab is
        // seeded by id below instead. The flat path keeps using it.
        ...(tree !== undefined || seed === undefined ? {} : { seed }),
        ...(tree !== undefined || staged === undefined ? {} : { initialCommand: staged }),
      });
```

Then guard the split loop. Replace the whole `for (const pane of tab.panes.slice(1))` block (`:1783-1797`) with:

```ts
      /*
       * A tab that carried a SHAPE is already whole: `layout.openRoot` built
       * every pane, so all that is left is to give each one its screen and its
       * staged line, by id.
       *
       * The flat loop below it is what happens for a tab archived before trees
       * were stored — and it is the branch the comment that used to sit here was
       * about: `layout.split` takes an axis and no path, so a tree of ratios
       * could not be reproduced through it, and a restore that silently produced
       * a different arrangement would be worse than one that is honestly flat.
       */
      if (tree !== undefined) {
        for (const pane of tab.panes) {
          const paneSeed = readHistory(pane.history);
          const paneStaged = await stagedResumeLine(task, pane);
          if (paneSeed === undefined && paneStaged === undefined) continue;
          const seeded = await commands.invoke('layout.seedPane', {
            pane: pane.pane,
            ...(paneSeed === undefined ? {} : { seed: paneSeed }),
            ...(paneStaged === undefined ? {} : { initialCommand: paneStaged }),
          });
          if (!seeded.ok) {
            ctx.log.warn(
              `task ${task.id}: pane ${pane.pane} of ${tab.root} came back without its screen — ${seeded.error.message}`,
            );
          }
        }
        continue;
      }

      for (const pane of tab.panes.slice(1)) {
        const paneSeed = readHistory(pane.history);
        const paneStaged = await stagedResumeLine(task, pane);
        const split = await commands.invoke('layout.split', {
          axis: 'row',
          root: tab.root,
          ...(pane.cwd === null ? {} : { cwd: pane.cwd }),
          ...(paneSeed === undefined ? {} : { seed: paneSeed }),
          ...(paneStaged === undefined ? {} : { initialCommand: paneStaged }),
        });
        if (!split.ok) {
          ctx.log.warn(
            `task ${task.id}: a pane of ${tab.root} was not restored — ${split.error.code}: ${split.error.message}`,
          );
        }
      }
```

Seeding a pane by id works because `liveTreeFor` keeps the archived pane ids and `deserializeNode` honours them (ADR 0036) — the id in `ArchivedPane.pane` and the id the restored leaf carries are the same string.

`seedPane` needs a way to stage a seed and an initial command against a NAMED pane rather than the focused one. `layout.split`'s `stageSeed` uses `store.focused(root)`. Add a `pane: s.optional(s.string())` argument to `layout.setPlaceholder`'s neighbour — specifically, extend `stageSeed` in `commands.ts` to take an explicit pane, and add a small `layout.seedPane` command:

```ts
    registry.register(LAYOUT_COMMANDS.seedPane, {
      permission: 'layout',
      schema: s.object({
        pane: s.string(),
        seed: s.optional(s.string()),
        initialCommand: s.optional(s.string()),
      }),
      /**
       * Hand a pane that ALREADY EXISTS the screen and the line it should be
       * born with — the shaped-restore counterpart of `openRoot`'s `seed`.
       *
       * `openRoot` can seed one pane, the focused one, because that is the pane
       * it just minted. A tree-shaped open mints several at once, and there is no
       * moment at which each is "the" focused pane. Both stagings are still
       * one-shot at the store (`takeInitialSeed` / `takeInitialInput`), so this
       * adds a caller, not a second mechanism.
       */
      handler: (args) => {
        const pane = toPaneId(args.pane);
        if (args.seed !== undefined && args.seed !== '') {
          store.setInitialSeed(pane, new Uint8Array(Buffer.from(args.seed, 'base64')));
        }
        if (args.initialCommand !== undefined && args.initialCommand !== '') {
          store.setInitialInput(pane, args.initialCommand);
        }
        return { pane: args.pane };
      },
    }),
```

Add `seedPane: 'layout.seedPane'` to `LAYOUT_COMMANDS`. In `tasks`, `seedPane` is then a thin `commands.invoke('layout.seedPane', { pane, seed, initialCommand })`, and the FIRST pane of a shaped tab is seeded the same way rather than through `openRoot`'s `seed` — drop `seed`/`initialCommand` from the shaped `openRoot` call and seed every pane uniformly.

Refactor `model/archive-tabs.ts` so the two rewrites share one walk, and add `liveTreeFor`. Replace the body of `snapshotTreeFor` (written in Task 7) with a call into the shared walk, and add both alongside it:

```ts
/**
 * The tab's stored shape, with each leaf's pane put through `onPane`.
 *
 * One walk for both rewrites, because they differ by four lines and a second
 * copy is a second thing to keep in step with `serialize.ts`'s format. The
 * format itself is never interpreted beyond `kind` / `first` / `second`: this
 * carries `axis` and `ratio` across untouched, exactly as `ArchivedTab.tree`
 * promises to.
 *
 * `undefined` for a tree that cannot be walked, never a half-rewritten one — a
 * caller that got half a shape would open a tab missing panes with nothing
 * saying why.
 */
function rewriteTree(
  tree: unknown,
  onPane: (pane: Record<string, unknown>, id: string | undefined) => Record<string, unknown>,
): unknown | undefined {
  const walk = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null) throw new Error('not a node');
    const node = value as Record<string, unknown>;
    if (node['kind'] === 'leaf') {
      const pane = (node['pane'] ?? {}) as Record<string, unknown>;
      const id = typeof pane['id'] === 'string' ? pane['id'] : undefined;
      return { kind: 'leaf', pane: onPane(pane, id) };
    }
    if (node['kind'] === 'split') {
      return {
        kind: 'split',
        axis: node['axis'],
        ratio: node['ratio'],
        first: walk(node['first']),
        second: walk(node['second']),
      };
    }
    throw new Error('not a node');
  };
  try {
    return walk(tree);
  } catch {
    return undefined;
  }
}

/** A pane id and a session id are two different claims; only the first survives. */
function withoutSession(pane: Record<string, unknown>): Record<string, unknown> {
  const { sessionId: _dropped, ...rest } = pane;
  return rest;
}

export function snapshotTreeFor(tab: ArchivedTab, archiveDir: string): unknown | undefined {
  if (tab.tree === undefined || tab.tree === null) return undefined;
  const historyOf = new Map(tab.panes.map((pane) => [pane.pane, pane.history]));
  return rewriteTree(tab.tree, (pane, id) => {
    const history = id === undefined ? undefined : historyOf.get(id);
    return {
      ...withoutSession(pane),
      readOnly: true,
      ...(history === undefined ? {} : { snapshotFile: `${archiveDir}/${history}` }),
    };
  });
}

/**
 * The tab's stored shape for a LIVE restore: geometry and cwds, nothing else.
 *
 * `sessionId` is dropped for the same reason `snapshotTreeFor` drops it — the
 * session it names died when the task was shelved, and a claim the layout tries
 * to reattach to a dead id is the stale binding ADR 0036 verifies against.
 * Screens and resume lines are staged per pane afterwards, not carried here.
 */
export function liveTreeFor(tab: ArchivedTab): unknown | undefined {
  if (tab.tree === undefined || tab.tree === null) return undefined;
  return rewriteTree(tab.tree, (pane) => withoutSession(pane));
}
```

Task 7's tests for `snapshotTreeFor` must still pass unchanged after this refactor — that is what says the two share a walk without either changing behaviour. Add one for the new export:

```ts
  it('liveTreeFor keeps the geometry and marks nothing read-only', () => {
    expect(liveTreeFor(tab)).toEqual({
      kind: 'split',
      axis: 'row',
      ratio: 0.4,
      first: { kind: 'leaf', pane: { id: 'p-1', cwd: '/w/a' } },
      second: { kind: 'leaf', pane: { id: 'p-2', cwd: '/w/b' } },
    });
  });
```

- [ ] **Step 5: Add the sidebar verb for a shelved-but-active row**

In the row's `actions` array (`:3701`), add a Restore entry for a task that is shelved but not shipped, before the Ship/Unship pair:

```ts
                /*
                 * An ACTIVE task whose work is on the shelf has one verb the
                 * others do not: put it back. Its `primaryAction` is still Ship
                 * — that is the gesture made most on a row you have stopped
                 * looking at — so this lives in the menu, where the shipped
                 * row's own Unship button already points at the same command.
                 */
                ...(!shipped && isShelved(task)
                  ? [
                      {
                        id: TASK_COMMANDS.restore,
                        label: 'Restore work',
                        icon: 'unship',
                        args: { task: task.id },
                      },
                      { separator: true } as const,
                    ]
                  : []),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test`
Expected: PASS

- [ ] **Step 7: Full check and commit**

```bash
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
git add v2/extensions/tasks/src/ v2/packages/core/src/layout/commands.ts
git commit -m "tasks: restore is the one verb that materializes, and it rebuilds the shape"
```

---

### Task 9: The gate, and the decisions

**Files:**
- Modify: `v2/packages/app/src/main/smoke-m3.ts:274-310`
- Create: `.claude/adr/0042-v2-a-pane-may-have-no-session.md`
- Create: `.claude/adr/0043-v2-a-placeholder-may-cover-a-root-of-captured-screens.md`
- Modify: `CLAUDE.md` (the v2 ADR paragraph)

**Interfaces:**
- Consumes: everything above.
- Produces: a green `pnpm smoke:m3` that proves the two claims this change is for.

- [ ] **Step 1: Extend the smoke**

The smoke already archives a task and asserts a pane kept its screen (`smoke-m3.ts:274-310`). After that assertion, add:

```ts
  /*
   * The whole point, asserted through the real app: looking at shelved work
   * costs nothing.
   *
   * Both halves are needed. "No new session" alone would pass if the tabs never
   * opened; "the tab is on screen" alone would pass if it opened live. A unit
   * test cannot reach this — it supplies both sides of the correlation, which is
   * exactly how the archive-on-close bug shipped green.
   */
  const before = (await invoke('sessions.list', {})).value.length;
  const worktree = `${taskRoot}/shepherd`;
  await invoke('tasks.reveal', { task: taskId });
  await settle();

  assert.equal(
    (await invoke('sessions.list', {})).value.length,
    before,
    'revealing a shelved task must create no session',
  );
  assert.equal(existsSync(worktree), false, 'revealing a shelved task must not put its worktree back');
  assert.ok(
    (await readPaneAttribute('data-readonly')) === 'true',
    'the revealed tab must be drawn as a read-only pane',
  );

  await invoke('tasks.restore', { task: taskId });
  await settle();

  assert.ok(existsSync(worktree), 'restoring must put the worktree back');
  assert.ok(
    (await invoke('sessions.list', {})).value.length > before,
    'restoring must bring the panes back live',
  );
```

Match `invoke`, `settle`, `assert` and the DOM-reading helper to the ones `smoke-m3.ts` already uses — it drives the real Electron app over the real bus, and this plan must not invent a second way to talk to it.

- [ ] **Step 2: Run the gate**

Run: `env -u NODE_OPTIONS pnpm smoke:m3`
Expected: PASS. If it fails, the failure is real — this is the test that catches what the unit suite structurally cannot.

- [ ] **Step 3: Write ADR 0042**

Create `.claude/adr/0042-v2-a-pane-may-have-no-session.md`, following the format of the existing ADRs (Status / Date / Context / Decision / Consequences). It must record:

- that `readOnly` + `snapshotFile` persist while `seed` deliberately does not, and why the two are not variants of one thing;
- that the enforcement is `wantSession` in the renderer's `#sync`, not a branch in the store's restore path — a persisted pane with no session was already handled correctly there;
- that the kernel takes a file path and never learns the word "archive", so a second producer of captured screens needs nothing new;
- that the bytes travel on their own IPC rather than in the layout envelope, and the per-push cost that would be.

- [ ] **Step 4: Write ADR 0043**

Create `.claude/adr/0043-v2-a-placeholder-may-cover-a-root-of-captured-screens.md`. It must record:

- the original guard and its named reason (`Creating the worktree` drawn over a running agent);
- why that reason cannot reach a root whose every pane is read-only, and so why the guard narrows to "no LIVE pane" rather than being removed;
- that the banner's label and command id come from the extension, per ADR 0031.

- [ ] **Step 5: Update `CLAUDE.md`**

Add 0042 and 0043 to the ADR paragraph in the v2 section, in the style of the entries around them — a sentence saying what each is FOR, not a restatement of the title. Also correct the sentence in the v2 intro that says clicking a task "restores the worktrees and reattaches its agents": that is now what Restore does, and clicking shows a snapshot.

- [ ] **Step 6: Full check and commit**

```bash
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
cd v2 && env -u NODE_OPTIONS pnpm smoke:m3
git add .claude/adr/ CLAUDE.md v2/packages/app/src/main/smoke-m3.ts
git commit -m "Record why a pane may have no session, and gate it in the smoke"
```

---

## Verification

Before calling this done, all four must have been run and seen to pass:

```sh
cd v2
env -u NODE_OPTIONS pnpm typecheck
env -u NODE_OPTIONS pnpm lint
env -u NODE_OPTIONS pnpm test
env -u NODE_OPTIONS pnpm smoke:m3
```

Then drive it by hand under `pnpm ship --dev`: create a task, let it provision, close its panes (which shelves it), click the row — the tabs come back as screens with a banner, `du -sh` on the task root shows nothing there — then press Restore and watch the worktrees and panes return.
