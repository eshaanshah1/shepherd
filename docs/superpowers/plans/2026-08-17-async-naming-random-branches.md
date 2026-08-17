# Async naming & random branches — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task's folder and branch are minted at once from a random
`<colour>-<breed>` pair so nothing waits for a model, and the model's name — when
it arrives — replaces only the tab and row label.

**Architecture:** `tasks.create` stops awaiting the naming call. The slug is
minted, the record is written, provisioning starts immediately. A background
`nameLater` asks the model and writes `title` alone, then relabels live panes. The
branch is chosen from the same minted name, checked against every repo's already
prefetched refs so a random name cannot silently adopt a deleted task's branch.
Nothing stores a branch: git is asked, and a new `shepherd task rename-branch`
verb is the easy door for an agent that wants a better one.

**Tech Stack:** TypeScript, Node, Electron, vitest, pnpm workspaces. Extension
code in `v2/extensions/tasks` (`src/` = service, `ui/` = React page, with a lint
boundary between them).

**Spec:** [`docs/superpowers/specs/2026-08-17-async-naming-random-branches-design.md`](../specs/2026-08-17-async-naming-random-branches-design.md)

## Global Constraints

- **`env -u NODE_OPTIONS` on every command.** An ambient `NODE_OPTIONS` makes
  Electron exit 9 before running a line of our code.
- **Run tests from the package**: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run <file>`.
- **Gates**: `cd v2 && env -u NODE_OPTIONS pnpm typecheck`, `pnpm lint`, `pnpm test`.
- **`v2/tooling/eslint/boundaries.js` is the architecture.** `design-tokens`
  imports nothing; `ui` imports `design-tokens`; `app` imports both; extensions
  import `sdk` and `ui`. An extension's `ui/` may import types from its `src/`,
  not the reverse. If a change needs a new edge in that graph, the change is wrong.
- **Every colour and length is a token.** A hex literal outside
  `packages/design-tokens` is a defect.
- **Copy rules (§6)**: sentence case, no emoji, a label is 1–3 words, neutral
  verbs while in flight.
- **`noUncheckedIndexedAccess` is on.** `list[i]` is `T | undefined`; index reads
  need a fallback or a non-empty tuple type.
- **Comment style**: state the WHY when it is non-obvious; never narrate the diff
  or recap the bug history.
- **A gate that passes with the change reverted is not a gate.** Run each new
  test against unmodified code first and see it fail for the stated reason.

---

### Task 1: `mintName` — a colour and a sheep breed

**Files:**
- Create: `v2/extensions/tasks/src/model/mint.ts`
- Create: `v2/extensions/tasks/src/model/mint.test.ts`
- Modify: `v2/extensions/tasks/src/model/index.ts` (add the export)

**Interfaces:**
- Consumes: nothing.
- Produces: `mintName(random: () => number): string` — a lowercase
  `<colour>-<breed>` pair, already slug-safe and already a legal git branch.

- [ ] **Step 1: Write the failing test**

`v2/extensions/tasks/src/model/mint.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mintName } from './mint.ts';
import { slugify } from './slug.ts';

/** A `random` that walks a fixed sequence, so a name is a value a test can name. */
function sequence(values: readonly number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length] ?? 0;
}

