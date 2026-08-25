# Editor Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Shepherd tab with a file tree of the task's worktrees, an editable syntax-highlighted view of the file you click, and a second view showing what you have changed against `HEAD`.

**Architecture:** A new extension `shepherd.editor` in `v2/extensions/editor/`, split the way every extension here is: `src/` is a service half running in a utility process (git queries via `process.gitRead`, file IO via `node:fs`, no DOM), and `ui/` is a React half the renderer mounts as a pane view (ADR 0044). The UI is almost entirely `@pierre/diffs` and `@pierre/trees`, which `@shepherd/ext-github` already depends on — `<File edit>` for editing, `CodeView` for diffs, `FileTree` for the tree.

**Tech Stack:** TypeScript, React 19, `@pierre/diffs@1.3.5`, `@pierre/trees@1.0.0-beta.6`, `@shepherd/sdk`, `@shepherd/ui`, vitest + jsdom.

**Spec:** [`docs/superpowers/specs/2026-08-24-editor-pane-design.md`](../specs/2026-08-24-editor-pane-design.md)

## Global Constraints

- **Scope is `v2/` only.** Nothing under `spike/` is touched.
- **Run everything from `v2/`.** `cd v2` first; `pnpm` commands are workspace-relative.
- **Extension boundary (`v2/tooling/eslint/boundaries.js`).** `src/` may make **type-only** imports of another extension; values cross via `extensions.get` or a command id written out as a string literal. `ui/` may import `@shepherd/ui` and its own extension's `src/`, never another extension's `ui/`.
- **`src/` has no DOM.** It runs in a utility process. No `document`, no `window`, no React.
- **Answers from a command are `unknown`, and a cast is not a check.** Every value crossing the port is read field by field, with malformed rows dropped rather than defaulted.
- **Version floors:** `@pierre/diffs` is `1.3.5` — the editable prop is `edit` and editor config is `editorOptions`. (t3code pins `1.3.0-beta.10` where the prop is `contentEditable`; do not copy that name.)
- **`process.gitRead`, never `process.exec`, for git.** It sets `GIT_OPTIONAL_LOCKS=0`; a plain `git status` through `exec` rewrites `.git/index` and wakes watchers.
- **`ExecOptions.timeoutMs` is required.** Use `10_000` for listing and status, `20_000` for diffs.
- **`git diff --no-index` exits 1 when there are differences.** That is `ExecErr` with `code: 1` and a populated `stdout`, and it is the success case.
- **Naming:** the tree's scratch root is `Notes`, never `Scratch`/`Scratchpad` — the rail's `Scratchpad` section is loose shells (ADR 0047).
- **Commit after every task**, with the test and implementation in the same commit.

---

## File Structure

**New package `v2/extensions/editor/`:**

| File | Responsibility |
|---|---|
| `package.json` | Manifest + deps. Mirrors `extensions/github/package.json`. |
| `tsconfig.json`, `vitest.config.ts` | Copied from `extensions/scratch/`. |
| `src/manifest.ts` | Typed copy of the `shepherd` key: ids, commands, view type. |
| `src/manifest.test.ts` | Asserts the typed copy equals `package.json`. |
| `src/paths.ts` | **Pure.** Two `git ls-files` outputs → the tree's path list. |
| `src/status.ts` | **Pure.** `git status --porcelain -z` → `GitStatusEntry[]` + changed paths. |
| `src/files.ts` | `node:fs` reads/writes with the mtime+size stamp and the stale refusal. |
| `src/walk.ts` | `readdir` fallback for a non-git root, with the cap. |
| `src/git.ts` | The `gitRead` calls. Thin; the parsing lives in the pure modules. |
| `src/index.ts` | `activate`: registers the view type and the commands. |
| `ui/diff-theme.ts` | Copied from `github` (see Task 8's note). |
| `ui/editor-pane.tsx` | The pane: tree on the left, editor or diffs on the right. |
| `ui/file-editor.tsx` | `<EditProvider>` + `<File edit>` + save keybinding. |
| `ui/changes.tsx` | The diff list. |
| `ui/jsdom-gaps.ts` | Copied from `github` — `ResizeObserver` etc. for tests. |
| `ui/index.ts` | Barrel; the only thing the renderer imports. |

**Modified:**

| File | Change |
|---|---|
| `v2/packages/app/package.json` | Add `@shepherd/ext-editor`. |
| `v2/packages/app/src/main/index.ts` | Register the manifest. |
| `v2/packages/app/src/renderer/extension-ui.ts` | Add `'editor.workspace'` to `EXTENSION_PANE_UI`. |
| `v2/extensions/scratch/src/manifest.ts` | Add `list` and `saveAs` commands. |
| `v2/extensions/scratch/src/store.ts` | Add `list()`. |
| `v2/extensions/scratch/src/index.ts` | Register the two commands. |

---

## Task 1: Scaffold the extension

**Files:**
- Create: `v2/extensions/editor/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/manifest.ts`, `src/index.ts`, `ui/index.ts`
- Test: `v2/extensions/editor/src/manifest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `EDITOR_ID = 'shepherd.editor'`, `EDITOR_COMMANDS`, `EDITOR_VIEWS`, `manifest: Manifest`.

- [ ] **Step 1: Copy the scaffolding files**

```bash
cd v2
mkdir -p extensions/editor/src extensions/editor/ui
cp extensions/scratch/tsconfig.json extensions/editor/tsconfig.json
cp extensions/scratch/vitest.config.ts extensions/editor/vitest.config.ts
cp extensions/github/ui/jsdom-gaps.ts extensions/editor/ui/jsdom-gaps.ts
```

- [ ] **Step 2: Write `extensions/editor/package.json`**

```json
{
  "name": "@shepherd/ext-editor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "shepherd.editor — the files of a task's worktrees, editable, and what you changed in them.",
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" },
    "./manifest": { "types": "./src/manifest.ts", "default": "./src/manifest.ts" },
    "./ui": { "types": "./ui/index.ts", "default": "./ui/index.ts" }
  },
  "scripts": { "typecheck": "tsc -b", "test": "vitest run" },
  "//pierre": "The same buy github made, for the same two panels: @pierre/trees is the file list and @pierre/diffs is both the editor (`/edit`, `<File edit>`) and the diff renderer. A vendor dependency an extension owns privately — the boundary lint is about which SHEPHERD packages an extension may reach.",
  "dependencies": {
    "@shepherd/ext-scratch": "workspace:*",
    "@shepherd/ext-tasks": "workspace:*",
    "@shepherd/sdk": "workspace:*",
    "@shepherd/ui": "workspace:*",
    "@pierre/diffs": "catalog:",
    "@pierre/trees": "catalog:"
  },
  "devDependencies": {
    "@types/node": "catalog:",
    "@types/react": "catalog:",
    "@types/react-dom": "catalog:",
    "jsdom": "catalog:",
    "react": "catalog:",
    "react-dom": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  },
  "shepherd": {
    "id": "shepherd.editor",
    "name": "Editor",
    "version": "0.1.0",
    "api": "^1.0.0",
    "activation": ["onStartup"],
    "permissions": ["storage", "process.exec", "views", "layout"],
    "dependencies": ["shepherd.tasks", "shepherd.scratch"],
    "contributes": {
      "commands": [
        { "id": "editor.open", "title": "Editor: Open" },
        { "id": "editor.tree" },
        { "id": "editor.read" },
        { "id": "editor.write" },
        { "id": "editor.changes" },
        { "id": "editor.diff" }
      ]
    }
  }
}
```

Note `@shepherd/ext-scratch` and `@shepherd/ext-tasks` are **type-only** imports at
runtime — the dependency entry is what makes `extensions.get` legal, exactly as
`github` declares `tasks`.

- [ ] **Step 3: Write `src/manifest.ts`**

```ts
import type { Manifest } from '@shepherd/sdk';

/**
 * The manifest, typed, so main can register this extension without importing
 * its code. `manifest.test.ts` asserts it equals `package.json`'s `shepherd`
 * key rather than trusting anybody to keep the two in step.
 */
export const EDITOR_ID = 'shepherd.editor';

/** `tasks`' id and `scratch`'s, re-stated: only TYPES cross between extensions. */
export const TASKS_ID = 'shepherd.tasks';
export const SCRATCH_ID = 'shepherd.scratch';

export const EDITOR_COMMANDS = {
  /** Open (or focus) the editor tab for a task, or for a path. */
  open: 'editor.open',
  /** Every path the tree should show, for one root. */
  tree: 'editor.tree',
  /** One file's text, plus the stamp a later write is checked against. */
  read: 'editor.read',
  /** Write a file, refusing if its stamp moved. */
  write: 'editor.write',
  /** What differs from HEAD: the paths, and their status marks. */
  changes: 'editor.changes',
  /** One file's patch against HEAD. */
  diff: 'editor.diff',
} as const;

/**
 * The view type AND the component name, deliberately one string — the renderer
 * resolves the type against the registered contribution and only then resolves
 * `component` against its static table (ADR 0044).
 */
export const EDITOR_VIEWS = { workspace: 'editor.workspace' } as const;

/** What the tab strip calls this pane. A view pane runs no program, so nothing sets an OSC title. */
export const TAB_TITLE = 'editor';

export const manifest: Manifest = {
  id: EDITOR_ID,
  name: 'Editor',
  version: '0.1.0',
  api: '^1.0.0',
  activation: ['onStartup'],
  permissions: ['storage', 'process.exec', 'views', 'layout'],
  dependencies: [TASKS_ID, SCRATCH_ID],
  contributes: {
    commands: [
      { id: EDITOR_COMMANDS.open, title: 'Editor: Open' },
      { id: EDITOR_COMMANDS.tree },
      { id: EDITOR_COMMANDS.read },
      { id: EDITOR_COMMANDS.write },
      { id: EDITOR_COMMANDS.changes },
      { id: EDITOR_COMMANDS.diff },
    ],
  },
};
```

- [ ] **Step 4: Write the failing manifest test**

Copy the assertion `extensions/scratch/src/manifest.test.ts` makes, retargeted:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { manifest } from './manifest.ts';

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
  shepherd: unknown;
};

describe('manifest', () => {
  it('is identical to the shepherd key of package.json', () => {
    expect(pkg.shepherd).toEqual(JSON.parse(JSON.stringify(manifest)));
  });
});
```

- [ ] **Step 5: Write a placeholder `src/index.ts` and `ui/index.ts`**

```ts
// src/index.ts
import type { ActivateFn } from '@shepherd/sdk';

export const activate: ActivateFn = (ctx) => {
  ctx.log.info('editor activated');
};
```

```ts
// ui/index.ts
export {};
```

- [ ] **Step 6: Install and run the test**

```bash
cd v2 && pnpm install && pnpm --filter @shepherd/ext-editor test
```

Expected: PASS. If it fails, the two manifest copies differ — fix `package.json` or `manifest.ts` so they match exactly.

- [ ] **Step 7: Typecheck**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor typecheck
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add v2/extensions/editor v2/pnpm-lock.yaml
git commit -m "feat(v2/editor): scaffold the extension"
```

---

## Task 2: Path listing (`src/paths.ts`)

**Files:**
- Create: `v2/extensions/editor/src/paths.ts`
- Test: `v2/extensions/editor/src/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `treePaths(tracked: string, ignored: string): readonly string[]`

This is the pure core of the tree, and the test below is the one that guards the
spec's central decision: **`.env` is in the tree and `node_modules` is not.**

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { treePaths } from './paths.ts';

/*
 * Verbatim output from a real repo, captured while writing the design:
 *   git ls-files --cached --others --exclude-standard
 *   git ls-files --others --ignored --exclude-standard --directory
 */
const TRACKED = '.gitignore\nnew.txt\nsrc/b.ts\na.txt\n';
const IGNORED = '.env\nnode_modules/\nrun.log\n';

describe('treePaths', () => {
  it('keeps ignored FILES and drops ignored DIRECTORIES', () => {
    const paths = treePaths(TRACKED, IGNORED);
    // The whole point: an ignored file is very often the file you opened the
    // editor to change.
    expect(paths).toContain('.env');
    expect(paths).toContain('run.log');
    // An ignored directory is one you never open, and enumerating it is what
    // makes an eager flat path list impossible.
    expect(paths).not.toContain('node_modules/');
    expect(paths.some((path) => path.startsWith('node_modules'))).toBe(false);
  });

  it('includes tracked and untracked-but-not-ignored files', () => {
    const paths = treePaths(TRACKED, IGNORED);
    expect(paths).toContain('src/b.ts');
    expect(paths).toContain('a.txt');
    expect(paths).toContain('new.txt');
  });

  it('sorts, and de-duplicates a path both lists name', () => {
    expect(treePaths('b.ts\na.ts\n', 'a.ts\n')).toEqual(['a.ts', 'b.ts']);
  });

  it('is empty for empty output rather than yielding one blank path', () => {
    // A trailing newline splits to a final '' — a blank row in the tree.
    expect(treePaths('', '')).toEqual([]);
    expect(treePaths('\n', '\n')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test paths
```

Expected: FAIL — `Failed to resolve import "./paths.ts"`.

- [ ] **Step 3: Implement**

```ts
/**
 * The tree's path list, from git's two answers about what is in the directory.
 *
 * **Why not just `git ls-files --cached --others --exclude-standard`.** That is
 * gitignore-aware, so it hides `.env` — and an ignored file is very often
 * exactly the file the editor was opened to change. The opposite (an unpruned
 * walk) puts a hundred thousand `node_modules` entries into a list that
 * `useFileTree` holds in full, because its `paths` is flat and eager with no
 * async-children hook.
 *
 * The line that resolves it is **ignored FILES versus ignored DIRECTORIES**:
 * `.env`, `.env.local` and `*.log` are ignored files you edit; `node_modules/`,
 * `dist/` and `.next/` are ignored directories you never open. Git draws that
 * line itself — `--directory` collapses a fully-ignored directory to a single
 * entry WITH A TRAILING SLASH, so the slash is the whole test.
 */
export function treePaths(tracked: string, ignored: string): readonly string[] {
  const all = new Set<string>(lines(tracked));
  for (const entry of lines(ignored)) {
    // The trailing slash means "and everything under here", which is the set we
    // are refusing to enumerate.
    if (entry.endsWith('/')) continue;
    all.add(entry);
  }
  return [...all].sort();
}

/**
 * Git's output is newline-terminated, so a naive split ends in `''` — which
 * would reach the tree as a path with no name and render as a blank row.
 */
function lines(out: string): readonly string[] {
  return out.split('\n').filter((line) => line !== '');
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test paths
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/editor/src/paths.ts v2/extensions/editor/src/paths.test.ts
git commit -m "feat(v2/editor): list tree paths, keeping ignored files and dropping ignored dirs"
```

---

## Task 3: Git status (`src/status.ts`)

**Files:**
- Create: `v2/extensions/editor/src/status.ts`
- Test: `v2/extensions/editor/src/status.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  interface StatusEntry { readonly path: string; readonly status: 'added' | 'modified' | 'deleted' | 'untracked' | 'renamed' }
  function readStatus(porcelainZ: string): readonly StatusEntry[]
  ```

`@pierre/trees` draws the marks itself from `model.setGitStatus(...)`; this turns
git's answer into that shape.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { readStatus } from './status.ts';

/*
 * `--porcelain -z`: NUL-separated, and a rename is TWO NUL-separated fields —
 * `R  new\0old`. The `-z` form is used rather than the newline one because a
 * path may legally contain a newline, and the newline form quotes and escapes
 * those, which is a second parser nobody wants.
 */
describe('readStatus', () => {
  it('reads the ordinary marks', () => {
    const out = ' M src/a.ts\0A  src/b.ts\0 D src/c.ts\0?? notes.md\0';
    expect(readStatus(out)).toEqual([
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/b.ts', status: 'added' },
      { path: 'src/c.ts', status: 'deleted' },
      { path: 'notes.md', status: 'untracked' },
    ]);
  });

  it('reads a rename, whose NEW path is the one the tree has a row for', () => {
    // `R  new\0old` — two fields for one entry. Consuming only one leaves the
    // OLD path parsed as the next entry's status code, and every subsequent
    // row shifts by one.
    const out = 'R  src/new.ts\0src/old.ts\0 M src/after.ts\0';
    expect(readStatus(out)).toEqual([
      { path: 'src/new.ts', status: 'renamed' },
      { path: 'src/after.ts', status: 'modified' },
    ]);
  });

  it('prefers the staged mark when both columns are set', () => {
    expect(readStatus('MM src/a.ts\0')).toEqual([{ path: 'src/a.ts', status: 'modified' }]);
  });

  it('is empty for a clean tree', () => {
    expect(readStatus('')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test status
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/** What a row's mark says. The vocabulary `@pierre/trees` draws. */
export type StatusKind = 'added' | 'modified' | 'deleted' | 'untracked' | 'renamed';

export interface StatusEntry {
  readonly path: string;
  readonly status: StatusKind;
}

/**
 * `git status --porcelain -z` → the marks the tree draws.
 *
 * **`-z`, not the newline form.** A path may legally contain a newline, and the
 * newline form quotes and escapes those — a second parser, for a case that
 * arrives as corrupted rows rather than as an error.
 *
 * **A rename is two fields.** `R  new\0old\0` is ONE entry spread over two
 * NUL-separated values. Consuming one leaves the old path where the next
 * entry's two-character status code should be, and every row after it is
 * garbage — which is why the loop advances by two for `R` and `C`.
 */
export function readStatus(out: string): readonly StatusEntry[] {
  const fields = out.split('\0').filter((field) => field !== '');
  const entries: StatusEntry[] = [];

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field === undefined || field.length < 4) continue;
    const staged = field[0];
    const worktree = field[1];
    const path = field.slice(3);

    if (staged === 'R' || staged === 'C') {
      entries.push({ path, status: 'renamed' });
      // The second field is the OLD path. Skip it — the tree has a row for the
      // new one, and this is not the loop's next entry.
      i += 1;
      continue;
    }
    if (staged === '?' || worktree === '?') {
      entries.push({ path, status: 'untracked' });
      continue;
    }

    // The STAGED column wins when both are set: `MM` is a file modified, staged,
    // then modified again, and "modified" is the whole of what a mark can say.
    const kind = mark(staged) ?? mark(worktree);
    if (kind !== undefined) entries.push({ path, status: kind });
  }

  return entries;
}

function mark(code: string | undefined): StatusKind | undefined {
  switch (code) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    default:
      return undefined;
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test status
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/editor/src/status.ts v2/extensions/editor/src/status.test.ts
git commit -m "feat(v2/editor): parse git status --porcelain -z into tree marks"
```

---

## Task 4: File IO and the stale refusal (`src/files.ts`)

**Files:**
- Create: `v2/extensions/editor/src/files.ts`
- Test: `v2/extensions/editor/src/files.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  interface Stamp { readonly mtimeMs: number; readonly size: number }
  interface ReadFile { readonly text: string; readonly stamp: Stamp }
  function readFileAt(root: string, rel: string): ReadFile | { readonly error: string }
  function writeFileAt(root: string, rel: string, text: string, stamp: Stamp):
    { readonly stamp: Stamp } | { readonly error: 'stale' | string }
  ```

**This is the most important task in the plan.** An agent is editing these files
while the user is, and the refusal is what makes that survivable.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileAt, writeFileAt } from './files.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'editor-files-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readFileAt', () => {
  it('returns the text and a stamp', () => {
    writeFileSync(join(root, 'a.ts'), 'hello\n');
    const read = readFileAt(root, 'a.ts');
    expect(read).toMatchObject({ text: 'hello\n' });
    expect('stamp' in read && read.stamp.size).toBe(6);
  });

  it('refuses a path that escapes the root', () => {
    // A path is a string from a renderer. `../` in it is a request to read
    // somewhere the pane was never opened on.
    expect(readFileAt(root, '../outside.ts')).toEqual({ error: 'outside the root' });
  });

  it('reports a missing file rather than throwing', () => {
    expect(readFileAt(root, 'nope.ts')).toMatchObject({ error: expect.any(String) });
  });
});

describe('writeFileAt', () => {
  it('writes when the stamp still matches', () => {
    writeFileSync(join(root, 'a.ts'), 'one\n');
    const read = readFileAt(root, 'a.ts');
    if (!('stamp' in read)) throw new Error('read failed');

    const wrote = writeFileAt(root, 'a.ts', 'two\n', read.stamp);
    expect(wrote).toMatchObject({ stamp: expect.anything() });
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('two\n');
  });

  it('REFUSES when the file changed underneath, and does not write', () => {
    // The case this whole design exists for: an agent edited the file between
    // the read and the save.
    writeFileSync(join(root, 'a.ts'), 'one\n');
    const read = readFileAt(root, 'a.ts');
    if (!('stamp' in read)) throw new Error('read failed');

    writeFileSync(join(root, 'a.ts'), 'AGENT WROTE THIS\n');

    const wrote = writeFileAt(root, 'a.ts', 'two\n', read.stamp);
    expect(wrote).toEqual({ error: 'stale' });
    // The agent's work is still there. This is the assertion that matters.
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('AGENT WROTE THIS\n');
  });

  it('REFUSES on a same-size change, which mtime is the only witness to', () => {
    // `one\n` → `two\n` is the same length. Size alone would call this fresh.
    writeFileSync(join(root, 'a.ts'), 'one\n');
    const read = readFileAt(root, 'a.ts');
    if (!('stamp' in read)) throw new Error('read failed');

    writeFileSync(join(root, 'a.ts'), 'two\n');
    // Force a distinct mtime — a write inside the same filesystem tick can
    // otherwise carry the same timestamp, which is a real race and the reason
    // this test sets the time explicitly rather than sleeping.
    const later = new Date(read.stamp.mtimeMs + 5_000);
    utimesSync(join(root, 'a.ts'), later, later);

    expect(writeFileAt(root, 'a.ts', 'three\n', read.stamp)).toEqual({ error: 'stale' });
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('two\n');
  });

  it('writes a file that does not exist yet', () => {
    const wrote = writeFileAt(root, 'new.ts', 'fresh\n', { mtimeMs: 0, size: 0 });
    expect(wrote).toMatchObject({ stamp: expect.anything() });
    expect(readFileSync(join(root, 'new.ts'), 'utf8')).toBe('fresh\n');
  });

  it('returns a NEW stamp, so a second save in the same session is not stale', () => {
    writeFileSync(join(root, 'a.ts'), 'one\n');
    const read = readFileAt(root, 'a.ts');
    if (!('stamp' in read)) throw new Error('read failed');

    const first = writeFileAt(root, 'a.ts', 'two\n', read.stamp);
    if (!('stamp' in first)) throw new Error('first write refused');
    const second = writeFileAt(root, 'a.ts', 'three\n', first.stamp);
    expect(second).toMatchObject({ stamp: expect.anything() });
  });

  it('refuses a path that escapes the root', () => {
    expect(writeFileAt(root, '../outside.ts', 'x', { mtimeMs: 0, size: 0 })).toEqual({
      error: 'outside the root',
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test files
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/**
 * `node:fs` directly, and no permission for it: fs and path are stdlib, and the
 * grant that names the consequence here is `process.exec`, which this extension
 * holds for git. `extensions/scratch/src/install.ts` records the same reasoning.
 */

/**
 * What a file looked like when we read it.
 *
 * mtime AND size, because either alone lies: a same-length edit (`one` → `two`)
 * leaves the size identical, and a filesystem with coarse timestamps can leave
 * the mtime identical across two writes in the same tick. Together they are
 * wrong only for an edit that is byte-identical in length within one tick,
 * which is a collision this design accepts.
 */
export interface Stamp {
  readonly mtimeMs: number;
  readonly size: number;
}

export interface ReadFile {
  readonly text: string;
  readonly stamp: Stamp;
}

export interface IoError {
  readonly error: string;
}

/**
 * A path from the renderer is a STRING, and `../` in it is a request to leave
 * the directory the pane was opened on. Resolved and compared rather than
 * pattern-matched: `a/../../b` contains no leading `..` and still escapes.
 */
function inside(root: string, rel: string): string | undefined {
  if (isAbsolute(rel)) return undefined;
  const full = resolve(join(root, rel));
  const back = relative(resolve(root), full);
  if (back === '' || back.startsWith('..') || isAbsolute(back)) return undefined;
  return full;
}

function stampOf(full: string): Stamp {
  const stat = statSync(full);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

export function readFileAt(root: string, rel: string): ReadFile | IoError {
  const full = inside(root, rel);
  if (full === undefined) return { error: 'outside the root' };
  try {
    // The stamp is taken BEFORE the read, so a write that lands between the two
    // makes the next save stale rather than making this read look current.
    const stamp = stampOf(full);
    return { text: readFileSync(full, 'utf8'), stamp };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'could not read' };
  }
}

/**
 * Write, unless the file moved under us.
 *
 * **The refusal is the feature.** An agent is editing this worktree while the
 * user is, and a save that overwrites its work would do so silently and
 * constantly. There is no merge and no "which one wins" prompt that discards
 * the loser unseen: the answer is `stale`, and the pane offers a reload.
 *
 * A file that does not exist yet is not stale — it is new.
 */
export function writeFileAt(
  root: string,
  rel: string,
  text: string,
  stamp: Stamp,
): { readonly stamp: Stamp } | IoError {
  const full = inside(root, rel);
  if (full === undefined) return { error: 'outside the root' };

  let current: Stamp | undefined;
  try {
    current = stampOf(full);
  } catch {
    current = undefined;
  }
  if (current !== undefined && (current.mtimeMs !== stamp.mtimeMs || current.size !== stamp.size)) {
    return { error: 'stale' };
  }

  try {
    writeFileSync(full, text, 'utf8');
    // A FRESH stamp, so the next ⌘S in the same session is not refused by the
    // write this one just made.
    return { stamp: stampOf(full) };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'could not write' };
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test files
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/editor/src/files.ts v2/extensions/editor/src/files.test.ts
git commit -m "feat(v2/editor): read and write files, refusing a save whose file moved"
```

---

## Task 5: The non-git walk (`src/walk.ts`)

**Files:**
- Create: `v2/extensions/editor/src/walk.ts`
- Test: `v2/extensions/editor/src/walk.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  const WALK_MAX_ENTRIES = 25_000
  interface Walked { readonly paths: readonly string[]; readonly truncated: boolean }
  function walk(root: string, max?: number): Walked
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { walk, WALK_MAX_ENTRIES } from './walk.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'editor-walk-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('walk', () => {
  it('lists files relative to the root, depth-first', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '');
    writeFileSync(join(root, 'src', 'a.ts'), '');
    expect(walk(root).paths).toEqual(['README.md', 'src/a.ts']);
  });

  it('prunes .git', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), '');
    writeFileSync(join(root, 'a.ts'), '');
    expect(walk(root).paths).toEqual(['a.ts']);
  });

  it('keeps other dotfiles — .env is the reason this pane exists', () => {
    writeFileSync(join(root, '.env'), '');
    expect(walk(root).paths).toContain('.env');
  });

  it('stops at the cap and SAYS SO', () => {
    for (let i = 0; i < 5; i += 1) writeFileSync(join(root, `f${i}.ts`), '');
    const walked = walk(root, 3);
    expect(walked.paths).toHaveLength(3);
    // A truncated listing that does not announce itself reads as a complete
    // one, and the file you wanted is simply absent with no explanation.
    expect(walked.truncated).toBe(true);
  });

  it('does not claim truncation when everything fit', () => {
    writeFileSync(join(root, 'a.ts'), '');
    expect(walk(root, 3).truncated).toBe(false);
  });

  it('caps at 25,000 by default', () => {
    expect(WALK_MAX_ENTRIES).toBe(25_000);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test walk
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The cap, borrowed from t3code's `WORKSPACE_INDEX_MAX_ENTRIES`. `useFileTree`
 * holds its `paths` in full, so this is a real ceiling rather than a paging
 * hint.
 */
export const WALK_MAX_ENTRIES = 25_000;

export interface Walked {
  readonly paths: readonly string[];
  /** The cap was hit. The pane must say so rather than show a partial tree silently. */
  readonly truncated: boolean;
}

/**
 * The fallback for a root that is not a git repository.
 *
 * Only `.git` is pruned. There is no gitignore to consult — that is what makes
 * this the fallback rather than the main path — so the cap is the only thing
 * standing between the tree and somebody's home directory.
 */
export function walk(root: string, max: number = WALK_MAX_ENTRIES): Walked {
  const paths: string[] = [];
  let truncated = false;

  const descend = (dir: string, prefix: string): void => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A directory we cannot read is skipped, not fatal: one EACCES should not
      // cost the user the other nine thousand files.
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        descend(join(dir, entry.name), rel);
        if (truncated) return;
        continue;
      }
      if (paths.length >= max) {
        truncated = true;
        return;
      }
      paths.push(rel);
    }
  };

  descend(root, '');
  return { paths, truncated };
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test walk
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/editor/src/walk.ts v2/extensions/editor/src/walk.test.ts
git commit -m "feat(v2/editor): walk a non-git root, pruning .git and capping at 25k"
```

---

## Task 6: The git calls (`src/git.ts`)

**Files:**
- Create: `v2/extensions/editor/src/git.ts`
- Test: `v2/extensions/editor/src/git.test.ts`

**Interfaces:**
- Consumes: `treePaths` (Task 2), `readStatus` (Task 3), `walk` (Task 5).
- Produces:
  ```ts
  interface GitRunner { gitRead(args: readonly string[], opts: { cwd: string; timeoutMs: number }): Promise<ExecOk | ExecErr> }
  function listPaths(git: GitRunner, root: string): Promise<Walked>
  function listStatus(git: GitRunner, root: string): Promise<readonly StatusEntry[]>
  function filePatch(git: GitRunner, root: string, rel: string, untracked: boolean): Promise<string | null>
  ```

The runner is an interface taking only what is used, so the tests are a stub
object and no host.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filePatch, listPaths, listStatus, type GitRunner } from './git.ts';

/** A stub that answers by the first two args, so a test says what git said. */
function runner(answers: Record<string, { stdout: string; ok?: boolean; code?: number }>): GitRunner {
  return {
    gitRead: async (args) => {
      const key = args.slice(0, 2).join(' ');
      const answer = answers[key];
      if (answer === undefined) return { ok: false, code: 128, stdout: '', stderr: `no stub for ${key}` };
      if (answer.ok === false) return { ok: false, code: answer.code ?? 1, stdout: answer.stdout, stderr: '' };
      return { ok: true, stdout: answer.stdout, stderr: '' };
    },
  };
}

const LS_TRACKED = 'ls-files --cached';
const LS_IGNORED = 'ls-files --others';

describe('listPaths', () => {
  it('merges the two ls-files answers', async () => {
    const git = runner({
      [LS_TRACKED]: { stdout: 'a.ts\nsrc/b.ts\n' },
      [LS_IGNORED]: { stdout: '.env\nnode_modules/\n' },
    });
    const walked = await listPaths(git, '/repo');
    expect(walked.paths).toEqual(['.env', 'a.ts', 'src/b.ts']);
    expect(walked.truncated).toBe(false);
  });

  it('falls back to a walk when the root is not a repo', async () => {
    // `git ls-files` outside a repo exits 128. Falling through to the walk is
    // what makes `editor.open <any path>` work at all.
    const root = mkdtempSync(join(tmpdir(), 'editor-git-'));
    try {
      const git = runner({});
      const walked = await listPaths(git, root);
      expect(walked.paths).toEqual([]);
      expect(walked.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('listStatus', () => {
  it('reads the porcelain answer', async () => {
    const git = runner({ 'status --porcelain': { stdout: ' M a.ts\0' } });
    expect(await listStatus(git, '/repo')).toEqual([{ path: 'a.ts', status: 'modified' }]);
  });

  it('is empty rather than throwing when git fails', async () => {
    expect(await listStatus(runner({}), '/repo')).toEqual([]);
  });
});

describe('filePatch', () => {
  it('returns a tracked file diff against HEAD', async () => {
    const patch = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-one\n+two\n';
    const git = runner({ 'diff HEAD': { stdout: patch } });
    expect(await filePatch(git, '/repo', 'a.ts', false)).toBe(patch);
  });

  it('treats --no-index exit 1 as SUCCESS for an untracked file', async () => {
    // `git diff` exits 1 when there ARE differences, which for an untracked
    // file is always. Reading that as a failure means new files never render.
    const patch = 'diff --git a/new.ts b/new.ts\nnew file mode 100644\n@@ -0,0 +1 @@\n+one\n';
    const git = runner({ 'diff --no-index': { stdout: patch, ok: false, code: 1 } });
    expect(await filePatch(git, '/repo', 'new.ts', true)).toBe(patch);
  });

  it('is null when there is genuinely no diff', async () => {
    const git = runner({ 'diff HEAD': { stdout: '' } });
    expect(await filePatch(git, '/repo', 'a.ts', false)).toBeNull();
  });

  it('is null when git fails with no output', async () => {
    const git = runner({ 'diff HEAD': { stdout: '', ok: false, code: 128 } });
    expect(await filePatch(git, '/repo', 'a.ts', false)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test git
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { ExecErr, ExecOk } from '@shepherd/sdk';
import { treePaths } from './paths.ts';
import { readStatus, type StatusEntry } from './status.ts';
import { walk, type Walked } from './walk.ts';

/**
 * Only the method used, so a test is an object literal.
 *
 * `gitRead` and never `exec`: it sets `GIT_OPTIONAL_LOCKS=0`, and a plain
 * `git status` through `exec` rewrites `.git/index` — which in v1 woke the
 * watcher that had just run it.
 */
export interface GitRunner {
  gitRead(
    args: readonly string[],
    opts: { readonly cwd: string; readonly timeoutMs: number },
  ): Promise<ExecOk | ExecErr>;
}

const LIST_MS = 10_000;
const DIFF_MS = 20_000;

/**
 * The tree's paths for one root.
 *
 * Two calls, because git draws the ignored-file / ignored-directory line and we
 * do not (`paths.ts` says why). A root that is not a repository fails both and
 * falls through to the walk.
 */
export async function listPaths(git: GitRunner, root: string): Promise<Walked> {
  const opts = { cwd: root, timeoutMs: LIST_MS };
  const [tracked, ignored] = await Promise.all([
    git.gitRead(['ls-files', '--cached', '--others', '--exclude-standard'], opts),
    git.gitRead(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], opts),
  ]);

  // `git ls-files` outside a repository exits 128. Only the FIRST call decides:
  // a repo with no ignored entries at all is a normal repo, not a non-repo.
  if (!tracked.ok) return walk(root);

  return {
    paths: treePaths(tracked.stdout, ignored.ok ? ignored.stdout : ''),
    truncated: false,
  };
}

/** The marks, or none. A failure here costs decoration, never the tree. */
export async function listStatus(git: GitRunner, root: string): Promise<readonly StatusEntry[]> {
  const result = await git.gitRead(['status', '--porcelain', '-z'], {
    cwd: root,
    timeoutMs: LIST_MS,
  });
  return result.ok ? readStatus(result.stdout) : [];
}

/**
 * One file's patch.
 *
 * An untracked file has nothing in `HEAD` to diff against, so it goes through
 * `--no-index` from `/dev/null`, which produces a real all-added patch with the
 * `new file mode` line — better than synthesising one, because git writes the
 * header the renderer wants.
 *
 * **`git diff` exits 1 when there ARE differences**, which for `--no-index`
 * against `/dev/null` is always. So a non-ok result with output is the success
 * case here, and reading `ok` alone would mean no new file ever renders.
 */
export async function filePatch(
  git: GitRunner,
  root: string,
  rel: string,
  untracked: boolean,
): Promise<string | null> {
  const args = untracked
    ? ['diff', '--no-index', '--', '/dev/null', rel]
    : ['diff', 'HEAD', '--', rel];
  const result = await git.gitRead(args, { cwd: root, timeoutMs: DIFF_MS });
  const out = result.stdout;
  return out === '' ? null : out;
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test git
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/editor/src/git.ts v2/extensions/editor/src/git.test.ts
git commit -m "feat(v2/editor): the git reads behind the tree, its marks and its diffs"
```

---

## Task 7: `activate` — the view type and the commands (`src/index.ts`)

**Files:**
- Modify: `v2/extensions/editor/src/index.ts`
- Test: `v2/extensions/editor/src/index.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6.
- Produces the command contract the UI half calls:
  ```
  editor.tree    { root }              → { paths: string[], status: StatusEntry[], truncated: boolean }
  editor.read    { root, path }        → { text, stamp } | { ok: false, reason }
  editor.write   { root, path, text, stamp } → { stamp } | { ok: false, reason: 'stale' | string }
  editor.changes { root }              → { entries: StatusEntry[] }
  editor.diff    { root, path, untracked } → { patch: string | null }
  editor.open    { task?, path? }      → { ok: true } | { ok: false, reason }
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { activate } from './index.ts';
import { EDITOR_COMMANDS, EDITOR_VIEWS } from './manifest.ts';

/**
 * A host stub: the two API surfaces `activate` touches, and a registry the test
 * reads back. Enough to assert the contract without a kernel.
 */
function host() {
  const registered = new Map<string, { handler: (args: never) => unknown }>();
  const views: Array<{ type: string; contribution: Record<string, unknown> }> = [];
  const api = {
    proposed: {
      commands: {
        register: (id: string, spec: { handler: (args: never) => unknown }) => {
          registered.set(id, spec);
          return { dispose: () => {} };
        },
        invoke: vi.fn(async () => ({ ok: true, value: [] })),
      },
      views: {
        registerViewType: (type: string, contribution: Record<string, unknown>) => {
          views.push({ type, contribution });
          return { dispose: () => {} };
        },
      },
      process: { gitRead: vi.fn(async () => ({ ok: true, stdout: '', stderr: '' })) },
      extensions: { get: () => undefined },
    },
  };
  const ctx = {
    subscriptions: [] as Array<{ dispose: () => void }>,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { api, ctx, registered, views };
}

describe('activate', () => {
  it('registers the workspace view as a PANE', () => {
    const { api, ctx, views } = host();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    activate(ctx as any, api as any);
    const view = views.find((entry) => entry.type === EDITOR_VIEWS.workspace);
    expect(view).toBeDefined();
    // A place you keep open and come back to after a relaunch (ADR 0044) — not
    // a dock section and not an overlay.
    expect(view?.contribution.surface).toBe('pane');
    expect(view?.contribution.component).toBe(EDITOR_VIEWS.workspace);
  });

  it('registers every command the manifest contributes', () => {
    const { api, ctx, registered } = host();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    activate(ctx as any, api as any);
    for (const id of Object.values(EDITOR_COMMANDS)) {
      expect(registered.has(id)).toBe(true);
    }
  });

  it('editor.write reports a stale save as a refusal, not a throw', async () => {
    const { api, ctx, registered } = host();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    activate(ctx as any, api as any);
    const write = registered.get(EDITOR_COMMANDS.write);
    const answer = await write?.handler({
      root: '/nonexistent-root-for-this-test',
      path: '../escape.ts',
      text: 'x',
      stamp: { mtimeMs: 0, size: 0 },
    } as never);
    expect(answer).toMatchObject({ ok: false });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test index
```

Expected: FAIL — no view registered, no commands registered.

- [ ] **Step 3: Implement `src/index.ts`**

```ts
import { s, type ActivateFn } from '@shepherd/sdk';
import { EDITOR_COMMANDS, EDITOR_VIEWS, TAB_TITLE } from './manifest.ts';
import { filePatch, listPaths, listStatus } from './git.ts';
import { readFileAt, writeFileAt } from './files.ts';

/**
 * `layout.newTab` and `layout.listRoots`, named here rather than imported:
 * values do not cross between packages (`boundaries.js`), so a command id is
 * re-stated and only types travel. The convention `scratch` and `github` follow.
 */
const LAYOUT_NEW_TAB = 'layout.newTab';
const LAYOUT_LIST_ROOTS = 'layout.listRoots';

const STAMP = s.object({ mtimeMs: s.number(), size: s.number() });

export const activate: ActivateFn = (ctx, api) => {
  const { commands, views, process } = api.proposed;

  ctx.subscriptions.push(
    views.registerViewType(EDITOR_VIEWS.workspace, {
      kind: 'component',
      component: EDITOR_VIEWS.workspace,
      /*
       * A PANE (ADR 0044): it has a subject, you keep it open while you work,
       * and you come back to it after a relaunch — which is what a dock section
       * and an overlay are not.
       */
      surface: 'pane',
      title: TAB_TITLE,
      /*
       * The tab's glyph, in the slot a terminal tab draws its agent state in. A
       * view pane has no agent and so no state; the glyph is a NAME resolved by
       * the renderer's allow-list (ADR 0033), never a component.
       */
      icon: 'file',
    }),
  );

  ctx.subscriptions.push(
    commands.register(EDITOR_COMMANDS.tree, {
      schema: s.object({ root: s.string() }),
      handler: async (args) => {
        const [walked, status] = await Promise.all([
          listPaths(process, args.root),
          listStatus(process, args.root),
        ]);
        return { paths: walked.paths, truncated: walked.truncated, status };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(EDITOR_COMMANDS.read, {
      schema: s.object({ root: s.string(), path: s.string() }),
      handler: (args) => {
        const read = readFileAt(args.root, args.path);
        if ('error' in read) return { ok: false, reason: read.error };
        return { text: read.text, stamp: read.stamp };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(EDITOR_COMMANDS.write, {
      schema: s.object({
        root: s.string(),
        path: s.string(),
        text: s.string(),
        stamp: STAMP,
      }),
      handler: (args) => {
        const wrote = writeFileAt(args.root, args.path, args.text, args.stamp);
        if ('error' in wrote) return { ok: false, reason: wrote.error };
        return { stamp: wrote.stamp };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(EDITOR_COMMANDS.changes, {
      schema: s.object({ root: s.string() }),
      handler: async (args) => ({ entries: await listStatus(process, args.root) }),
    }),
  );

  ctx.subscriptions.push(
    commands.register(EDITOR_COMMANDS.diff, {
      schema: s.object({ root: s.string(), path: s.string(), untracked: s.boolean() }),
      handler: async (args) => ({
        patch: await filePatch(process, args.root, args.path, args.untracked),
      }),
    }),
  );

  ctx.subscriptions.push(
    commands.register(EDITOR_COMMANDS.open, {
      title: 'Editor: Open',
      schema: s.object({ path: s.optional(s.string()) }),
      /**
       * Open the editor tab, or go to the one that is already open.
       *
       * The existing tab is found by asking the LAYOUT what it holds rather
       * than by remembering what we opened: a record of our own would be wrong
       * the moment the user closed the tab, and wrong again across a relaunch.
       * `github.review` established this.
       */
      handler: async (args) => {
        const root = args.path ?? ctx.cwd;
        if (root === undefined) return { ok: false, reason: 'no path, and no cwd to fall back on' };

        const listed = await commands.invoke(LAYOUT_LIST_ROOTS, {});
        const existing = listed.ok ? findEditorPane(listed.value, root) : undefined;
        if (existing !== undefined) {
          const focused = await commands.invoke('layout.focus', { pane: existing });
          if (focused.ok) return { ok: true };
        }

        const created = await commands.invoke(LAYOUT_NEW_TAB, {
          view: { type: EDITOR_VIEWS.workspace, state: { root } },
          // Without this the tab reads `term`: a view pane runs no program, so
          // nothing ever sets an OSC title on it.
          title: TAB_TITLE,
        });
        return created.ok ? { ok: true } : { ok: false, reason: created.error.message };
      },
    }),
  );
};

/**
 * The pane already showing this root, if there is one.
 *
 * `unknown` all the way down: this crossed the port, and `ok` says a call
 * succeeded, never that a value has a shape. A row that does not read is
 * skipped rather than defaulted — an invented pane id would focus somebody
 * else's tab.
 */
function findEditorPane(roots: unknown, root: string): string | undefined {
  if (!Array.isArray(roots)) return undefined;
  for (const entry of roots) {
    if (typeof entry !== 'object' || entry === null) continue;
    const panes = (entry as { panes?: unknown }).panes;
    if (!Array.isArray(panes)) continue;
    for (const leaf of panes) {
      if (typeof leaf !== 'object' || leaf === null) continue;
      const row = leaf as { pane?: unknown; view?: unknown };
      if (typeof row.pane !== 'string') continue;
      const view = row.view;
      if (typeof view !== 'object' || view === null) continue;
      const shape = view as { type?: unknown; state?: unknown };
      if (shape.type !== EDITOR_VIEWS.workspace) continue;
      const state = shape.state;
      if (typeof state !== 'object' || state === null) continue;
      if ((state as { root?: unknown }).root === root) return row.pane;
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run the test**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test index
```

Expected: PASS, 3 tests. If `ctx.cwd` does not exist on `ExtensionContext`, replace that fallback with `{ ok: false, reason: 'no path given' }` and adjust the test — check `packages/sdk/src/api.ts` for the actual field before assuming.

- [ ] **Step 5: Run the whole suite and typecheck**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test && pnpm --filter @shepherd/ext-editor typecheck
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add v2/extensions/editor/src/index.ts v2/extensions/editor/src/index.test.ts
git commit -m "feat(v2/editor): activate — the workspace pane type and its commands"
```

---

## Task 8: The pane shell — tree beside a panel (`ui/editor-pane.tsx`)

**Files:**
- Create: `v2/extensions/editor/ui/diff-theme.ts`, `ui/editor-pane.tsx`, `ui/editor-pane.css`
- Modify: `v2/extensions/editor/ui/index.ts`
- Test: `v2/extensions/editor/ui/editor-pane.test.tsx`

**Interfaces:**
- Consumes: `EDITOR_COMMANDS` (Task 1), the command contract (Task 7), `ExtensionPaneProps` from `@shepherd/sdk`.
- Produces: `EditorPane: ComponentType<ExtensionPaneProps>`, `readEditorState(state: unknown): { root: string; doc?: string } | undefined`

- [ ] **Step 1: Copy the diff theme**

```bash
cd v2
cp extensions/github/ui/diff-theme.ts extensions/editor/ui/diff-theme.ts
```

Then add this note at the top of the copy, above the existing doc comment:

```ts
/*
 * A COPY of `extensions/github/ui/diff-theme.ts`, deliberately.
 *
 * The boundary lint forbids one extension importing another's `ui/`
 * (`extensions/README.md`), and two consumers is not yet a package. **A THIRD
 * consumer promotes this** — into a shared home, with both copies deleted. If
 * you are the third, do that instead of copying it again.
 */
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { readEditorState } from './editor-pane.tsx';

describe('readEditorState', () => {
  it('reads a root', () => {
    expect(readEditorState({ root: '/repo' })).toEqual({ root: '/repo', doc: undefined });
  });

  it('reads the document that was open', () => {
    expect(readEditorState({ root: '/repo', doc: 'src/a.ts' })).toEqual({
      root: '/repo',
      doc: 'src/a.ts',
    });
  });

  it('is undefined for a state with no root', () => {
    // `state` crossed a port and reaches the component as `unknown` (ADR 0044).
    // A pane with no root has nothing to list, and inventing one would open the
    // tree somewhere the user never asked for.
    expect(readEditorState({})).toBeUndefined();
    expect(readEditorState(null)).toBeUndefined();
    expect(readEditorState('/repo')).toBeUndefined();
    expect(readEditorState({ root: 42 })).toBeUndefined();
  });

  it('ignores a non-string doc rather than refusing the pane', () => {
    // The root is the subject; the doc is a convenience. Losing the second is
    // not worth losing the first.
    expect(readEditorState({ root: '/repo', doc: 7 })).toEqual({ root: '/repo', doc: undefined });
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test editor-pane
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `ui/editor-pane.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { FileTree, useFileTree, useFileTreeSelection, useFileTreeSearch } from '@pierre/trees/react';
import { SVGSpriteSheet } from '@pierre/diffs';
import type { ExtensionPaneProps } from '@shepherd/sdk';
import { EDITOR_COMMANDS } from '../src/manifest.ts';
import type { StatusEntry } from '../src/status.ts';
import { FileEditor } from './file-editor.tsx';
import { Changes } from './changes.tsx';
import './editor-pane.css';

/** What this pane was opened to show. `unknown`: it crossed a port (ADR 0044). */
export interface EditorState {
  readonly root: string;
  readonly doc: string | undefined;
}

export function readEditorState(state: unknown): EditorState | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const shape = state as { root?: unknown; doc?: unknown };
  if (typeof shape.root !== 'string' || shape.root === '') return undefined;
  return { root: shape.root, doc: typeof shape.doc === 'string' ? shape.doc : undefined };
}

interface Tree {
  readonly paths: readonly string[];
  readonly status: readonly StatusEntry[];
  readonly truncated: boolean;
}

function readTree(value: unknown): Tree {
  if (typeof value !== 'object' || value === null) return { paths: [], status: [], truncated: false };
  const shape = value as { paths?: unknown; status?: unknown; truncated?: unknown };
  return {
    paths: Array.isArray(shape.paths) ? shape.paths.filter((p): p is string => typeof p === 'string') : [],
    status: Array.isArray(shape.status) ? (shape.status as readonly StatusEntry[]) : [],
    truncated: shape.truncated === true,
  };
}

export function EditorPane({ state, focused, invoke }: ExtensionPaneProps): ReactElement {
  const subject = readEditorState(state);
  const [tree, setTree] = useState<Tree>({ paths: [], status: [], truncated: false });
  const [mode, setMode] = useState<'edit' | 'changes'>('edit');
  const [at, setAt] = useState<string | undefined>(subject?.doc);

  const root = subject?.root;

  const refresh = useCallback(async () => {
    if (root === undefined) return;
    const answer = await invoke(EDITOR_COMMANDS.tree, { root });
    if (answer.ok) setTree(readTree(answer.value));
  }, [invoke, root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const paths = useMemo(() => tree.paths, [tree.paths]);
  /*
   * Pierre's tree, not a list of buttons. `compact` is the package's own density
   * preset, and asking for it is the supported way: that value is written INLINE
   * on the host from this option, so a `--trees-item-height` in our stylesheet
   * is silently outranked.
   */
  const model = useFileTree({ paths, density: 'compact' });
  const selected = useFileTreeSelection(model.model);
  /* The package's own filter. A control, not a second code path. */
  const search = useFileTreeSearch(model.model);

  /*
   * The marks are the PACKAGE's, not ours: `setGitStatus` is how a row learns it
   * is modified, and drawing our own beside it would be two vocabularies for one
   * fact.
   */
  useEffect(() => {
    model.model.setGitStatus(tree.status);
  }, [model.model, tree.status]);

  useEffect(() => {
    const first = selected[0];
    if (first !== undefined) setAt(first);
  }, [selected]);

  if (subject === undefined) {
    return <div className="sh-editor sh-editor--none">This pane has no root to open.</div>;
  }

  return (
    <div className="sh-editor" data-mode={mode}>
      <SVGSpriteSheet />
      <div className="sh-editor__rail">
        <div className="sh-editor__modes">
          <button type="button" data-on={mode === 'edit'} onClick={() => setMode('edit')}>
            Files
          </button>
          <button type="button" data-on={mode === 'changes'} onClick={() => setMode('changes')}>
            Changes
          </button>
        </div>
        <FileTree className="sh-editor__tree" model={model.model} />
        {tree.truncated ? (
          /*
           * A truncated listing that does not announce itself reads as a
           * complete one, and the file you wanted is absent with no explanation.
           */
          <p className="sh-editor__truncated">Too many files to list them all.</p>
        ) : null}
      </div>
      <div className="sh-editor__panel">
        {mode === 'changes' ? (
          <Changes root={subject.root} status={tree.status} invoke={invoke} at={at} />
        ) : at === undefined ? (
          <p className="sh-editor__empty">Pick a file.</p>
        ) : (
          <FileEditor
            root={subject.root}
            path={at}
            focused={focused}
            invoke={invoke}
            onSaved={refresh}
          />
        )}
      </div>
    </div>
  );
}

/** Suppress the unused warning until search is wired to a field in a follow-up. */
void useFileTreeSearch;
void search;
```

**Note for the implementer:** the `void search` line at the bottom is a
placeholder for the search input, which Task 10 wires up. Delete both `void`
lines when you get there. If `useFileTreeSearch` has a different signature than
`(model)`, check `node_modules/@pierre/trees/dist/react/useFileTreeSearch.d.ts`
and follow it — `t3code`'s `FileBrowserPanel.tsx` is a working call site.

- [ ] **Step 5: Write `ui/editor-pane.css`**

```css
/*
 * A view pane gets no head, no padding and no border from the shell (ADR 0044) —
 * the view owns the rectangle, so the two panels and the seam between them are
 * this file's job.
 */
.sh-editor {
  display: grid;
  grid-template-columns: minmax(180px, 260px) 1fr;
  height: 100%;
  min-height: 0;
  background: var(--sh-canvas);
  overflow: hidden;
}

.sh-editor__rail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--sh-border);
  overflow: hidden;
}

.sh-editor__modes {
  display: flex;
  gap: 2px;
  padding: 6px;
  border-bottom: 1px solid var(--sh-border);
}

.sh-editor__modes button {
  flex: 1;
  padding: 4px 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--sh-text-dim);
  font: inherit;
  cursor: pointer;
}

.sh-editor__modes button[data-on='true'] {
  background: var(--sh-surface);
  color: var(--sh-text);
}

.sh-editor__tree {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.sh-editor__truncated,
.sh-editor__empty,
.sh-editor--none {
  padding: 12px;
  color: var(--sh-text-dim);
}

.sh-editor__panel {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--sh-surface);
}
```

- [ ] **Step 6: Write `ui/index.ts`**

```ts
export { EditorPane, readEditorState } from './editor-pane.tsx';
```

- [ ] **Step 7: Run the test**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test editor-pane
```

Expected: PASS, 4 tests. Tasks 9 and 10 create `file-editor.tsx` and
`changes.tsx`; until they exist this file will not typecheck. Create both as
one-line stubs now so the suite runs:

```tsx
// ui/file-editor.tsx — replaced in Task 9
export function FileEditor(_: Record<string, unknown>) { return null; }
```
```tsx
// ui/changes.tsx — replaced in Task 10
export function Changes(_: Record<string, unknown>) { return null; }
```

- [ ] **Step 8: Commit**

```bash
git add v2/extensions/editor/ui
git commit -m "feat(v2/editor): the pane shell — Pierre's tree beside a panel"
```

---

## Task 9: The editor (`ui/file-editor.tsx`)

**Files:**
- Create (replacing the stub): `v2/extensions/editor/ui/file-editor.tsx`
- Test: `v2/extensions/editor/ui/file-editor.test.tsx`

**Interfaces:**
- Consumes: `editor.read` / `editor.write` (Task 7), `SHEPHERD_DIFF_THEME` / `SHEPHERD_DIFF_CSS` (Task 8).
- Produces: `FileEditor`, and the pure helper `saveOutcome(answer: unknown): 'saved' | 'stale' | string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { saveOutcome } from './file-editor.tsx';

describe('saveOutcome', () => {
  it('is saved when a fresh stamp comes back', () => {
    expect(saveOutcome({ stamp: { mtimeMs: 1, size: 2 } })).toBe('saved');
  });

  it('is stale when the file moved under us', () => {
    // The case an agent editing the same worktree produces, and the reason the
    // pane does not autosave.
    expect(saveOutcome({ ok: false, reason: 'stale' })).toBe('stale');
  });

  it('passes any other refusal through as its message', () => {
    expect(saveOutcome({ ok: false, reason: 'EACCES: permission denied' })).toBe(
      'EACCES: permission denied',
    );
  });

  it('does not report success for a shape it cannot read', () => {
    // `ok` says a call succeeded, never that a value has a shape.
    expect(saveOutcome(undefined)).not.toBe('saved');
    expect(saveOutcome({})).not.toBe('saved');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test file-editor
```

Expected: FAIL — `saveOutcome` is not exported.

- [ ] **Step 3: Implement**

```tsx
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { EditProvider, File, Virtualizer, useCreateEditor } from '@pierre/diffs/react';
import type { Result } from '@shepherd/sdk';
import { EDITOR_COMMANDS } from '../src/manifest.ts';
import { SHEPHERD_DIFF_CSS, SHEPHERD_DIFF_THEME } from './diff-theme.ts';

interface Stamp {
  readonly mtimeMs: number;
  readonly size: number;
}

/**
 * What a save answered.
 *
 * A separate pure function because it is the one branch worth asserting without
 * a DOM: `stale` is not an error the user caused, and reporting it as one
 * ("could not save") loses the only useful part — that somebody else's version
 * is on disk and can be reloaded.
 */
export function saveOutcome(answer: unknown): 'saved' | 'stale' | string {
  if (typeof answer !== 'object' || answer === null) return 'could not save';
  const shape = answer as { stamp?: unknown; reason?: unknown };
  if (typeof shape.stamp === 'object' && shape.stamp !== null) return 'saved';
  if (typeof shape.reason === 'string') return shape.reason === 'stale' ? 'stale' : shape.reason;
  return 'could not save';
}

function readDoc(value: unknown): { text: string; stamp: Stamp } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const shape = value as { text?: unknown; stamp?: unknown };
  if (typeof shape.text !== 'string') return undefined;
  const stamp = shape.stamp as { mtimeMs?: unknown; size?: unknown } | undefined;
  if (typeof stamp?.mtimeMs !== 'number' || typeof stamp.size !== 'number') return undefined;
  return { text: shape.text, stamp: { mtimeMs: stamp.mtimeMs, size: stamp.size } };
}

export interface FileEditorProps {
  readonly root: string;
  readonly path: string;
  readonly focused: boolean;
  invoke(command: string, args?: unknown): Promise<Result<unknown, { code: string; message: string }>>;
  onSaved(): void;
}

export function FileEditor({ root, path, focused, invoke, onSaved }: FileEditorProps): ReactElement {
  const [doc, setDoc] = useState<{ text: string; stamp: Stamp } | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  /* The live buffer, in a ref: it changes on every keystroke and nothing renders from it. */
  const buffer = useRef('');
  const stamp = useRef<Stamp>({ mtimeMs: 0, size: 0 });

  const load = useCallback(async () => {
    const answer = await invoke(EDITOR_COMMANDS.read, { root, path });
    const read = answer.ok ? readDoc(answer.value) : undefined;
    if (read === undefined) {
      setNote('Could not read this file.');
      setDoc(undefined);
      return;
    }
    buffer.current = read.text;
    stamp.current = read.stamp;
    setDoc(read);
    setDirty(false);
    setNote(undefined);
  }, [invoke, root, path]);

  useEffect(() => {
    void load();
  }, [load]);

  const editor = useCreateEditor({
    onChange: (file: { contents: string }) => {
      buffer.current = file.contents;
      setDirty(true);
    },
  });

  const save = useCallback(async () => {
    const answer = await invoke(EDITOR_COMMANDS.write, {
      root,
      path,
      text: buffer.current,
      stamp: stamp.current,
    });
    const outcome = saveOutcome(answer.ok ? answer.value : undefined);
    if (outcome === 'saved') {
      const fresh = answer.ok ? (answer.value as { stamp: Stamp }).stamp : stamp.current;
      stamp.current = fresh;
      setDirty(false);
      setNote(undefined);
      onSaved();
      return;
    }
    setNote(
      outcome === 'stale'
        ? 'This file changed on disk — reload to see it. Your edits are still here.'
        : outcome,
    );
  }, [invoke, root, path, onSaved]);

  /*
   * ⌘S, and only while this pane is FOCUSED (ADR 0044): a background pane that
   * still answered the key would fight the one you are looking at.
   *
   * Not autosave. `scratch` debounces at 400ms and t3code does the same, and
   * both are right for what they hold — but an AGENT is editing these files
   * while you are, and a debounced write would overwrite its work without
   * either of you seeing it happen.
   */
  useEffect(() => {
    if (!focused) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 's' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      void save();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, save]);

  const file = useMemo(
    () =>
      doc === undefined
        ? undefined
        : { name: path, contents: doc.text, cacheKey: `${root}:${path}:${doc.stamp.mtimeMs}` },
    [doc, root, path],
  );

  if (file === undefined) {
    return <p className="sh-editor__empty">{note ?? 'Loading…'}</p>;
  }

  return (
    <div className="sh-editor__file">
      <header className="sh-editor__file-head">
        <span>{path}</span>
        {dirty ? <span className="sh-editor__dirty" aria-label="unsaved">●</span> : null}
      </header>
      {note === undefined ? null : <p className="sh-editor__note">{note} <button type="button" onClick={() => void load()}>Reload</button></p>}
      <EditProvider editor={editor}>
        <Virtualizer className="sh-editor__scroll">
          <File
            file={file}
            /*
             * `edit`, not `contentEditable`: renamed in @pierre/diffs 1.3.5,
             * with editor configuration moved to `editorOptions`. t3code pins
             * 1.3.0-beta.10 and still uses the old name — do not copy it.
             */
            edit
            options={{
              disableFileHeader: true,
              theme: SHEPHERD_DIFF_THEME,
              unsafeCSS: SHEPHERD_DIFF_CSS,
              overflow: 'scroll',
            }}
          />
        </Virtualizer>
      </EditProvider>
    </div>
  );
}
```

- [ ] **Step 4: Run the test**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test file-editor
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck, and reconcile with the real Pierre types**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor typecheck
```

If `useCreateEditor`'s option shape or `File`'s `options` differ, read
`node_modules/@pierre/diffs/dist/react/EditContext.d.ts` and
`dist/components/File.d.ts` and follow them exactly. The two reference call
sites are `extensions/github/ui/pr-panels.tsx` (options and theme) and
`t3code/apps/web/src/components/files/FilePreviewPanel.tsx` (the edit half).

- [ ] **Step 6: Commit**

```bash
git add v2/extensions/editor/ui/file-editor.tsx v2/extensions/editor/ui/file-editor.test.tsx
git commit -m "feat(v2/editor): the editor — Pierre's <File edit>, saved with cmd-S"
```

---

## Task 10: The changes view (`ui/changes.tsx`)

**Files:**
- Create (replacing the stub): `v2/extensions/editor/ui/changes.tsx`
- Test: `v2/extensions/editor/ui/changes.test.tsx`

**Interfaces:**
- Consumes: `editor.diff` (Task 7), `StatusEntry` (Task 3).
- Produces: `Changes`, and `changedPaths(status: readonly StatusEntry[]): readonly StatusEntry[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { changedPaths } from './changes.tsx';

describe('changedPaths', () => {
  it('keeps everything that differs from HEAD', () => {
    const status = [
      { path: 'a.ts', status: 'modified' },
      { path: 'b.ts', status: 'untracked' },
      { path: 'c.ts', status: 'added' },
    ] as const;
    expect(changedPaths(status).map((entry) => entry.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('drops deleted files — there is no buffer to show and no file to open', () => {
    const status = [
      { path: 'gone.ts', status: 'deleted' },
      { path: 'a.ts', status: 'modified' },
    ] as const;
    expect(changedPaths(status).map((entry) => entry.path)).toEqual(['a.ts']);
  });

  it('is empty for a clean tree', () => {
    expect(changedPaths([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test changes
```

Expected: FAIL — `changedPaths` is not exported.

- [ ] **Step 3: Implement**

```tsx
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react';
import { processFile } from '@pierre/diffs';
import type { Result } from '@shepherd/sdk';
import { EDITOR_COMMANDS } from '../src/manifest.ts';
import type { StatusEntry } from '../src/status.ts';
import { SHEPHERD_DIFF_CSS, SHEPHERD_DIFF_THEME } from './diff-theme.ts';

/**
 * What the changes view has something to draw for.
 *
 * A DELETED file is dropped: there is no buffer to show and nothing to open,
 * and a row you cannot click is a row that only reports its own uselessness.
 * The terminal is one pane away for `git show`.
 */
export function changedPaths(status: readonly StatusEntry[]): readonly StatusEntry[] {
  return status.filter((entry) => entry.status !== 'deleted');
}

function readPatch(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const patch = (value as { patch?: unknown }).patch;
  return typeof patch === 'string' && patch !== '' ? patch : null;
}

export interface ChangesProps {
  readonly root: string;
  readonly status: readonly StatusEntry[];
  readonly at: string | undefined;
  invoke(command: string, args?: unknown): Promise<Result<unknown, { code: string; message: string }>>;
}

export function Changes({ root, status, at, invoke }: ChangesProps): ReactElement {
  const entries = useMemo(() => changedPaths(status), [status]);
  const [patches, setPatches] = useState<ReadonlyMap<string, string>>(new Map());
  const viewer = useRef<CodeViewHandle<never> | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const pairs = await Promise.all(
        entries.map(async (entry) => {
          const answer = await invoke(EDITOR_COMMANDS.diff, {
            root,
            path: entry.path,
            // An untracked file has nothing in HEAD to diff against, so the
            // service half runs `--no-index` from /dev/null instead.
            untracked: entry.status === 'untracked',
          });
          return [entry.path, answer.ok ? readPatch(answer.value) : null] as const;
        }),
      );
      if (!live) return;
      setPatches(new Map(pairs.filter((pair): pair is readonly [string, string] => pair[1] !== null)));
    })();
    return () => {
      live = false;
    };
  }, [entries, invoke, root]);

  const items = useMemo(
    () =>
      entries.flatMap((entry) => {
        const patch = patches.get(entry.path);
        if (patch === undefined) return [];
        /*
         * `processFile` rather than `parsePatchFiles`: we already hold one patch
         * per file, so there is nothing to split. The same call
         * `extensions/github/ui/pr-panels.tsx` makes.
         */
        return [{ id: entry.path, ...processFile(patch, { cacheKey: `${root}:${entry.path}`, isGitDiff: true }) }];
      }),
    [entries, patches, root],
  );

  /*
   * The tree JUMPS rather than selects — every changed file is on screen in one
   * scroll, so clicking a path is a request to be taken to it, not a request to
   * be shown it instead of the others. The Files tab of the review pane does
   * the same, for the same reason.
   */
  useEffect(() => {
    if (at === undefined) return;
    viewer.current?.scrollTo({ type: 'item', id: at, align: 'start' });
  }, [at]);

  if (entries.length === 0) {
    return <p className="sh-editor__empty">Nothing has changed against HEAD.</p>;
  }

  return (
    <CodeView
      ref={viewer}
      items={items}
      options={{ theme: SHEPHERD_DIFF_THEME, unsafeCSS: SHEPHERD_DIFF_CSS }}
    />
  );
}
```

- [ ] **Step 4: Run the test**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test changes
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Reconcile `CodeView`'s props with the real ones**

`extensions/github/ui/pr-panels.tsx:649` is a working `CodeView` call site in
this repo at this exact version. Read it and match its prop names and item
shape; the sketch above is the shape, not necessarily the spelling.

```bash
cd v2 && sed -n '640,700p' extensions/github/ui/pr-panels.tsx
pnpm --filter @shepherd/ext-editor typecheck
```

- [ ] **Step 6: Wire the tree's search field**

Delete the two `void` lines at the bottom of `ui/editor-pane.tsx` and add the
input above the tree:

```tsx
<input
  className="sh-editor__search"
  type="search"
  placeholder="Filter files"
  value={search.query}
  onChange={(event) => search.setQuery(event.target.value)}
/>
```

Match `useFileTreeSearch`'s actual returned shape — read
`node_modules/@pierre/trees/dist/react/useFileTreeSearch.d.ts`; t3code's
`FileBrowserPanel.tsx` is a working call site.

- [ ] **Step 7: Run everything**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test && pnpm --filter @shepherd/ext-editor typecheck
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add v2/extensions/editor/ui
git commit -m "feat(v2/editor): the changes view — your working tree against HEAD"
```

---

## Task 11: Register the extension with the app

**Files:**
- Modify: `v2/packages/app/package.json`, `v2/packages/app/src/main/index.ts`, `v2/packages/app/src/renderer/extension-ui.ts`
- Test: `v2/packages/app/src/renderer/extension-ui.test.ts` (create if absent)

**Interfaces:**
- Consumes: `manifest` and `EDITOR_VIEWS` from `@shepherd/ext-editor/manifest`, `EditorPane` from `@shepherd/ext-editor/ui`.
- Produces: a running tab.

- [ ] **Step 1: Add the dependency**

In `v2/packages/app/package.json`, add to `dependencies`, alphabetically between
`@shepherd/ext-diagnostics` and `@shepherd/ext-github`:

```json
"@shepherd/ext-editor": "workspace:*",
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { EXTENSION_PANE_UI, resolveExtensionPaneUi } from './extension-ui.ts';

describe('EXTENSION_PANE_UI', () => {
  it('resolves the editor workspace pane', () => {
    // A persisted `view` on disk names a REGISTERED TYPE, and the renderer
    // resolves that contribution's `component` against this table (ADR 0044).
    // A name missing here draws "waiting for whoever draws this" forever.
    expect(EXTENSION_PANE_UI['editor.workspace']).toBeDefined();
    expect(resolveExtensionPaneUi('editor.workspace')).toBeDefined();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd v2 && pnpm --filter @shepherd/app test extension-ui
```

Expected: FAIL — `undefined`.

- [ ] **Step 4: Register the pane component**

In `v2/packages/app/src/renderer/extension-ui.ts`, add the import beside the
other pane imports and the entry to the table:

```ts
import { EditorPane } from '@shepherd/ext-editor/ui';
```

```ts
export const EXTENSION_PANE_UI: Readonly<Record<string, ComponentType<ExtensionPaneProps>>> = {
  'editor.workspace': EditorPane,
  'github.review': ReviewPane,
  'scratch.pad': ScratchPane,
};
```

- [ ] **Step 5: Register the manifest in main**

Find where `@shepherd/ext-scratch/manifest` is imported and registered in
`v2/packages/app/src/main/index.ts`, and add the editor's the same way:

```bash
cd v2 && grep -n "ext-scratch/manifest" -B 4 -A 4 packages/app/src/main/index.ts
```

Follow that pattern exactly — do not invent a second registration style.

- [ ] **Step 6: Install, test, typecheck**

```bash
cd v2 && pnpm install && pnpm --filter @shepherd/app test extension-ui && pnpm --filter @shepherd/app typecheck
```

Expected: green.

- [ ] **Step 7: Run the app and open the tab**

```bash
cd v2 && pnpm --filter @shepherd/app dev
```

In the app: open the command palette, run **Editor: Open**. Verify by hand —
this is the part no unit test reaches:

1. The tree lists the repo's files.
2. **`.env` is in the tree** (create one if the repo has none) and
   **`node_modules` is not**.
3. Clicking a file shows it, highlighted, and typing marks the tab dirty.
4. ⌘S saves; check the file on disk in a terminal.
5. Edit the same file from a terminal, then ⌘S in the pane — **it must refuse**
   and offer a reload, and the terminal's version must still be on disk.
6. Modify a file, switch to **Changes** — the diff renders in the same colours
   as the review tab.
7. Create a new untracked file — it appears in Changes as all-additions.
8. Close the tab, relaunch the app — the tab comes back on the same root.

- [ ] **Step 8: Commit**

```bash
git add v2/packages/app v2/pnpm-lock.yaml
git commit -m "feat(v2/app): register the editor extension and its pane"
```

---

## Task 12: `scratch.list` and `scratch.saveAs`

**Files:**
- Modify: `v2/extensions/scratch/src/store.ts`, `src/manifest.ts`, `src/index.ts`, `package.json`
- Test: `v2/extensions/scratch/src/store.test.ts` (extend), `src/save-as.test.ts` (create)

**Interfaces:**
- Consumes: `ScratchStore` (existing), `writeFileAt` semantics (Task 4 — but scratch keeps its own copy; see the note).
- Produces:
  ```
  scratch.list   {}                    → { docs: Array<{ id, title, updatedAt }> }
  scratch.saveAs { id, root, path }    → { ok: true } | { ok: false, reason }
  ```

This is item 1 of the spec's reconciliation: **a scratchpad is a document that
has not chosen a path yet, and saving it is the moment it does.**

- [ ] **Step 1: Write the failing store test**

Append to `v2/extensions/scratch/src/store.test.ts`:

```ts
describe('list', () => {
  it('answers the LIVE documents, newest first', () => {
    const kv = new Map<string, unknown>();
    const store = new ScratchStore(fakeKv(kv));
    store.create('scr_a', 1_000);
    store.write('scr_a', 'first note', 1_000);
    store.create('scr_b', 2_000);
    store.write('scr_b', 'second note', 2_000);

    expect(store.list().map((doc) => doc.id)).toEqual(['scr_b', 'scr_a']);
  });

  it('omits a closed document', () => {
    // Close is a SOFT delete kept for seven days, but a closed buffer is not a
    // note you have — listing it would offer a row that reopens a tombstone.
    const kv = new Map<string, unknown>();
    const store = new ScratchStore(fakeKv(kv));
    store.create('scr_a', 1_000);
    store.close('scr_a', 2_000);
    expect(store.list()).toEqual([]);
  });

  it('titles a document by its first non-empty line, trimmed', () => {
    const kv = new Map<string, unknown>();
    const store = new ScratchStore(fakeKv(kv));
    store.create('scr_a', 1_000);
    store.write('scr_a', '\n\n# Deploy checks\n\nbody\n', 1_000);
    expect(store.list()[0]?.title).toBe('Deploy checks');
  });

  it('titles an empty document `untitled` rather than a blank row', () => {
    const kv = new Map<string, unknown>();
    const store = new ScratchStore(fakeKv(kv));
    store.create('scr_a', 1_000);
    expect(store.list()[0]?.title).toBe('untitled');
  });
});
```

Reuse whatever `fakeKv` helper the existing tests in that file already use; if
there is none, write one implementing `KV` over a `Map` (`get` ignoring the
schema, `set`, `delete`, `keys`).

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && pnpm --filter @shepherd/ext-scratch test store
```

Expected: FAIL — `store.list is not a function`.

- [ ] **Step 3: Add `list()` to `ScratchStore`**

```ts
/** One row of the list, which is what a tree of notes is drawn from. */
export interface ScratchListing {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
}

/**
 * Every LIVE document, newest first.
 *
 * The KV is keyed by id and nothing ever needed to enumerate it — a pane always
 * arrived already holding one. `editor`'s `Notes` root is the first caller, and
 * the reason this exists.
 *
 * Closed rows are omitted. Close is a soft delete kept for seven days so that
 * `closeGroup` cannot lose a buffer, but a closed buffer is not a note you
 * have, and a row that reopens a tombstone is worse than no row.
 */
list(): readonly ScratchListing[] {
  const rows: ScratchListing[] = [];
  for (const id of this.#kv.keys()) {
    const doc = this.read(id);
    if (doc === undefined || doc.closedAt !== undefined) continue;
    rows.push({ id, title: titleOf(doc.text), updatedAt: doc.updatedAt });
  }
  return rows.sort((left, right) => right.updatedAt - left.updatedAt);
}
```

And beside the class:

```ts
/**
 * What a note is called in a list.
 *
 * The first non-empty line with its markdown heading marks stripped — which is
 * what the pane's own `presentation()` does for the tab, and the same answer
 * for the same reason: a document names itself in its first line or it has no
 * name at all.
 */
function titleOf(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/^#+\s*/, '').trim();
    if (trimmed !== '') return trimmed;
  }
  return 'untitled';
}
```

- [ ] **Step 4: Run the store test**

```bash
cd v2 && pnpm --filter @shepherd/ext-scratch test store
```

Expected: PASS.

- [ ] **Step 5: Write the failing `saveAs` test**

Create `v2/extensions/scratch/src/save-as.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveAs } from './save-as.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scratch-saveas-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('saveAs', () => {
  it('writes the text, creating parent directories', () => {
    expect(saveAs(root, 'docs/notes.md', 'hello\n')).toEqual({ ok: true });
    expect(readFileSync(join(root, 'docs/notes.md'), 'utf8')).toBe('hello\n');
  });

  it('REFUSES to overwrite an existing file', () => {
    // Saving a note is creating a document, not replacing one. Silently
    // clobbering a file the user already has is not a save-as.
    writeFileSync(join(root, 'notes.md'), 'mine\n');
    expect(saveAs(root, 'notes.md', 'new\n')).toEqual({ ok: false, reason: 'already exists' });
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('mine\n');
  });

  it('refuses a path that escapes the root', () => {
    expect(saveAs(root, '../escape.md', 'x')).toEqual({ ok: false, reason: 'outside the root' });
    expect(existsSync(join(root, '../escape.md'))).toBe(false);
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

```bash
cd v2 && pnpm --filter @shepherd/ext-scratch test save-as
```

Expected: FAIL — module not found.

- [ ] **Step 7: Implement `src/save-as.ts`**

```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * A note, given a path.
 *
 * This is the moment the spec's sentence becomes a verb: **a scratchpad is a
 * document that has not chosen a path yet.** After this it is a file, and the
 * editor is where you edit it.
 *
 * It REFUSES an existing file rather than overwriting one. Saving a note is
 * creating a document; replacing one the user already has is a different verb
 * with a different confirmation, and this is not it.
 */
export function saveAs(
  root: string,
  rel: string,
  text: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (isAbsolute(rel)) return { ok: false, reason: 'outside the root' };
  const full = resolve(join(root, rel));
  const back = relative(resolve(root), full);
  if (back === '' || back.startsWith('..') || isAbsolute(back)) {
    return { ok: false, reason: 'outside the root' };
  }
  if (existsSync(full)) return { ok: false, reason: 'already exists' };

  try {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : 'could not write' };
  }
}
```

- [ ] **Step 8: Run it and watch it pass**

```bash
cd v2 && pnpm --filter @shepherd/ext-scratch test save-as
```

Expected: PASS, 3 tests.

- [ ] **Step 9: Register the two commands**

In `v2/extensions/scratch/src/manifest.ts`, add to `SCRATCH_COMMANDS`:

```ts
  /** Every live buffer — what `editor`'s `Notes` root is drawn from. */
  list: 'scratch.list',
  /**
   * Give this buffer a path: write it into a repo and drop the KV row.
   *
   * The moment a note stops being a note. After it, `editor` owns the file.
   */
  saveAs: 'scratch.saveAs',
```

And to the `contributes.commands` array in **both** `manifest.ts` and
`package.json` (the test asserts they are identical):

```json
{ "id": "scratch.list" },
{ "id": "scratch.saveAs", "title": "Scratch: Save to Repo" }
```

In `src/index.ts`:

```ts
  ctx.subscriptions.push(
    commands.register(SCRATCH_COMMANDS.list, {
      schema: s.object({}),
      handler: () => ({ docs: store.list() }),
    }),
  );

  ctx.subscriptions.push(
    commands.register(SCRATCH_COMMANDS.saveAs, {
      title: 'Scratch: Save to Repo',
      schema: s.object({ id: s.string(), root: s.string(), path: s.string() }),
      handler: (args) => {
        const doc = store.read(args.id);
        if (doc === undefined) return { ok: false, reason: 'no such scratch' };
        const wrote = saveAs(args.root, args.path, doc.text);
        if (!wrote.ok) return wrote;
        /*
         * The row goes only AFTER the file exists. Dropping it first and
         * failing the write would lose the note entirely, which is the one
         * outcome this verb must not have.
         */
        store.close(args.id, ctx.clock.now());
        return { ok: true };
      },
    }),
  );
```

with `import { saveAs } from './save-as.ts';` at the top.

- [ ] **Step 10: Run the whole scratch suite**

```bash
cd v2 && pnpm --filter @shepherd/ext-scratch test && pnpm --filter @shepherd/ext-scratch typecheck
```

Expected: green, including the manifest-equality test.

- [ ] **Step 11: Commit**

```bash
git add v2/extensions/scratch
git commit -m "feat(v2/scratch): list live notes, and give one a path with saveAs"
```

---

## Task 13: The `Notes` root in the editor's tree

**Files:**
- Modify: `v2/extensions/editor/src/index.ts`, `ui/editor-pane.tsx`
- Test: `v2/extensions/editor/src/notes.test.ts` (create), `src/notes.ts` (create)

**Interfaces:**
- Consumes: `scratch.list` (Task 12).
- Produces:
  ```ts
  interface Note { readonly id: string; readonly title: string }
  function readNotes(value: unknown): readonly Note[]
  const NOTES_ROOT = 'Notes'
  function notePath(note: Note): string
  function noteIdFromPath(path: string, notes: readonly Note[]): string | undefined
  ```

**Naming:** `Notes`, never `Scratch` or `Scratchpad` — the rail's `Scratchpad`
section is loose shells (ADR 0047), and a third thing called scratch makes the
word useless.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { NOTES_ROOT, noteIdFromPath, notePath, readNotes } from './notes.ts';

describe('readNotes', () => {
  it('reads the rows scratch.list answers', () => {
    expect(readNotes({ docs: [{ id: 'scr_a', title: 'Deploy checks', updatedAt: 1 }] })).toEqual([
      { id: 'scr_a', title: 'Deploy checks' },
    ]);
  });

  it('drops a row with no id — an invented one would open somebody else s note', () => {
    expect(readNotes({ docs: [{ title: 'no id' }, { id: 'scr_a', title: 'ok' }] })).toEqual([
      { id: 'scr_a', title: 'ok' },
    ]);
  });

  it('is empty when scratch is not installed, rather than throwing', () => {
    // A build without the scratch extension is a real state, not a failure.
    expect(readNotes(undefined)).toEqual([]);
    expect(readNotes({ docs: 'nope' })).toEqual([]);
  });
});

describe('notePath', () => {
  it('is under the Notes root and carries the title', () => {
    // Not an equality: the id is appended too, because the tree is keyed by
    // path and two notes with one title would collapse into a single row.
    expect(notePath({ id: 'scr_a', title: 'Deploy checks' })).toContain(
      `${NOTES_ROOT}/Deploy checks`,
    );
  });

  it('flattens a slash in the title, which would otherwise fake a directory', () => {
    expect(notePath({ id: 'scr_a', title: 'a/b' })).toBe(`${NOTES_ROOT}/a-b`);
  });

  it('disambiguates two notes with the same title by id', () => {
    const a = notePath({ id: 'scr_a', title: 'Notes' });
    const b = notePath({ id: 'scr_b', title: 'Notes' });
    // The tree is keyed by path. Two identical paths collapse to one row and
    // the second note becomes unreachable.
    expect(a).not.toBe(b);
  });
});

describe('noteIdFromPath', () => {
  const notes = [
    { id: 'scr_a', title: 'One' },
    { id: 'scr_b', title: 'Two' },
  ];

  it('finds the note a row stands for', () => {
    expect(noteIdFromPath(notePath(notes[0]!), notes)).toBe('scr_a');
  });

  it('is undefined for a real file path', () => {
    expect(noteIdFromPath('src/a.ts', notes)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test notes
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/notes.ts`**

```ts
/**
 * The scratchpad, as rows in the editor's tree.
 *
 * `Notes`, never `Scratch`: the rail's `Scratchpad` section is loose SHELLS
 * (ADR 0047) and a scratch pane is a markdown DOCUMENT. A third thing called
 * scratch would make the word mean nothing.
 *
 * A row here does NOT render inside the editor pane — clicking one opens or
 * focuses its own `scratch.pad` tab. The boundary lint forbids this extension
 * importing scratch's `ui/`, and the restriction turns out to be the honest
 * design: a note is its own place, not a file in a repo that happens to have no
 * path.
 */
export const NOTES_ROOT = 'Notes';

export interface Note {
  readonly id: string;
  readonly title: string;
}

/**
 * What `scratch.list` answered, read rather than cast.
 *
 * `ok` says a call succeeded, never that a value has a shape — and this crossed
 * an IPC port. A row with no id is DROPPED: an invented one would open somebody
 * else's note. A build with no `scratch` extension answers nothing, which is a
 * real state and lands on an empty list rather than a refusal.
 */
export function readNotes(value: unknown): readonly Note[] {
  if (typeof value !== 'object' || value === null) return [];
  const docs = (value as { docs?: unknown }).docs;
  if (!Array.isArray(docs)) return [];
  return docs.flatMap((row): Note[] => {
    if (typeof row !== 'object' || row === null) return [];
    const shape = row as { id?: unknown; title?: unknown };
    if (typeof shape.id !== 'string' || shape.id === '') return [];
    return [{ id: shape.id, title: typeof shape.title === 'string' ? shape.title : 'untitled' }];
  });
}

/**
 * The path the tree holds this note under.
 *
 * The id is appended because the tree is KEYED BY PATH: two notes both called
 * `Notes` would collapse into one row and the second would be unreachable. A
 * slash in a title is flattened for the same class of reason — it would fake a
 * directory that nothing else knows about.
 */
export function notePath(note: Note): string {
  const safe = note.title.replaceAll('/', '-');
  return `${NOTES_ROOT}/${safe}·${note.id}`;
}

export function noteIdFromPath(path: string, notes: readonly Note[]): string | undefined {
  if (!path.startsWith(`${NOTES_ROOT}/`)) return undefined;
  return notes.find((note) => notePath(note) === path)?.id;
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test notes
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Add the notes to `editor.tree`**

In `v2/extensions/editor/src/index.ts`, extend the `editor.tree` handler:

```ts
      handler: async (args) => {
        const [walked, status, notes] = await Promise.all([
          listPaths(process, args.root),
          listStatus(process, args.root),
          /*
           * `scratch.list` across the command port, the way `github` reads
           * `tasks.list`. A build with no scratch extension answers not-ok,
           * which is a real state: no Notes root, and the tree is fine.
           */
          commands.invoke('scratch.list', {}).then((answer) => (answer.ok ? readNotes(answer.value) : [])),
        ]);
        return {
          paths: [...notes.map(notePath), ...walked.paths],
          truncated: walked.truncated,
          status,
          notes,
        };
      },
```

with `import { notePath, readNotes } from './notes.ts';` at the top.

- [ ] **Step 6: Open a note as its own tab**

In `ui/editor-pane.tsx`, extend `readTree` to carry `notes`, and make the
selection effect branch:

```tsx
  useEffect(() => {
    const first = selected[0];
    if (first === undefined) return;
    const note = noteIdFromPath(first, tree.notes);
    if (note !== undefined) {
      /*
       * A note opens as its OWN tab, not inside this pane: the boundary lint
       * forbids importing scratch's ui/, and a note genuinely is its own place.
       */
      void invoke('scratch.open', { id: note });
      return;
    }
    setAt(first);
  }, [selected, tree.notes, invoke]);
```

with `import { noteIdFromPath } from '../src/notes.ts';` at the top.

Check `scratch.open`'s actual schema before relying on it:

```bash
cd v2 && grep -n "SCRATCH_COMMANDS.open" -A 20 extensions/scratch/src/index.ts
```

`scratch.open` is documented as "⌘-click on a link. http/https only" — **it is
not the verb that opens a pane.** If there is no command that opens a pad by id,
add one (`scratch.reveal`, taking `{ id }`, doing the `layout.newTab` call
`scratch.create` already makes) in this task, with its own test, following
`scratch.create`'s handler exactly.

- [ ] **Step 7: Run everything**

```bash
cd v2 && pnpm --filter @shepherd/ext-editor test && pnpm --filter @shepherd/ext-scratch test && pnpm --filter @shepherd/ext-editor typecheck
```

Expected: green.

- [ ] **Step 8: Verify by hand**

```bash
cd v2 && pnpm --filter @shepherd/app dev
```

1. ⌘⇧N to make a scratch note; type a heading into it.
2. Open the editor tab. A `Notes` root is above the repos with that note in it.
3. Click it — the scratch tab opens or focuses. It does **not** render inside
   the editor pane.
4. Run **Scratch: Save to Repo** on it, choose a path; the file appears in the
   editor's tree and the `Notes` row is gone.

- [ ] **Step 9: Commit**

```bash
git add v2/extensions/editor v2/extensions/scratch
git commit -m "feat(v2/editor): a Notes root over the scratchpad's live documents"
```

---

## Task 14: Lint, the full suite, and the two ADRs

**Files:**
- Create: `v2/.claude/adr/0048-v2-the-editor-owns-the-working-tree-and-a-save-refuses-a-file-that-moved.md`
- Create: `v2/.claude/adr/0049-v2-a-scratchpad-is-a-document-without-a-path.md`
- Modify: `CLAUDE.md` (the v2 section's ADR summary), `v2/extensions/README.md` if it enumerates extensions

Check the actual ADR directory first — `CLAUDE.md` links `.claude/adr/` at the
**repo root**, not under `v2/`. Use whichever the existing 0047 file lives in:

```bash
ls .claude/adr/0047-* v2/.claude/adr/0047-* 2>/dev/null
```

- [ ] **Step 1: Run the whole workspace green**

```bash
cd v2 && pnpm -r test && pnpm -r typecheck && pnpm -r lint
```

Fix anything that fails. The boundary lint is the one most likely to bite:
if it objects to `@shepherd/ext-editor` importing `@shepherd/ext-scratch`,
confirm the import is `import type` only and that the manifest declares the
dependency.

- [ ] **Step 2: Write ADR 0048**

Follow the house format exactly — read `0044` and `0047` first. Content:

- **Context.** The app had no way to edit a file. `github`'s Files tab is the
  two panels already, read-only and PR-scoped. ADR 0044 predicted this shape
  ("a diff view, a log viewer and a preview are the shapes that follow").
- **Decision.** The editor pane is a view pane whose subject is a directory. It
  saves on ⌘S and **refuses a save whose file changed on disk.**
- **Why not autosave**, with the measured comparison: `scratch` debounces at
  400ms, t3code's `fileSaveCoordinator` does the same, and neither has a second
  writer. This pane's entire reason for existing is a worktree an agent is
  writing to.
- **Why the stamp is mtime AND size**, and the collision it accepts.
- **Why ignored FILES are in the tree and ignored DIRECTORIES are not**, with
  the two `git ls-files` invocations and the trailing-slash test.
- **Consequences**, including: the diff theme and sprite are COPIED from
  `github` because the boundary lint forbids the import and two consumers is not
  a package — **a third consumer promotes them**, and both copies are deleted
  then.

- [ ] **Step 3: Write ADR 0049**

- **Context.** Two panes that are both editable text.
- **Decision.** A scratchpad is a document that has not chosen a path yet.
  `scratch.saveAs` is the moment it does; `editor`'s `Notes` root lists the ones
  that have not.
- **Why a note opens its own tab** rather than rendering in the editor pane:
  the boundary lint, and the fact that the restriction is the honest design.
- **Why the engines are not unified.** Scratch's value is CodeMirror
  decorations (live preview, checkbox widgets); Pierre's `File` is a shiki code
  renderer with no decoration surface. Rewriting 4,000 working lines to change
  nothing the user sees is not a reconciliation.
- **What is deferred:** a document-surface contribution point — a third table
  beside `EXTENSION_PANE_UI` where an extension registers a surface per file
  kind, so markdown in the editor gets live preview in the same pane. **A second
  consumer buys it.**
- **Naming:** `Notes`, because the rail's `Scratchpad` is loose shells.

- [ ] **Step 4: Update `CLAUDE.md`**

Add the editor to the v2 summary paragraph in the same voice as the entries
around it, and add 0048/0049 to the ADR list.

- [ ] **Step 5: Final verification**

```bash
cd v2 && pnpm -r test && pnpm -r typecheck && pnpm -r lint
```

Expected: all green. Paste the actual output into the commit or the PR — do not
claim it passed without it.

- [ ] **Step 6: Commit**

```bash
git add .claude/adr CLAUDE.md v2
git commit -m "docs(v2): ADRs for the editor pane and the scratchpad's path"
```

---

## Notes for whoever executes this

**Two things in this plan are sketches, not transcriptions**, and the plan says
so at each site rather than pretending otherwise:

1. **Pierre's exact React prop names.** `@pierre/diffs@1.3.5` and
   `@pierre/trees@1.0.0-beta.6` are pinned, and the `.d.ts` files under
   `node_modules/` are the authority. Two working call sites exist to copy from:
   `v2/extensions/github/ui/pr-panels.tsx` (this repo, these versions, the
   `CodeView` and `FileTree` halves) and, if you clone it,
   `pingdotgg/t3code`'s `apps/web/src/components/files/FilePreviewPanel.tsx`
   (the `<File edit>` half — but it pins `1.3.0-beta.10`, where the prop is
   `contentEditable`, so translate rather than copy).

2. **`scratch.open` may not be the verb Task 13 needs.** Its manifest comment
   says "⌘-click on a link. http/https only". Task 13 Step 6 says what to do if
   so: add `scratch.reveal`, following `scratch.create`'s handler.

**The single most important test in this plan** is `files.test.ts`'s "REFUSES
when the file changed underneath, and does not write". If you cut anything under
time pressure, do not cut that.