describe('mintName', () => {
  it('is a colour and a breed, joined by one hyphen', () => {
    const name = mintName(sequence([0, 0]));
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('is reproducible from its randomness, so a test can assert on one', () => {
    expect(mintName(sequence([0, 0]))).toBe(mintName(sequence([0, 0])));
  });

  it('walks both lists, so the pair is not one name repeated', () => {
    const first = mintName(sequence([0, 0]));
    const later = mintName(sequence([0.5, 0.5]));
    expect(first).not.toBe(later);
  });

  // It becomes a directory and a branch, so `slugify` must have nothing to fix.
  it('survives slugify unchanged', () => {
    for (let n = 0; n < 200; n += 1) {
      const name = mintName(Math.random);
      expect(slugify(name)).toBe(name);
    }
  });

  // A `random` answering exactly 1 indexes one past the end of the list.
  it('answers a name when random returns its upper bound', () => {
    expect(mintName(() => 1)).toMatch(/^[a-z]+-[a-z]+$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run src/model/mint.test.ts`
Expected: FAIL — `Failed to load .../model/mint.ts`

- [ ] **Step 3: Write minimal implementation**

`v2/extensions/tasks/src/model/mint.ts`:

```ts
/**
 * A task's first name — minted rather than derived.
 *
 * It becomes the folder and the branch the moment a task is created, before
 * anything knows what the task is about, so it cannot come from the brief and it
 * must not wait for a model. What it has to be is short, unambiguous when spoken
 * ("the merino one"), and already legal as both a directory and a git ref —
 * which is why both lists are lowercase ASCII with no separators of their own.
 *
 * `random` is a parameter for the reason `ctx.clock` is: a name nobody can
 * predict is a name no test can assert on.
 */

/** Non-empty tuples, so an index-zero fallback is a `string` and not a maybe. */
const COLOURS: readonly [string, ...string[]] = [
  'amber', 'ash', 'auburn', 'azure', 'bramble', 'brass', 'bronze', 'chalk',
  'cinder', 'clay', 'cobalt', 'copper', 'coral', 'cream', 'dusk', 'ember',
  'fawn', 'flint', 'frost', 'garnet', 'hazel', 'indigo', 'ivory', 'jade',
  'lilac', 'linen', 'mauve', 'moss', 'ochre', 'olive', 'onyx', 'pearl',
  'rowan', 'russet', 'saffron', 'sable', 'sage', 'sandy', 'slate', 'sorrel',
  'teal', 'umber', 'verdant', 'wheat',
];

const BREEDS: readonly [string, ...string[]] = [
  'awassi', 'balwen', 'beulah', 'bluefaced', 'boreray', 'cheviot', 'clun',
  'colbred', 'columbia', 'coopworth', 'corriedale', 'cotswold', 'debouillet',
  'dorper', 'dorset', 'exmoor', 'gotland', 'gulf', 'hampshire', 'herdwick',
  'icelandic', 'jacob', 'karakul', 'katahdin', 'lacaune', 'leicester',
  'lincoln', 'lonk', 'manx', 'merino', 'navajo', 'norfolk', 'oxford',
  'perendale', 'polwarth', 'portland', 'rambouillet', 'romney', 'romanov',
  'ryeland', 'shetland', 'shropshire', 'soay', 'southdown', 'suffolk',
  'targhee', 'teeswater', 'texel', 'tunis', 'wensleydale',
];

/**
 * The fallback is not defensive noise: a `random` that answers exactly 1 — or a
 * caller's sequence that runs past its own end — indexes one past the list.
 */
function pick(list: readonly [string, ...string[]], random: () => number): string {
  return list[Math.floor(random() * list.length)] ?? list[0];
}

export function mintName(random: () => number): string {
  return `${pick(COLOURS, random)}-${pick(BREEDS, random)}`;
}
```

Add to `v2/extensions/tasks/src/model/index.ts`, beside the `slug` export:

```ts
export { mintName } from './mint.ts';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run src/model/mint.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/tasks/src/model/mint.ts v2/extensions/tasks/src/model/mint.test.ts v2/extensions/tasks/src/model/index.ts
git commit -m "A task's first name is a colour and a sheep breed"
```

---

### Task 2: `pickBranch` — a minted name that is free in every repo

**Files:**
- Modify: `v2/extensions/tasks/src/model/mint.ts`
- Modify: `v2/extensions/tasks/src/model/mint.test.ts`
- Modify: `v2/extensions/tasks/src/model/index.ts`

**Interfaces:**
- Consumes: `mintName` (Task 1); `RepoRefs` from `./branch.ts` —
  `{ localBranches, remoteBranches, checkedOutBranches, defaultBase }`.
- Produces:
  - `branchTaken(name: string, refs: readonly RepoRefs[]): boolean`
  - `pickBranch(first: string, refs: readonly RepoRefs[], mint: () => string, attempts?: number): string`

**Why this exists:** `resolveBranch` treats an existing local branch as *check it
out*. That is right when the name came from the work and wrong when it was drawn
from a hat — a task would silently adopt a deleted task's commits, and the first
symptom would be a diff nobody wrote.

- [ ] **Step 1: Write the failing test**

Append to `v2/extensions/tasks/src/model/mint.test.ts`:

```ts
import { branchTaken, pickBranch } from './mint.ts';
import type { RepoRefs } from './branch.ts';

const refs = (over: Partial<RepoRefs> = {}): RepoRefs => ({
  localBranches: [],
  remoteBranches: [],
  checkedOutBranches: [],
  defaultBase: undefined,
  ...over,
});

describe('branchTaken', () => {
  it('sees a local branch', () => {
    expect(branchTaken('slate-merino', [refs({ localBranches: ['slate-merino'] })])).toBe(true);
  });

  // Matched by suffix and exactly, the way resolveBranch matches it — so any
  // remote counts and `merino` does not match `origin/slate-merino`.
  it('sees a branch that exists only on a remote, under any remote name', () => {
    expect(branchTaken('slate-merino', [refs({ remoteBranches: ['upstream/slate-merino'] })])).toBe(true);
    expect(branchTaken('merino', [refs({ remoteBranches: ['origin/slate-merino'] })])).toBe(false);
  });

  it('sees a branch another worktree already holds', () => {
    expect(branchTaken('slate-merino', [refs({ checkedOutBranches: ['slate-merino'] })])).toBe(true);
  });

  it('is taken if ANY repo of the task has it', () => {
    expect(branchTaken('slate-merino', [refs(), refs({ localBranches: ['slate-merino'] })])).toBe(true);
  });

  it('is free when nothing has it', () => {
    expect(branchTaken('slate-merino', [refs(), refs()])).toBe(false);
  });
});

describe('pickBranch', () => {
  it('keeps the minted name when it is free everywhere', () => {
    expect(pickBranch('slate-merino', [refs()], () => 'never-called')).toBe('slate-merino');
  });

  it('re-mints when the name is taken in one of the repos', () => {
    const free = pickBranch('slate-merino', [refs(), refs({ localBranches: ['slate-merino'] })], () => 'amber-soay');
    expect(free).toBe('amber-soay');
  });

  it('keeps re-minting until one is free', () => {
    const names = ['ash-jacob', 'amber-soay'];
    let n = 0;
    const taken = refs({ localBranches: ['slate-merino', 'ash-jacob'] });
    expect(pickBranch('slate-merino', [taken], () => names[n++] ?? 'ash-jacob')).toBe('amber-soay');
  });

  // A bound rather than a loop: the failure this guards is not "unlucky", it is
  // "this repo has 1,300 branches", and a loop there does not terminate.
  it('falls back to a numbered suffix when every attempt collides', () => {
    const taken = refs({ localBranches: ['slate-merino', 'ash-jacob', 'ash-jacob-2'] });
    expect(pickBranch('slate-merino', [taken], () => 'ash-jacob', 2)).toBe('ash-jacob-3');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run src/model/mint.test.ts`
Expected: FAIL — `branchTaken is not exported by ./mint.ts`

- [ ] **Step 3: Write minimal implementation**

Append to `v2/extensions/tasks/src/model/mint.ts`:

```ts
import type { RepoRefs } from './branch.ts';

/**
 * Would `resolveBranch` find this name already there?
 *
 * The three questions it asks, in its own order and with its own suffix match,
 * so a name this says is free is one `resolveBranch` will create rather than
 * check out. A second spelling of that rule would be a second answer.
 */
export function branchTaken(name: string, refs: readonly RepoRefs[]): boolean {
  return refs.some(
    (repo) =>
      repo.localBranches.includes(name) ||
      repo.checkedOutBranches.includes(name) ||
      repo.remoteBranches.some((ref) => ref.endsWith(`/${name}`)),
  );
}

/** How many fresh names to try before giving up on randomness. */
const MINT_ATTEMPTS = 5;

/**
 * A branch name free in EVERY repo of the task.
 *
 * Across all of them together rather than per repo, because one task keeps one
 * branch name: `taskProvisioned` publishes a single `branch` for the whole task,
 * and a per-repo answer would make that fact a lie.
 */
export function pickBranch(
  first: string,
  refs: readonly RepoRefs[],
  mint: () => string,
  attempts = MINT_ATTEMPTS,
): string {
  let candidate = first;
  for (let n = 0; n <= attempts; n += 1) {
    if (!branchTaken(candidate, refs)) return candidate;
    candidate = mint();
  }
  // Randomness is out of ideas, so fall back to the rule `uniqueSlug` uses on a
  // folder. It terminates: a repo holds finitely many refs.
  for (let n = 2; ; n += 1) {
    const suffixed = `${candidate}-${n}`;
    if (!branchTaken(suffixed, refs)) return suffixed;
  }
}
```

Add to `v2/extensions/tasks/src/model/index.ts`:

```ts
export { mintName, branchTaken, pickBranch } from './mint.ts';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run src/model/mint.test.ts`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/tasks/src/model/mint.ts v2/extensions/tasks/src/model/mint.test.ts v2/extensions/tasks/src/model/index.ts
git commit -m "A minted branch is checked against every repo before it is used"
```

---

### Task 3: `firstLine` — the brief, as a label

**Files:**
- Modify: `v2/extensions/tasks/src/model/naming.ts`
- Modify: `v2/extensions/tasks/src/model/naming.test.ts`
- Modify: `v2/extensions/tasks/src/model/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `firstLine(brief: string): string` — the brief's first line, trimmed,
  capped at 72 characters with a trailing `…`.

This is `ui/composer.tsx`'s `titleOf` moved into the extension, so the CLI's
`--brief` gets the same treatment the field does. The composer's copy is deleted
in Task 6.

- [ ] **Step 1: Write the failing test**

Append to `v2/extensions/tasks/src/model/naming.test.ts`:

```ts
import { firstLine } from './naming.ts';

describe('firstLine', () => {
  it('is the first line, trimmed', () => {
    expect(firstLine('  fix the login redirect  \nand then some more')).toBe('fix the login redirect');
  });

  it('is empty for an empty brief', () => {
    expect(firstLine('   ')).toBe('');
  });

  // It becomes a tab title. Somebody's first line is occasionally a paragraph.
  it('caps a long line and marks the cut', () => {
    const long = 'a'.repeat(200);
    const capped = firstLine(long);
    expect(capped).toHaveLength(72);
    expect(capped.endsWith('…')).toBe(true);
  });

  it('leaves a line of exactly the cap alone', () => {
    const exact = 'b'.repeat(72);
    expect(firstLine(exact)).toBe(exact);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run src/model/naming.test.ts`
Expected: FAIL — `firstLine is not exported by ./naming.ts`

- [ ] **Step 3: Write minimal implementation**

Add to `v2/extensions/tasks/src/model/naming.ts`:

```ts
/** A tab is one line wide, and somebody's first line is occasionally a paragraph. */
const MAX_TITLE_CHARS = 72;

/**
 * What a task is called before anything has named it: its own brief, first line.
 *
 * Shown rather than cleaned up. An earlier version ran a filler strip over this
 * and produced something that read like a name somebody chose and got wrong; a
 * brief shown as a brief is unfinished, which is what it is.
 */
export function firstLine(brief: string): string {
  const first = brief.split('\n')[0]?.trim() ?? '';
  return first.length <= MAX_TITLE_CHARS
    ? first
    : `${first.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
}
```

Add to `v2/extensions/tasks/src/model/index.ts` (the `naming` exports live beside
`slug`'s; add the line):

```ts
export { firstLine } from './naming.ts';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run src/model/naming.test.ts`
Expected: PASS — the existing naming tests plus 4

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/tasks/src/model/naming.ts v2/extensions/tasks/src/model/naming.test.ts v2/extensions/tasks/src/model/index.ts
git commit -m "The brief's first line is a label the extension can make"
```

---

### Task 4: `tasks.create` mints, and waits for nothing

**Files:**
- Modify: `v2/extensions/tasks/src/index.ts` — the `tasks.create` handler
  (~2880–3045), `settleName` (2293–2305), `provision`/`runProvision`
  (2329–2390), imports (29–30)
- Modify: `v2/extensions/tasks/src/model/naming.ts` — delete `heuristicName`,
  `FILLER`, `URL_WORD`, `DANGLING`, `MAX_HEURISTIC_WORDS`; rewrite the file header
- Modify: `v2/extensions/tasks/src/model/naming.test.ts` — delete the
  `heuristicName` describe block
- Modify: `v2/extensions/tasks/src/model/index.ts` — drop the `heuristicName` export
  if present
- Modify: `v2/extensions/tasks/src/index.test.ts`

**Interfaces:**
- Consumes: `mintName` (Task 1), `firstLine` (Task 3), `uniqueSlug`, `store.takenSlugs()`.
- Produces: a `TaskRecord` whose `slug` is `<colour>-<breed>` and whose `title` is
  either the caller's explicit one or the brief's first line. `provision(task, images?, opts?)`
  — the third positional `naming` parameter is gone.

- [ ] **Step 1: Write the failing test**

Add to `v2/extensions/tasks/src/index.test.ts`, in the `tasks.create` describe
block (match the file's existing harness for building `ctx`/`api` — copy the
setup from the nearest `tasks.create` test rather than inventing one):

```ts
it('mints a slug that owes nothing to the brief', async () => {
  const created = await invoke('tasks.create', {
    brief: 'fix the login redirect loop that happens after SSO',
    repos: [],
  });
  // Two words, both from the lists, and no word of the brief in it.
  expect(created.slug).toMatch(/^[a-z]+-[a-z]+$/);
  expect(created.slug).not.toContain('login');
});

it('titles a task with its own brief until something better arrives', async () => {
  const created = await invoke('tasks.create', {
    brief: 'fix the login redirect loop\nand the second line is ignored',
    repos: [],
  });
  expect(created.title).toBe('fix the login redirect loop');
});

it('keeps a title the caller chose, and does not ask a model about it', async () => {
  const created = await invoke('tasks.create', {
    title: 'Fix login',
    brief: 'fix the login redirect loop that happens after SSO',
    repos: [],
  });
  expect(created.title).toBe('Fix login');
  expect(namingCalls).toBe(0); // the stub `agents.complete` was never invoked
});

it('answers before the naming call could possibly have finished', async () => {
  // The stub never resolves. Create must still answer.
  hangTheModel();
  const created = await invoke('tasks.create', { brief: 'a'.repeat(40), repos: [] });
  expect(created.slug).toMatch(/^[a-z]+-[a-z]+$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run src/index.test.ts -t 'mints a slug'`
Expected: FAIL — the slug is derived from the brief (`fix-the-login-redirect-loop-…`)

- [ ] **Step 3: Write minimal implementation**

In `v2/extensions/tasks/src/index.ts`:

Imports (line 29–30) become:

```ts
import { slugify, uniqueSlug } from './model/slug.ts';
import { mintName, pickBranch } from './model/mint.ts';
import { firstLine, namingPrompt, readName, stillTheSameBrief } from './model/naming.ts';
```

(`slugify` stays: it still guards a caller-supplied name in Task 9's verb and is
what makes a minted name provably directory-safe.)

Delete `settleName` (2293–2305) entirely, along with the D19/D20 comment block
above it (2271–2292), and replace that block with:

```ts
  /**
   * A task's folder is minted, not named — and then it never moves.
   *
   * The slug is a directory, and after the first `worktree add` changing it would
   * mean `git branch -m`, `git worktree move`, moving the task root,
   * re-synthesizing its CLAUDE.md and symlinks and re-seeding Claude Code's
   * per-path trust, all while an orchestrator boots with a cwd inside the
   * directory being moved. Rather than hold a task still until a name arrives,
   * nothing on disk is named after the task at all.
   */
```

Drop the `naming` parameter from `provision` and `runProvision`:

```ts
  async function provision(
    task: TaskRecord,
    images?: readonly PastedImage[],
    opts?: ProvisionOptions,
  ): Promise<void> {
    return whileBusy(task.id, 'provisioning', () => runProvision(task, images, opts));
  }

  async function runProvision(
    task: TaskRecord,
    images?: readonly PastedImage[],
    opts?: ProvisionOptions,
  ): Promise<void> {
```

Remove `naming` from `ProvisionOptions` (2329–2333). In `runProvision`, delete
the settle block at 2385–2386 and rename the parameter from `draft` to `task`
throughout — the shadowing that block existed to create is gone. Update the
prefetch (2369) to read `task.repos`, and `taskIssue.delete(draft.id)` to
`taskIssue.delete(task.id)`.

In the `tasks.create` handler: make `title` optional in the schema, delete the
`name` argument, and replace the derivation (2941–2981) with:

```ts
        /**
         * Minted, resolved once against what is taken, and then a stored fact.
         * Re-deriving it later would let two tasks resolve to one directory and
         * quietly share a worktree.
         */
        const slug = uniqueSlug(mintName(Math.random), store.takenSlugs());
        /**
         * A title the caller TYPED wins and is never revised. `--title 'Fix login'`
         * is a person's choice; overwriting it with a guess about the paragraph
         * underneath would be a regression. Everything else opens on the brief,
         * and `nameLater` replaces it when the model answers.
         */
        const chosen = args.title?.trim();
        const title = chosen === undefined || chosen === '' ? firstLine(args.brief ?? '') : chosen;
```

and the provision call (3038) with:

```ts
        void provision(task, args.images).catch((error: unknown) => {
          ctx.log.error(`task ${task.id}: provisioning threw — ${String(error)}`);
        });
```

Schema change in the same handler:

```ts
        /**
         * A title the caller chose. Absent is the ordinary case — the composer
         * sends only a brief — and the task then opens on the brief's first line.
         */
        title: s.optional(s.string()),
```

In `v2/extensions/tasks/src/model/naming.ts`, delete `heuristicName` and the
constants only it used (`FILLER`, `URL_WORD`, `DANGLING`, `MAX_HEURISTIC_WORDS`),
keep `JOIN` (used by `readName`), and rewrite the file header:

```ts
/**
 * Naming a task — the pure decisions, kept away from anything that spawns.
 *
 * A name is now only a LABEL: the tab's and the row's. It reaches no directory
 * and no branch, so the model is asked for something a person reads rather than
 * something git can hold, and an answer that never comes costs a task nothing.
 */
```

Delete the `heuristicName` describe block from `naming.test.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run`
Expected: PASS. Tests asserting the old derivation will fail — read each, and
update it to the new behaviour rather than deleting it. Then:
`cd v2 && env -u NODE_OPTIONS pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/tasks/src
git commit -m "A task's folder is minted, and creating one waits for nothing"
```

---

### Task 5: `nameLater` — the answer relabels, and nothing else

**Files:**
- Modify: `v2/extensions/tasks/src/index.ts` — a new `nameLater` and
  `relabelPanes` beside `pendingName` (~1024), the `tasks.create` handler, and
  `startSession`'s title (1556–1557)
- Modify: `v2/extensions/tasks/src/index.test.ts`

**Interfaces:**
- Consumes: `pendingName(brief)` (existing, never rejects), `store.get/put`,
  `changed()`, `paneOf`, `commands.invoke('layout.rename', { pane, title })`.
- Produces: `nameLater(task: TaskRecord): Promise<void>` — writes `title` only.

- [ ] **Step 1: Write the failing test**

Add to `v2/extensions/tasks/src/index.test.ts`:

```ts
it('replaces the title when the model answers, and moves nothing on disk', async () => {
  answerTheModel('Fix the SSO redirect loop');
  const created = await invoke('tasks.create', { brief: 'a'.repeat(40), repos: [] });
  await settled(); // drain the background ask
  const now = (await invoke('tasks.list')).find((t) => t.id === created.id);
  expect(now.title).toBe('Fix the SSO redirect loop');
  expect(now.slug).toBe(created.slug);
});

it('keeps the brief as the title when the model declines', async () => {
  answerTheModel("I'm sorry, I can't help with that");
  const created = await invoke('tasks.create', { brief: 'fix the redirect loop after SSO', repos: [] });
  await settled();
  const now = (await invoke('tasks.list')).find((t) => t.id === created.id);
  expect(now.title).toBe('fix the redirect loop after SSO');
});

it('does not resurrect a task deleted while the model was thinking', async () => {
  const gate = holdTheModel();
  const created = await invoke('tasks.create', { brief: 'a'.repeat(40), repos: [] });
  await invoke('tasks.delete', { task: created.id });
  gate.answer('Some fine name');
  await settled();
  expect((await invoke('tasks.list')).some((t) => t.id === created.id)).toBe(false);
});

it('relabels the panes it already opened', async () => {
  answerTheModel('Fix the SSO redirect loop');
  const created = await invoke('tasks.create', { brief: 'a'.repeat(40), repos: [] });
  await settled();
  expect(renames).toContainEqual({ pane: 'pane-1', title: 'Fix the SSO redirect loop' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run src/index.test.ts -t 'replaces the title'`
Expected: FAIL — the title is still the brief; nothing asked the model

- [ ] **Step 3: Write minimal implementation**

Add beside `pendingName` in `v2/extensions/tasks/src/index.ts`:

```ts
  /**
   * Every live pane of a task, told the task's current name.
   *
   * A pane's title is set once, when it opens (`layout.rename`), and a pane's
   * `userTitle` beats the OSC title a program sets — so a name that lands after
   * the panes do reaches them only if something says so. A failure is logged and
   * stepped over, for the reason the call at `openAgentPane` gives: a title is
   * the decorative part of a spawn.
   */
  async function relabelPanes(task: TaskRecord): Promise<void> {
    for (const session of task.sessions) {
      const pane = paneOf.get(session.id) ?? session.pane;
      if (pane === undefined) continue;
      const title =
        session.role === 'orchestrator' ? task.title : `${task.title} · ${session.repo ?? 'workstream'}`;
      const renamed = await commands.invoke('layout.rename', { pane, title });
      if (!renamed.ok) {
        ctx.log.warn(`task ${task.id}: pane ${pane} kept its title — ${renamed.error.message}`);
      }
    }
  }

  /**
   * Ask what this task should be called, and change ONLY what it is called.
   *
   * Nothing awaits this. It runs beside provisioning rather than in front of it,
   * so a model that is slow, off or signed out costs a task nothing — and
   * `undefined` (which is what a declined or absent model answers) is an ordinary
   * outcome that leaves the brief in place.
   *
   * The record is RE-READ rather than written from the copy this was handed: the
   * ask takes seconds, and in those seconds a task can be archived, restored or
   * deleted. Writing back a captured record would undo whatever happened.
   */
  async function nameLater(task: TaskRecord): Promise<void> {
    const named = await pendingName(task.brief);
    if (named === undefined) return;
    const now = store.get(task.id);
    if (now === undefined || now.title === named) return;
    store.put({ ...now, title: named });
    changed();
    ctx.log.info(`task ${task.id}: named "${named}"`);
    await relabelPanes(store.get(task.id) ?? { ...now, title: named });
  }
```

In the `tasks.create` handler, beside the `provision` call:

```ts
        // Beside provisioning, never in front of it (D20 is what this replaces).
        if (chosen === undefined || chosen === '') {
          void nameLater(task).catch((error: unknown) => {
            ctx.log.error(`task ${task.id}: naming threw — ${String(error)}`);
          });
        }
```

In `startSession`, read the title off the current record (1556–1557) — the name
may have landed while the worktrees were being cut:

```ts
    const named = (store.get(task.id) ?? task).title;
    const pane = await openAgentPane(task, {
      cwd,
      command: plan.command,
      title: input.role === 'orchestrator' ? named : `${named} · ${input.repo ?? 'workstream'}`,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run src/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/tasks/src
git commit -m "The model's answer arrives late and changes one thing: the label"
```

---

### Task 6: The composer stops guessing ahead

**Files:**
- Modify: `v2/extensions/tasks/ui/composer.tsx` — `titleOf` (166–175), the
  `suggested` state (215–221), `askForName` (386–411), the idle-pause effect
  (~417–430), `create` (666–708), the submit guard (819), the disabled guard (942)
- Modify: `v2/extensions/tasks/ui/composer.test.tsx`

**Interfaces:**
- Consumes: `tasks.create` with `{ brief, repos, model?, placement?, images?, member? }`
  — no `title`, no `name`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

In `v2/extensions/tasks/ui/composer.test.tsx`:

```ts
it('sends the brief and no title, so the extension decides what it is called', async () => {
  const { invoked } = renderComposer();
  await type('fix the login redirect loop after SSO');
  await submit();
  const create = invoked.find((call) => call.command === 'tasks.create');
  expect(create.args.brief).toBe('fix the login redirect loop after SSO');
  expect(create.args).not.toHaveProperty('title');
  expect(create.args).not.toHaveProperty('name');
});

it('never asks for a name while you type', async () => {
  const { invoked } = renderComposer();
  await type('fix the login redirect loop after SSO');
  await idle();
  expect(invoked.some((call) => call.command === 'tasks.suggestName')).toBe(false);
});

it('enables Create as soon as the brief has anything in it', async () => {
  renderComposer();
  expect(createButton()).toBeDisabled();
  await type('x');
  expect(createButton()).toBeEnabled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run ui/composer.test.tsx -t 'no title'`
Expected: FAIL — `args.title` is `'fix the login redirect loop after SSO'`

- [ ] **Step 3: Write minimal implementation**

In `v2/extensions/tasks/ui/composer.tsx`:

- Delete `titleOf` (166–175), the `suggested` state, the `namedFor` and
  `namingAsk` refs, `askForName`, the idle-pause `useEffect` that calls it, and
  the `stillTheSameBrief` import (line 5).
- In `create`, drop `title:` and the `...(suggested === null ? {} : { name: suggested })`
  spread, and drop `setSuggested(null)` / `namedFor.current = ""` from the reset.
- Replace the two `titleOf(brief)` guards with the question they were asking:

```tsx
            if (brief.trim() !== "") void create();
```

```tsx
            disabled={brief.trim() === "" || busy}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run ui/composer.test.tsx`
Expected: PASS. Existing tests referencing `suggested` / the live name preview
fail — delete those, they assert behaviour this task removes.

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/tasks/ui
git commit -m "The composer sends a brief and nothing it guessed"
```

---

### Task 7: The branch comes from the refs, not from the slug

**Files:**
- Modify: `v2/extensions/tasks/src/index.ts` — `runProvision` (2344–2530)
- Modify: `v2/extensions/tasks/src/index.test.ts`

**Interfaces:**
- Consumes: `pickBranch`, `mintName` (Tasks 1–2); the existing per-repo prefetch
  at 2369.
- Produces: a local `branch` in `runProvision`, passed to `addWorktree`
  (2410–2416), to the `repoProvisioned` fact (2441), to the `taskProvisioned`
  fact (2530) and to `synthTaskRoot` (Task 8).

**Why:** the prefetch existed to overlap the network with the model call. The
model call is gone from this path; the prefetch now serves the collision check.

- [ ] **Step 1: Write the failing test**

```ts
it('does not check out a branch that was already in the repo', async () => {
  // The mint is stubbed to answer the name the repo already has, then a free one.
  mintReturns(['slate-merino', 'amber-soay']);
  repoHasBranches(['slate-merino']);
  const created = await invoke('tasks.create', { brief: 'a'.repeat(40), repos: [oneRepo] });
  await provisioned(created.id);
  // The FOLDER keeps the minted name; the branch had to move.
  expect(created.slug).toBe('slate-merino');
  expect(gitCalls).toContainEqual(['worktree', 'add', expect.any(String), '-b', 'amber-soay', expect.any(String)]);
});

it('picks one branch for a task, free in every one of its repos', async () => {
  mintReturns(['slate-merino', 'amber-soay']);
  repoHasBranches(['slate-merino'], { repo: 'web' }); // only the second repo has it
  const created = await invoke('tasks.create', { brief: 'a'.repeat(40), repos: [apiRepo, webRepo] });
  await provisioned(created.id);
  const branches = gitCalls.filter((c) => c[0] === 'worktree').map((c) => c[c.indexOf('-b') + 1]);
  expect(new Set(branches)).toEqual(new Set(['amber-soay']));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run src/index.test.ts -t 'already in the repo'`
Expected: FAIL — git is called as `worktree add <dest> slate-merino` (a checkout
of the existing branch) rather than `-b` with a fresh name

- [ ] **Step 3: Write minimal implementation**

In `runProvision`, after the prefetch and before the per-repo chains:

```ts
    /**
     * The task's branch, chosen once the refs are in and checked against EVERY
     * repo — a minted name has no relationship to the work, so a name that
     * already exists is somebody else's branch and `resolveBranch` would check it
     * out rather than create it.
     *
     * A repo whose refs could not be read contributes nothing to the check. That
     * is the honest reading: its chain is about to fail on the same error, and
     * treating an unread repo as "everything is free" is what the per-repo
     * failure below already reports.
     */
    const readable = (await Promise.all(prefetched)).flatMap((read) =>
      read !== undefined && read.ok ? [read.refs] : [],
    );
    const branch = pickBranch(task.slug, readable, () => mintName(Math.random));
    if (branch !== task.slug) {
      ctx.log.info(`task ${task.id}: branch ${branch}, because ${task.slug} was taken`);
    }
```

Then replace `task.slug` with `branch` at the three sites that mean *a git
branch*, and leave it alone at the sites that mean *a directory*:

| line | was | becomes |
|---|---|---|
| 2413 | `task.slug` (the `addWorktree` argument) | `branch` |
| 2441 | `branch: task.slug` | `branch` |
| 2530 | `branch: task.slug` | `branch` |
| 2442, 2529 | `task: { slug: task.slug, root }` | **unchanged** — that is the folder |

Note the prefetch is now awaited twice — once here and once per chain at 2408.
That is safe and deliberate: awaiting a promise twice yields the same value, and
the per-chain read is what carries the per-repo error to the site that reports it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run src/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/tasks/src
git commit -m "A random branch is checked against the repo before git sees it"
```

---

### Task 8: The agent is told it may rename its branch

**Files:**
- Modify: `v2/extensions/tasks/src/model/root-synth.ts` — `SynthInput` (40–44),
  `renderClaudeMd` (~150–170)
- Modify: `v2/extensions/tasks/src/model/root-synth.test.ts`
- Modify: `v2/extensions/tasks/src/index.ts` — the `synthTaskRoot` call (2487)
- Modify: `v2/extensions/tasks/skill/shepherd-tasks/SKILL.md`

**Interfaces:**
- Consumes: `branch` (Task 7).
- Produces: `SynthInput` gains `readonly branch: string`.

- [ ] **Step 1: Write the failing test**

Append to `v2/extensions/tasks/src/model/root-synth.test.ts`:

```ts
it('names the branch and the verb that renames it', () => {
  const root = synthTaskRoot({
    title: 'Fix login',
    brief: 'fix it',
    branch: 'slate-merino',
    repos: [],
  });
  expect(root.claudeMd).toContain('slate-merino');
  expect(root.claudeMd).toContain('shepherd task rename-branch');
});

// It is a prompt to act, not an explanation. The agent needs the door.
it('does not explain why the branch is named what it is', () => {
  const root = synthTaskRoot({ title: 'T', brief: 'b', branch: 'slate-merino', repos: [] });
  expect(root.claudeMd).not.toMatch(/random|placeholder|minted/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run src/model/root-synth.test.ts`
Expected: FAIL — `claudeMd` does not contain `slate-merino` (and a type error on
`branch`)

- [ ] **Step 3: Write minimal implementation**

`SynthInput` gains:

```ts
  /** The branch every worktree here is on. */
  readonly branch: string;
```

In `renderClaudeMd`, after the existing repo block and its two closing lines:

```ts
  lines.push(
    '## Branch',
    '',
    `Every worktree here is on \`${input.branch}\`. Rename it whenever you like:`,
    '',
    '    shepherd task rename-branch <name>',
    '',
  );
```

At the `synthTaskRoot` call site (2487):

```ts
      const planned = synthTaskRoot({
        title: task.title,
        brief: task.brief,
        branch,
```

In `skill/shepherd-tasks/SKILL.md`, add to the verb list:

```sh
shepherd task rename-branch <name>     # rename this task's branch in every repo
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run src/model/root-synth.test.ts && env -u NODE_OPTIONS pnpm vitest run`
Expected: PASS. Existing `synthTaskRoot` tests need `branch` added to their input.

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/tasks/src v2/extensions/tasks/skill
git commit -m "The task root tells an agent it may rename the branch"
```

---

### Task 9: `tasks.renameBranch`, and the CLI verb that reaches it

**Files:**
- Modify: `v2/extensions/tasks/src/manifest.ts` — `TASK_COMMANDS` and the
  commands array (~442)
- Modify: `v2/extensions/tasks/src/index.ts` — register the command
- Modify: `v2/extensions/tasks/src/manifest.test.ts`, `src/index.test.ts`
- Modify: `v2/packages/cli/src/argv.ts` — `VERBS.task`
- Modify: `v2/packages/cli/src/argv.test.ts`

**Interfaces:**
- Consumes: `taskOfSession(store, caller.sessionId)` (4604), `rootOf(task)`,
  `api.proposed.process.gitRead` / `gitWrite`, `branchTaken` (Task 2),
  `readRepoRefs` (`src/provision.ts:98`).
- Produces: command `tasks.renameBranch`, args `{ task?: string; name: string }`,
  answering `{ id, from, to, renamed: string[], failed: string[] }`.

- [ ] **Step 1: Write the failing test**

In `v2/packages/cli/src/argv.test.ts`:

```ts
it('maps task rename-branch to the command', () => {
  expect(parseArgv(['task', 'rename-branch', '--name', 'fix-login'])).toMatchObject({
    ok: true,
    command: 'tasks.renameBranch',
    args: { name: 'fix-login' },
  });
});
```

In `v2/extensions/tasks/src/index.test.ts`:

```ts
it('renames the branch in every worktree of the task', async () => {
  const created = await invoke('tasks.create', { brief: 'a'.repeat(40), repos: [apiRepo, webRepo] });
  await provisioned(created.id);
  const out = await invoke('tasks.renameBranch', { task: created.id, name: 'fix-login' });
  expect(out.renamed).toEqual(['api', 'web']);
  expect(gitCalls).toContainEqual(['branch', '-m', created.slug, 'fix-login']);
});

it('refuses a name already taken, before touching any repo', async () => {
  const created = await invoke('tasks.create', { brief: 'a'.repeat(40), repos: [apiRepo, webRepo] });
  await provisioned(created.id);
  repoHasBranches(['fix-login'], { repo: 'web' });
  gitCalls.length = 0;
  await expect(invoke('tasks.renameBranch', { task: created.id, name: 'fix-login' })).rejects.toThrow(/fix-login/);
  expect(gitCalls.some((c) => c[0] === 'branch')).toBe(false);
});

it('refuses a name that is not a branch name', async () => {
  const created = await invoke('tasks.create', { brief: 'a'.repeat(40), repos: [apiRepo] });
  await provisioned(created.id);
  await expect(invoke('tasks.renameBranch', { task: created.id, name: '../etc' })).rejects.toThrow();
});

it("will not rename another task's branch", async () => {
  const mine = await invoke('tasks.create', { brief: 'a'.repeat(40), repos: [apiRepo] });
  const theirs = await invoke('tasks.create', { brief: 'b'.repeat(40), repos: [webRepo] });
  await expect(
    invokeAsAgent(mine.sessions[0].id, 'tasks.renameBranch', { task: theirs.id, name: 'fix-login' }),
  ).rejects.toThrow(/may not/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd v2/packages/cli && env -u NODE_OPTIONS pnpm vitest run src/argv.test.ts -t 'rename-branch'`
Expected: FAIL — `unknown verb "rename-branch" for "task"`

- [ ] **Step 3: Write minimal implementation**

`v2/packages/cli/src/argv.ts`, in `VERBS.task`:

```ts
    'rename-branch': 'tasks.renameBranch',
```

`v2/extensions/tasks/src/manifest.ts`, in `TASK_COMMANDS`:

```ts
  /**
   * Give this task's branch a name that means something.
   *
   * A verb rather than a line of instructions, because it is one call for a task
   * with three repos and because the refusal it owes — a name already taken in
   * one of them — is checked in every repo before any of them is touched.
   */
  renameBranch: 'tasks.renameBranch',
```

and in the commands array beside `suggestName`:

```ts
      { id: TASK_COMMANDS.renameBranch, title: 'Tasks: Rename the branch' },
```

`v2/extensions/tasks/src/index.ts`:

```ts
  /**
   * A git branch name, conservatively.
   *
   * Not `git check-ref-format`'s whole grammar: this is a name a person or an
   * agent types for a branch we made, and the shapes it excludes (a leading dash,
   * a path separator, `..`) are the ones that turn a rename into an argument git
   * reads as a flag or a ref nobody meant.
   */
  const BRANCH_NAME = /^[a-z0-9][a-z0-9._\-\/]*$/i;
  const legalBranch = (name: string): boolean =>
    BRANCH_NAME.test(name) && !name.includes('..') && !name.endsWith('.lock') && !name.endsWith('/');

  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.renameBranch, {
      title: 'Tasks: Rename the branch',
      schema: s.object({ task: s.optional(s.string()), name: s.string() }),
      /**
       * Scoped to the caller's own task, exactly as `tasks.spawn` is: the kernel
       * authenticates the caller KIND, and which task a session belongs to is a
       * question only this extension can answer.
       *
       * **Nothing is written to the record.** Git holds the branch, so a rename
       * through this verb and one typed by hand in a terminal are the same event,
       * and a stored copy would be a claim about somebody's repository that goes
       * stale the first time they disagree.
       */
      handler: async (args, caller) => {
        const owning = caller.kind === 'agent' ? taskOfSession(store, caller.sessionId) : undefined;
        if (caller.kind === 'agent' && owning === undefined) {
          throw new Error('this session does not belong to a task, so it has no branch to rename');
        }
        const id = args.task ?? owning?.id;
        if (id === undefined) throw new Error('no task named, and the caller is not in one');
        if (owning !== undefined && id !== owning.id) {
          throw new Error(`a session in task ${owning.id} may not rename task ${id}'s branch`);
        }
        const task = store.get(id);
        if (task === undefined) throw new Error(`no task ${id}`);

        const name = args.name.trim();
        if (!legalBranch(name)) throw new Error(`"${name}" is not a branch name`);

        const root = rootOf(task);
        const process_ = api.proposed.process;

        // Every repo, before any of them: a half-renamed task is two branches,
        // and the whole point of one task keeping one branch name is lost by the
        // time the second repo answers.
        const refs = await Promise.all(
          task.repos.map((repo) => readRepoRefs(process_, { name: repo.name, path: repo.path })),
        );
        if (branchTaken(name, refs)) throw new Error(`"${name}" is already a branch in one of this task's repos`);

        const renamed: string[] = [];
        const failed: string[] = [];
        let from = task.slug;
        for (const repo of task.repos) {
          const cwd = `${root}/${repo.name}`;
          const head = await process_.gitRead(['symbolic-ref', '--short', 'HEAD'], { cwd });
          if (!head.ok) {
            failed.push(`${repo.name}: ${head.stderr.trim() || 'not on a branch'}`);
            continue;
          }
          from = head.stdout.trim();
          if (from === name) {
            renamed.push(repo.name);
            continue;
          }
          const out = await process_.gitWrite(['branch', '-m', from, name], { cwd });
          if (out.ok) renamed.push(repo.name);
          else failed.push(`${repo.name}: ${out.stderr.trim() || `git exited ${out.code}`}`);
        }

        // Reported, not rolled back: a rename that succeeded is not a thing to
        // undo behind the user's back, and the next read of git describes
        // whatever is actually there (D15 — surfaced, never silent).
        if (failed.length > 0) ctx.log.warn(`task ${task.id}: rename incomplete — ${failed.join('; ')}`);
        else ctx.log.info(`task ${task.id}: branch is now ${name}`);
        changed();
        return { id: task.id, from, to: name, renamed, failed };
      },
    }),
  );
```

Import `readRepoRefs` from `./provision.ts` and `branchTaken` from `./model/mint.ts`
if not already imported.

Add the command id to whatever list `manifest.test.ts` asserts against
`package.json`'s `shepherd` key, and to `package.json` itself if the manifest is
mirrored there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd v2/packages/cli && env -u NODE_OPTIONS pnpm vitest run` then
`cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/tasks/src v2/packages/cli/src
git commit -m "One call renames a task's branch in every repo it holds"
```

---

### Task 10: `github` asks git which branch a worktree is on

**Files:**
- Modify: `v2/extensions/github/src/sync.ts` — `TaskLike` (22–26) and the sweep
- Modify: `v2/extensions/github/src/index.ts` — where `TaskLike` is built from
  `tasks.list`, and the comment at 655
- Modify: `v2/extensions/github/src/query.ts` — the comment at 13
- Modify: the corresponding `.test.ts` files

**Interfaces:**
- Consumes: `tasks.list`'s records (which no longer promise that slug = branch),
  `ProcessAPI.gitRead`.
- Produces: `TaskLike.branch` becomes per-repo — `repos: { name, path, branch }[]`
  — rather than one field on the task.

- [ ] **Step 1: Write the failing test**

```ts
it('asks the worktree what branch it is on, not the task what it is called', async () => {
  worktreeIsOn('/tasks/slate-merino/api', 'fix-login');
  await sweep();
  expect(queriedHeads).toContain('fix-login');
  expect(queriedHeads).not.toContain('slate-merino');
});

// `rev-parse --abbrev-ref HEAD` answers the literal string `HEAD` on a detached
// head, which is a valid branch to query GitHub with and always the wrong one.
it('asks for no PRs when a worktree is not on a branch', async () => {
  worktreeIsDetached('/tasks/slate-merino/api');
  await sweep();
  expect(queriedHeads).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd v2/extensions/github && env -u NODE_OPTIONS pnpm vitest run -t 'what branch it is on'`
Expected: FAIL — the query used `slate-merino`

- [ ] **Step 3: Write minimal implementation**

Where `TaskLike` is built, read each worktree's head:

```ts
/**
 * Which branch a worktree is on, asked of git.
 *
 * `symbolic-ref --short HEAD` rather than `rev-parse --abbrev-ref HEAD`: on a
 * detached head the second answers the literal string `HEAD`, which is a
 * perfectly valid thing to ask GitHub about and never what anybody meant. This
 * one fails, and a failure is the honest answer to "which branch is this" when
 * the answer is "none".
 *
 * Asked per repo rather than once per task, because a task's branch is no longer
 * its slug and nothing stops an agent renaming one repo's and not another's.
 */
async function branchOf(process_: ProcessAPI, worktree: string): Promise<string | undefined> {
  const out = await process_.gitRead(['symbolic-ref', '--short', 'HEAD'], { cwd: worktree });
  const name = out.ok ? out.stdout.trim() : '';
  return name === '' ? undefined : name;
}
```

A repo whose branch is `undefined` is skipped by the sweep rather than queried.

Rewrite the two stale comments (`index.ts:655`, `query.ts:13`) — they assert "a
task's branch IS its slug", which stops being true here.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd v2/extensions/github && env -u NODE_OPTIONS pnpm vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/github/src
git commit -m "A worktree's branch is git's answer, not the task's name"
```

---

### Task 11: The row keeps its name, and says its step beside it

**Files:**
- Modify: `v2/extensions/tasks/src/index.ts` — `stepLabel` (363–389) and its call site
- Modify: `v2/extensions/tasks/ui/card-data.ts` — the `stage` field (97–107), `readCard` (~258)
- Modify: `v2/extensions/tasks/ui/task-card.tsx` — the head (183–197)
- Modify: `v2/packages/app/src/renderer/task-card.css`
- Modify: `v2/extensions/tasks/ui/task-card.test.tsx`, `ui/card-data.test.ts`

**Interfaces:**
- Consumes: `stepLabel(what, task): string | undefined` (unchanged signature).
- Produces: `CardData` gains `readonly stage?: string`; the tree item's `label`
  is always `task.title`.

- [ ] **Step 1: Write the failing test**

`ui/task-card.test.tsx`:

```tsx
it("keeps the task's name while it says what it is doing", () => {
  render(<TaskCard item={{ label: 'fix the login redirect loop' }} card={{ mark: 'working', stage: 'Creating the worktree' }} />);
  expect(screen.getByText('fix the login redirect loop')).toBeInTheDocument();
  expect(screen.getByText('Creating the worktree')).toBeInTheDocument();
});

// §10: a row must not grow to say something.
it('draws the stage in the head, not on a line of its own', () => {
  const { container } = render(<TaskCard item={{ label: 'T' }} card={{ mark: 'working', stage: 'Setting up' }} />);
  expect(container.querySelector('.sh-task-card__head .sh-task-card__stage')).not.toBeNull();
});
```

In `src/index.test.ts`:

```ts
it('labels a provisioning row with the task, and stages the step', async () => {
  const created = await invoke('tasks.create', { brief: 'fix the login redirect loop', repos: [apiRepo] });
  const row = await treeItemFor(created.id);
  expect(row.label).toBe('fix the login redirect loop');
  expect(row.card.stage).toBe('Creating the worktree');
});

it('drops the stage when there is nothing left to do', async () => {
  const created = await invoke('tasks.create', { brief: 'fix the login redirect loop', repos: [apiRepo] });
  await provisioned(created.id);
  expect((await treeItemFor(created.id)).card.stage).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run -t 'stages the step'`
Expected: FAIL — `row.label` is `'Creating the worktree'` and `card.stage` is undefined

- [ ] **Step 3: Write minimal implementation**

In `src/index.ts` at the tree-item call site (~905): the label becomes
`task.title` unconditionally, and `stepLabel(...)` is passed as `card.stage`.
Rewrite `stepLabel`'s doc comment — its premise ("a task has no name until the
model answers") is what this change removes:

```ts
/**
 * What the row is DOING while it is being built — beside its name, not instead of it.
 *
 * A task is called something from the moment it exists (its own brief, then the
 * model's name), so the step no longer has to stand in for a name. It sits in its
 * own cell in the head and disappears when the work does.
 *
 * Sentence case and three words at most: this is a label and §6 governs it.
 */
```

In `ui/card-data.ts`, replace the "there is deliberately no `stage` field" comment
with the field:

```ts
  /**
   * The step this task is on, while it is being built.
   *
   * It sits BESIDE the label rather than replacing it — a row that said
   * `Creating the worktree` where its name goes was answering the wrong question
   * — and beside rather than under, because §10 refuses a row that grows to say
   * something. Absent the moment provisioning ends.
   */
  readonly stage?: string;
```

and in the reader: `stage: str(value['stage']),`.

In `ui/task-card.tsx`, after the title span and before `dupe`:

```tsx
        {card.stage === undefined ? null : (
          <span className="sh-task-card__stage">{card.stage}</span>
        )}
```

In `packages/app/src/renderer/task-card.css`, after the `dupe` block:

```css
/*
 * ── the step, while a task is being built ─────────────────────────────────
 *
 * `flex: none`, so the title truncates around it rather than the row growing —
 * the rule `dupe` above is built on, for the same reason. Plain text and not a
 * ring: `dupe` is a fact about the row that stays, and this is a word about
 * right now that leaves.
 *
 * `text-mute` rather than a hue. The mark already carries the state; a second
 * coloured thing on the line would be a status word beside a status mark.
 */
.sh-task-card__stage {
  flex: none;
  font-size: var(--sh-font-size-nano);
  color: var(--sh-text-mute);
  white-space: nowrap;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd v2/extensions/tasks && env -u NODE_OPTIONS pnpm vitest run` and
`cd v2/packages/ui && env -u NODE_OPTIONS pnpm vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/tasks v2/packages/app/src/renderer/task-card.css
git commit -m "A row keeps its name and says its step beside it"
```

---

### Task 12: The smoke asserts the new promise, and every gate is run

**Files:**
- Modify: `v2/packages/app/src/main/smoke-m3.ts` (136–137, 170)
- Modify: `v2/tooling/scripts/smoke-m3.mjs` if it asserts on the slug

**Interfaces:**
- Consumes: everything above.
- Produces: a green `pnpm smoke:m3`.

The M3 lesson applies here more than anywhere: three gates in this codebase were
passing without checking anything, and each was found by mutation-testing rather
than by reading.

- [ ] **Step 1: Rewrite the two assertions**

```ts
  check(
    /^[a-z]+-[a-z]+(-\d+)?$/.test(created.slug),
    `create mints a slug that owes nothing to the brief: ${created.slug}`,
  );
  check(
    created.title === 'provisioned by the m3 smoke',
    `the task opens on its own brief: ${created.title}`,
  );
```

and, where the settle was asserted:

```ts
  check(
    settled?.title === 'stub named this',
    `the model's answer became the title: ${settled?.title ?? 'none'}`,
  );
  check(
    settled?.slug === created.slug,
    `and the folder did not move: ${settled?.slug ?? 'none'} was ${created.slug}`,
  );
```

- [ ] **Step 2: Verify the new assertions can fail**

Temporarily make `nameLater` write nothing, run the smoke, and confirm the title
check FAILS. Then revert. A gate that passes with the change reverted is not a gate.

Run: `cd v2 && env -u NODE_OPTIONS pnpm smoke:m3`
Expected: FAIL on `the model's answer became the title`

- [ ] **Step 3: Restore and run every gate**

```bash
cd v2
env -u NODE_OPTIONS pnpm typecheck
env -u NODE_OPTIONS pnpm lint
env -u NODE_OPTIONS pnpm test
env -u NODE_OPTIONS pnpm smoke:m3
```

- [ ] **Step 4: Run the app and watch one task be created**

```bash
cd v2 && env -u NODE_OPTIONS pnpm dev
```

Compose a task and confirm, in order: the row appears immediately with the brief
as its label and a step beside it; the folder under `~/.shepherd/v2/tasks/` is a
`<colour>-<breed>`; the agent's pane opens on the brief; the label and the tab both
change to the model's name a few seconds later without the folder moving; the task
root's `CLAUDE.md` has the `## Branch` section naming the real branch.

- [ ] **Step 5: Commit**

```bash
git add v2
git commit -m "The smoke asserts a minted slug and a title that settles"
```

---

## Self-review

**Spec coverage:**

| spec section | task |
|---|---|
| The mint | 1 |
| Two kinds of collision | 1 (folder, via `uniqueSlug`), 2 + 7 (branch) |
| What the record holds | 4 |
| Naming becomes a background job | 4, 5 |
| `title` becomes optional / `heuristicName` deleted / `firstLine` | 3, 4 |
| The composer | 6 |
| The branch, read live | 7 (facts), 10 (github) |
| The rename verb | 9 |
| The rail row and the tab | 11 (row), 5 (tab relabel) |
| What the agent is told | 8 |
| Verification | 12 |

**Type consistency:** `mintName(random)`, `branchTaken(name, refs)`,
`pickBranch(first, refs, mint, attempts?)`, `firstLine(brief)`,
`nameLater(task)`, `relabelPanes(task)`, `SynthInput.branch`, `CardData.stage`
are spelled identically everywhere they appear.

**Known risk, flagged for the executor:** `src/index.test.ts` is 4,186 lines and
many of its tests assert the old derivation (a slug read off the brief, a
`settleName` race, a `name` argument). Task 4 will fail a batch of them at once.
Read each before changing it — a test asserting "the slug came from the brief" is
superseded, but one asserting "two tasks with the same name get different
folders" still has to pass, through `uniqueSlug`.
