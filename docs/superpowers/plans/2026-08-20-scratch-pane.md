# Scratch Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `scratch` pane type to v2: a leaf of the layout tree that is a live-preview markdown editor instead of a terminal.

**Architecture:** A new built-in extension, `shepherd.scratch`, in the two halves ADR 0033 requires. Its `src/` half owns a KV namespace and four commands and registers a `surface: 'pane'` view. Its `ui/` half is a CodeMirror 6 editor whose live preview is a `ViewPlugin` producing decorations from the markdown syntax tree, suppressed wherever the selection touches. Three app-level changes support it: a pane contribution may bind an accelerator to a command, close routes through a guard, and undo/redo stop being Electron menu roles.

**Tech Stack:** TypeScript, React 19, Electron 43, CodeMirror 6, `@lezer/markdown`, vitest, pnpm workspaces with a version catalog.

**Spec:** `docs/superpowers/specs/2026-08-20-scratch-pane-design.md`

## Global Constraints

- **Scope is `v2/` only.** Nothing in `spike/seam1/` (v1) is touched.
- **All paths in this plan are relative to `v2/`** unless they start with `docs/` or are `CLAUDE.md`.
- **Every dependency version goes in the catalog.** `pnpm-workspace.yaml`'s `catalog:` block is the single place a version is written; packages depend on `"catalog:"`.
- **An extension has two halves.** `src/` is the service half and runs in a utility process with **no DOM and no React**. `ui/` is the renderer half. `tooling/eslint/boundaries.js` enforces it and must be updated for each new extension.
- **The typed manifest and `package.json`'s `shepherd` key must be identical**, asserted by that extension's `manifest.test.ts`.
- **No accelerator may be added to `packages/app/src/main/menu-template.ts`.** macOS resolves a menu key equivalent before the page sees it, so a menu item on a key silently deletes a contributed accelerator on that key.
- **Every accelerator must carry a modifier.** `hasModifier` in `packages/app/src/main/view-registry.ts` enforces it for contributions.
- **The scratch accelerator is `CmdOrCtrl+Shift+N`.** Verbatim, that string.
- **The view type and component name are one string: `scratch.pad`.**
- **The KV namespace is `shepherd.scratch`.**
- **The save debounce is 400ms**, matching `DEFAULT_PERSIST_DEBOUNCE_MS` in `packages/core/src/layout/store.ts`.
- **Soft-deleted buffers are collected after 7 days.**
- **Markdown constructs are chosen by which `@lezer/markdown` extensions are imported.** Import `Strikethrough`, `TaskList`, `Autolink`. **Never import `Table`.**
- **Links open only `http://` and `https://` URLs**, via `process.exec(['/usr/bin/open', url])` with an argv array.
- Run tests from `v2/`: `pnpm -F @shepherd/ext-scratch test`. Typecheck the workspace: `pnpm -r typecheck`.

---

## File Structure

**New package — `extensions/scratch/`**

| file | responsibility |
|---|---|
| `package.json` | name, the `shepherd` manifest key, deps, the `.`/`./manifest`/`./ui` subpaths |
| `tsconfig.json` | `rootDir: "."` so both halves typecheck |
| `vitest.config.ts` | two projects: node for `src/`, jsdom for `ui/` |
| `src/manifest.ts` | typed manifest, ids, command names, view names |
| `src/manifest.test.ts` | manifest does not drift from `package.json` |
| `src/store.ts` | the `ScratchDoc` schema and the KV wrapper, pure over an injected `KV` |
| `src/store.test.ts` | round-trip, soft delete, garbage collection |
| `src/index.ts` | `activate`: registers the view, the commands, runs GC |
| `ui/index.ts` | the barrel the renderer imports |
| `ui/live-preview.ts` | the decoration builder. Pure, and the most-tested file here |
| `ui/live-preview.test.ts` | the caret rule, the construct set, tables stay literal |
| `ui/markdown-parser.ts` | the `@lezer/markdown` configuration, exported so tests share it |
| `ui/checkbox-widget.ts` | the one `WidgetType` |
| `ui/theme.ts` | CodeMirror theme built from design tokens |
| `ui/editor.ts` | assembles extensions into an `EditorState` config |
| `ui/scratch-pane.tsx` | the React component: mount, save debounce, link clicks |
| `ui/scratch-pane.test.tsx` | mounting, id wiring, debounce, flush on unmount |

**Modified — app and tooling**

| file | change |
|---|---|
| `pnpm-workspace.yaml` | catalog entries for the CodeMirror and Lezer packages |
| `tooling/eslint/boundaries.js` | `denyExact('@shepherd/ext-scratch', SERVICE_HALF)` |
| `packages/sdk/src/api-layout.ts` | `command?: string` on `ViewDeclaration` |
| `packages/app/src/main/view-registry.ts` | `command?: string` on `Contribution`; carry it through |
| `packages/app/src/shared/bridge.ts` | `command?: string` on `ViewContributionDTO` |
| `packages/app/src/renderer/pane-keys.ts` | **new.** Binds pane contributions' accelerators |
| `packages/app/src/renderer/pane-keys.test.ts` | **new.** |
| `packages/app/src/renderer/extension-ui.ts` | one line in `EXTENSION_PANE_UI` |
| `packages/app/src/renderer/close-guard.ts` | **new.** Should closing this pane prompt? |
| `packages/app/src/renderer/close-guard.test.ts` | **new.** |
| `packages/app/src/renderer/app.tsx` | mount `PaneKeys`; route close through the guard; route undo/redo |
| `packages/app/src/main/menu-template.ts` | undo/redo become commands, not roles |
| `packages/app/src/shared/commands.ts` | `undo`, `redo` command ids |
| `packages/app/src/shared/menu-commands.ts` | their invocations |
| `packages/app/src/main/index.ts` | `scratchManifest` in both lists |
| `packages/app/src/ext-host/builtins.ts` | `SCRATCH_ID -> scratch` |
| `packages/app/tsconfig.json` (+ root refs) | reference the new package |

**Modified — docs (the D9 rename)**

`docs/superpowers/plans/2026-08-07-v2-m3-plan.md`, `docs/superpowers/plans/2026-08-08-v2-handoff.md`, `docs/superpowers/plans/2026-08-12-v2-m4-punch-list.md`, `CLAUDE.md`.

---

## Task order and why

Tasks 1 to 4 are the extension's service half and its store, and they are testable with no DOM. Tasks 5 to 8 are the editor, and Task 6 (`live-preview.ts`) is the heart of the feature and carries the most tests. Tasks 9 to 11 are the three app-level seams. Task 12 wires everything together, which is the first point anything is visible on screen. Task 13 is the rename.

Tasks 9, 10 and 11 do not depend on each other and could be done in any order.

---

### Task 1: The extension package skeleton

**Files:**
- Create: `v2/extensions/scratch/package.json`
- Create: `v2/extensions/scratch/tsconfig.json`
- Create: `v2/extensions/scratch/vitest.config.ts`
- Create: `v2/extensions/scratch/src/manifest.ts`
- Test: `v2/extensions/scratch/src/manifest.test.ts`
- Modify: `v2/tooling/eslint/boundaries.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `SCRATCH_ID = 'shepherd.scratch'`, `SCRATCH_COMMANDS = { create, read, write, close, open }`, `SCRATCH_VIEWS = { pad: 'scratch.pad' }`, `SCRATCH_KEY = 'CmdOrCtrl+Shift+N'`, `scratchManifest: Manifest`.

- [x] **Step 1: Write the failing test**

Create `v2/extensions/scratch/src/manifest.test.ts`. This is the file every extension has; it exists so a built-in cannot ship a `package.json` promising permissions its code never asks for.

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@shepherd/sdk';
import { SCRATCH_COMMANDS, scratchManifest } from './manifest.ts';

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
  shepherd: unknown;
  version: string;
};

describe('the scratch manifest', () => {
  it('matches the shepherd key of its own package.json, field for field', () => {
    expect(pkg.shepherd).toEqual(scratchManifest);
  });

  it('declares the same version as the package', () => {
    expect(scratchManifest.version).toBe(pkg.version);
  });

  it('declares only permissions the SDK knows', () => {
    for (const permission of scratchManifest.permissions) {
      expect(PERMISSIONS).toContain(permission);
    }
  });

  it('contributes exactly the commands it registers', () => {
    expect(scratchManifest.contributes?.commands?.map((command) => command.id)).toEqual([
      SCRATCH_COMMANDS.create,
      SCRATCH_COMMANDS.read,
      SCRATCH_COMMANDS.write,
      SCRATCH_COMMANDS.close,
      SCRATCH_COMMANDS.open,
    ]);
  });

  it('asks for layout, because creating a scratch opens a tab', () => {
    expect(scratchManifest.permissions).toContain('layout');
  });

  it('asks for process.exec, because a link opens a browser', () => {
    expect(scratchManifest.permissions).toContain('process.exec');
  });
});
```

- [x] **Step 2: Run it and watch it fail**

```bash
cd v2 && pnpm -F @shepherd/ext-scratch test
```

Expected: the package does not exist, so pnpm fails with "No projects matched the filters". That is the correct first failure.

- [x] **Step 3: Write `package.json`**

Create `v2/extensions/scratch/package.json`. The CodeMirror packages are `dependencies` because `ui/` imports them at runtime; `react` is a `devDependency` exactly as it is in `extensions/diagnostics/package.json`, because the renderer supplies it.

```json
{
  "name": "@shepherd/ext-scratch",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "shepherd.scratch — a pane that is a markdown document instead of a terminal.",
  "//exports": "The split every extension makes: main imports ./manifest to register, the utility process imports the root (which pulls in `activate`), and ./ui is the half the renderer mounts.",
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" },
    "./manifest": { "types": "./src/manifest.ts", "default": "./src/manifest.ts" },
    "./ui": { "types": "./ui/index.ts", "default": "./ui/index.ts" }
  },
  "scripts": {
    "typecheck": "tsc -b",
    "test": "vitest run"
  },
  "//codemirror": "A private vendor dependency of this extension, on the same footing as github's @octokit/rest: the boundary lint is about which SHEPHERD packages an extension may reach. Imported only from ui/ — the service half has no DOM.",
  "dependencies": {
    "@shepherd/sdk": "workspace:*",
    "@shepherd/ui": "workspace:*",
    "@codemirror/state": "catalog:",
    "@codemirror/view": "catalog:",
    "@codemirror/language": "catalog:",
    "@codemirror/commands": "catalog:",
    "@codemirror/lang-markdown": "catalog:",
    "@lezer/markdown": "catalog:",
    "@lezer/highlight": "catalog:"
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
  "//shepherd": "The manifest, as an extension declares it. `src/manifest.ts` is the typed copy the host loads, and `manifest.test.ts` asserts the two are identical.",
  "shepherd": {
    "id": "shepherd.scratch",
    "name": "Scratch",
    "version": "0.1.0",
    "api": "^1.0.0",
    "activation": ["onStartup"],
    "permissions": ["storage", "views", "layout", "process.exec"],
    "contributes": {
      "commands": [
        { "id": "scratch.create", "title": "Scratch: New" },
        { "id": "scratch.read" },
        { "id": "scratch.write" },
        { "id": "scratch.close" },
        { "id": "scratch.open" }
      ]
    }
  },
  "//ui": "The UI half, imported ONLY by the renderer (boundaries.js). A separate subpath because it is a separate PROCESS: `.` is the service half and runs in a utility process with no DOM."
}
```

- [x] **Step 4: Write `src/manifest.ts`**

```ts
import type { Manifest } from '@shepherd/sdk';

/**
 * The manifest, typed, so main can register this extension without importing
 * its code. It duplicates the `shepherd` key of `package.json` and
 * `manifest.test.ts` asserts the two are identical — `resolveJsonModule` is off
 * across this repo, so the copy is the cheaper half of that trade.
 */
export const SCRATCH_ID = 'shepherd.scratch';

export const SCRATCH_COMMANDS = {
  /** Mint a buffer and open a tab holding it. What ⌘⇧N runs. */
  create: 'scratch.create',
  read: 'scratch.read',
  write: 'scratch.write',
  /** Soft-delete. Called by the pane on its way out, not by the shell. */
  close: 'scratch.close',
  /** ⌘-click on a link. http/https only; see `index.ts` for the guard. */
  open: 'scratch.open',
} as const;

/**
 * The view type AND the component name, which are deliberately one string:
 * the renderer resolves the type against contributions and then that
 * contribution's `component` against its static table (ADR 0044). Two hops, one
 * name, so a persisted `view` on disk reads as what it is.
 */
export const SCRATCH_VIEWS = { pad: 'scratch.pad' } as const;

/** The accelerator. Free: the only contributed keys are ⌘N and ⌘⇧F. */
export const SCRATCH_KEY = 'CmdOrCtrl+Shift+N';

export const scratchManifest: Manifest = {
  id: SCRATCH_ID,
  name: 'Scratch',
  version: '0.1.0',
  api: '^1.0.0',
  /**
   * `onStartup` because the accelerator must work before anything scratch-shaped
   * has happened. An extension woken by its own first use cannot own the key
   * that is its own first use.
   */
  activation: ['onStartup'],
  /**
   * `layout` because `scratch.create` opens a tab. `process.exec` because a
   * ⌘-clicked link runs `open(1)`; there is no kernel `shell.openExternal`
   * (`extensions/github/src/index.ts:461` says so and says what to do instead).
   */
  permissions: ['storage', 'views', 'layout', 'process.exec'],
  contributes: {
    commands: [
      { id: SCRATCH_COMMANDS.create, title: 'Scratch: New' },
      { id: SCRATCH_COMMANDS.read },
      { id: SCRATCH_COMMANDS.write },
      { id: SCRATCH_COMMANDS.close },
      { id: SCRATCH_COMMANDS.open },
    ],
  },
};
```

- [x] **Step 5: Write `tsconfig.json` and `vitest.config.ts`**

`tsconfig.json` — `rootDir: "."` so both halves typecheck. M3's lesson was a package missing from the references producing no output at all for a planted type error.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "out-tsc",
    "tsBuildInfoFile": "out-tsc/tsconfig.tsbuildinfo",
    "types": ["node"],
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx"
  },
  "include": ["src/**/*.ts", "ui/**/*.ts", "ui/**/*.tsx"],
  "references": [{ "path": "../../packages/sdk" }, { "path": "../../packages/ui" }]
}
```

`vitest.config.ts` — two projects, because the halves need different environments. `src/` must never need a DOM to pass; that is the property the process split buys.

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: '@shepherd/ext-scratch:src', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        test: {
          name: '@shepherd/ext-scratch:ui',
          include: ['ui/**/*.test.ts', 'ui/**/*.test.tsx'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
```

- [x] **Step 6: Add the catalog entries**

In `v2/pnpm-workspace.yaml`, inside the `catalog:` block, after the react entries. Use the latest 6.x of each `@codemirror/*` package and the latest 1.x of the `@lezer/*` ones; resolve exact versions with `pnpm view <pkg> version` and write them literally, since this file is where a version is written once.

```yaml
  # The scratch pane's editor. CodeMirror rather than a ProseMirror-family
  # editor because it keeps the document as EXACT TEXT and only decorates it;
  # Tiptap, Milkdown and Lexical hold a rich document and serialize on the way
  # out, which rewrites what you paste. In a pane that is partly "somewhere to
  # dump text", that is disqualifying.
  #
  # `@lezer/markdown` ships GFM as separately importable extensions. Enabling
  # Strikethrough, TaskList and Autolink and NOT Table is how "no tables" is
  # implemented: a table is not a construct the parser knows, so it stays as the
  # characters you typed rather than being rendered and then suppressed.
  '@codemirror/state': <resolved>
  '@codemirror/view': <resolved>
  '@codemirror/language': <resolved>
  '@codemirror/commands': <resolved>
  '@codemirror/lang-markdown': <resolved>
  '@lezer/markdown': <resolved>
  '@lezer/highlight': <resolved>
```

- [x] **Step 7: Add the boundary rule**

In `v2/tooling/eslint/boundaries.js`, beside the existing `denyExact` calls (around line 464-470):

```js
      denyExact('@shepherd/ext-scratch', SERVICE_HALF),
```

- [x] **Step 8: Install and run the test**

```bash
cd v2 && pnpm install && pnpm -F @shepherd/ext-scratch test
```

Expected: all six assertions in `manifest.test.ts` PASS.

- [x] **Step 9: Commit**

```bash
git add v2/extensions/scratch v2/pnpm-workspace.yaml v2/tooling/eslint/boundaries.js v2/pnpm-lock.yaml
git commit -m "An extension that will be a document

The package, the manifest and the boundary rule. No behaviour yet: what this
buys is the manifest test, which is the thing that stops a built-in shipping a
package.json promising permissions its code never asks for."
```

---

### Task 2: The store

**Files:**
- Create: `v2/extensions/scratch/src/store.ts`
- Test: `v2/extensions/scratch/src/store.test.ts`

**Interfaces:**
- Consumes: `KV` from `@shepherd/sdk`.
- Produces:
  - `interface ScratchDoc { readonly text: string; readonly updatedAt: number; readonly closedAt?: number }`
  - `class ScratchStore` with `create(id: string, now: number): void`, `read(id: string): ScratchDoc | undefined`, `write(id: string, text: string, now: number): void`, `close(id: string, now: number): void`, `collect(now: number, maxAgeMs: number): number` returning how many rows it removed.

Why a class over an injected `KV` rather than functions reaching for `ctx.storage`: the whole file is then testable with a `Map` and no host, which is what makes the garbage collection assertions cheap.

- [x] **Step 1: Write the failing test**

Create `v2/extensions/scratch/src/store.test.ts`.

```ts
import { describe, expect, it } from 'vitest';
import type { KV, Schema } from '@shepherd/sdk';
import { GC_MAX_AGE_MS, ScratchStore } from './store.ts';

/** A KV backed by a Map. The store must not need a host to be tested. */
function fakeKv(): KV {
  const rows = new Map<string, unknown>();
  return {
    get<T>(key: string, _schema: Schema<T>): T | undefined {
      return rows.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      rows.set(key, value);
    },
    delete(key: string): void {
      rows.delete(key);
    },
    keys(): readonly string[] {
      return [...rows.keys()].sort();
    },
  };
}

describe('ScratchStore', () => {
  it('creates an empty buffer that reads back', () => {
    const store = new ScratchStore(fakeKv());
    store.create('scr_a', 1000);
    expect(store.read('scr_a')).toEqual({ text: '', updatedAt: 1000 });
  });

  it('round-trips text', () => {
    const store = new ScratchStore(fakeKv());
    store.create('scr_a', 1000);
    store.write('scr_a', '# hello', 2000);
    expect(store.read('scr_a')).toEqual({ text: '# hello', updatedAt: 2000 });
  });

  it('reads undefined for an id it has never seen', () => {
    expect(new ScratchStore(fakeKv()).read('scr_nope')).toBeUndefined();
  });

  it('writing an unknown id creates it rather than throwing', () => {
    // A pane can outlive a row: a hand-edited store, a failed migration, a
    // relaunch against an older build. Losing the keystrokes would be worse
    // than resurrecting the row.
    const store = new ScratchStore(fakeKv());
    store.write('scr_ghost', 'typed anyway', 5000);
    expect(store.read('scr_ghost')?.text).toBe('typed anyway');
  });

  it('close is a SOFT delete: the row and its text survive', () => {
    const store = new ScratchStore(fakeKv());
    store.create('scr_a', 1000);
    store.write('scr_a', 'notes', 2000);
    store.close('scr_a', 3000);
    expect(store.read('scr_a')).toEqual({ text: 'notes', updatedAt: 2000, closedAt: 3000 });
  });

  it('collects a closed row once it is older than the max age', () => {
    const store = new ScratchStore(fakeKv());
    store.create('scr_a', 1000);
    store.close('scr_a', 1000);
    const removed = store.collect(1000 + GC_MAX_AGE_MS + 1, GC_MAX_AGE_MS);
    expect(removed).toBe(1);
    expect(store.read('scr_a')).toBeUndefined();
  });

  it('does NOT collect a closed row that is still inside the window', () => {
    const store = new ScratchStore(fakeKv());
    store.create('scr_a', 1000);
    store.close('scr_a', 1000);
    expect(store.collect(1000 + GC_MAX_AGE_MS - 1, GC_MAX_AGE_MS)).toBe(0);
    expect(store.read('scr_a')).toBeDefined();
  });

  it('NEVER collects an open row, however old', () => {
    // The property the whole lifetime rule rests on: a pane that has been open
    // and untouched for a year must not lose its text to housekeeping.
    const store = new ScratchStore(fakeKv());
    store.create('scr_a', 0);
    store.write('scr_a', 'a year of notes', 0);
    expect(store.collect(GC_MAX_AGE_MS * 365, GC_MAX_AGE_MS)).toBe(0);
    expect(store.read('scr_a')?.text).toBe('a year of notes');
  });

  it('is seven days', () => {
    expect(GC_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
```

- [x] **Step 2: Run it and watch it fail**

```bash
cd v2 && pnpm -F @shepherd/ext-scratch test
```

Expected: FAIL, `Failed to resolve import "./store.ts"`.

- [x] **Step 3: Write `src/store.ts`**

```ts
import { s, type KV } from '@shepherd/sdk';

/**
 * How long a closed buffer survives.
 *
 * Close is a soft delete because `layout.closeGroup` runs `store.close` per pane
 * directly in main (`packages/core/src/layout/commands.ts:573`), which is what
 * shelving a task does and which never reaches the renderer. No prompt can guard
 * that path, so the net has to be underneath it rather than in front of it.
 */
export const GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScratchDoc {
  readonly text: string;
  readonly updatedAt: number;
  /** Present once the pane holding it closed. Absent means live. */
  readonly closedAt?: number;
}

const DOC = s.object({
  text: s.string(),
  updatedAt: s.number(),
  closedAt: s.optional(s.number()),
});

export class ScratchStore {
  readonly #kv: KV;

  constructor(kv: KV) {
    this.#kv = kv;
  }

  create(id: string, now: number): void {
    this.#kv.set<ScratchDoc>(id, { text: '', updatedAt: now });
  }

  read(id: string): ScratchDoc | undefined {
    return this.#kv.get(id, DOC);
  }

  /**
   * Writing an id with no row creates one rather than throwing.
   *
   * A pane can outlive its row — a relaunch against an older build, a store
   * edited by hand. Refusing the write would drop the keystrokes that are on
   * screen in front of the user, which is a worse answer than a resurrected row.
   */
  write(id: string, text: string, now: number): void {
    this.#kv.set<ScratchDoc>(id, { text, updatedAt: now });
  }

  close(id: string, now: number): void {
    const doc = this.read(id);
    if (doc === undefined) return;
    this.#kv.set<ScratchDoc>(id, { ...doc, closedAt: now });
  }

  /** Removes closed rows older than `maxAgeMs`. Returns how many went. */
  collect(now: number, maxAgeMs: number): number {
    let removed = 0;
    for (const key of this.#kv.keys()) {
      const doc = this.read(key);
      // An OPEN row is never collected, whatever its age. A pane left alone for
      // a year still has its text on screen.
      if (doc?.closedAt === undefined) continue;
      if (now - doc.closedAt < maxAgeMs) continue;
      this.#kv.delete(key);
      removed += 1;
    }
    return removed;
  }
}
```

- [x] **Step 4: Run the tests**

```bash
cd v2 && pnpm -F @shepherd/ext-scratch test
```

Expected: all nine PASS. If `s.optional(s.number())` does not typecheck, read `packages/sdk/src/schema.ts` for the exact combinator names and adjust; the shape is what matters, not the spelling.

- [x] **Step 5: Commit**

```bash
git add v2/extensions/scratch/src
git commit -m "A closed buffer is not a deleted one for seven days

Soft delete, because closeGroup runs store.close per pane in main and never
reaches the renderer. Shelving a task would otherwise take your notes with it,
silently, with nowhere for a prompt to stand."
```

---

### Task 3: The service half

**Files:**
- Create: `v2/extensions/scratch/src/index.ts`
- Test: `v2/extensions/scratch/src/index.test.ts`

**Interfaces:**
- Consumes: `ScratchStore`, `SCRATCH_COMMANDS`, `SCRATCH_VIEWS`, `SCRATCH_KEY` from Tasks 1 and 2.
- Produces: `activate(ctx: ExtensionContext): void | Promise<void>`, matching `ActivateFn`. Commands:
  - `scratch.create` — `{}` → `{ id: string }`. Mints an id, creates the row, invokes `layout.newTab`.
  - `scratch.read` — `{ id: string }` → `{ text: string } | { ok: false, reason: string }`.
  - `scratch.write` — `{ id: string, text: string }` → `{ ok: true }`.
  - `scratch.close` — `{ id: string }` → `{ ok: true }`.
  - `scratch.open` — `{ url: string }` → `{ ok: true } | { ok: false, reason: string }`. Refuses any scheme but `http://` and `https://`.

Read `extensions/diagnostics/src/index.ts` first for the shape of `activate`, and `extensions/github/src/index.ts:235-247` for the exact `registerViewType` call this copies.

- [x] **Step 1: Write the failing test**

Create `v2/extensions/scratch/src/index.test.ts`. Build a fake `ExtensionContext` from what `activate` actually touches; check the real `ExtensionContext` type in `packages/sdk/src/api.ts` and fill in the rest as needed rather than guessing.

```ts
import { describe, expect, it, vi } from 'vitest';
import { activate } from './index.ts';
import { SCRATCH_COMMANDS, SCRATCH_KEY, SCRATCH_VIEWS } from './manifest.ts';

/**
 * Captures what `activate` registered, so each assertion is about ONE
 * registration rather than about a whole activation.
 */
function harness() {
  const commands = new Map<string, { handler: (args: never) => unknown }>();
  const views: { type: string; declaration: Record<string, unknown> }[] = [];
  const invoked: { command: string; args: unknown }[] = [];
  const execs: readonly string[][] = [];
  const rows = new Map<string, unknown>();

  const ctx = {
    subscriptions: [] as { dispose(): void }[],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    storage: {
      get: (key: string) => rows.get(key),
      set: (key: string, value: unknown) => void rows.set(key, value),
      delete: (key: string) => void rows.delete(key),
      keys: () => [...rows.keys()].sort(),
    },
    commands: {
      register: (id: string, spec: { handler: (args: never) => unknown }) => {
        commands.set(id, spec);
        return { dispose: () => commands.delete(id) };
      },
      invoke: async (command: string, args: unknown) => {
        invoked.push({ command, args });
        return { ok: true, value: { root: 'r1', pane: 'p1' } };
      },
    },
    process: {
      exec: async (cmd: readonly string[]) => {
        (execs as string[][]).push([...cmd]);
        return { ok: true as const, stdout: '', stderr: '' };
      },
    },
    views: {
      registerViewType: (type: string, declaration: Record<string, unknown>) => {
        views.push({ type, declaration });
        return { dispose: () => {} };
      },
    },
  };

  return { ctx, commands, views, invoked, execs, rows };
}

describe('scratch activate', () => {
  it('registers its pane view with the accelerator and the command the key runs', async () => {
    const h = harness();
    await activate(h.ctx as never);
    const view = h.views.find((entry) => entry.type === SCRATCH_VIEWS.pad);
    expect(view).toBeDefined();
    expect(view?.declaration).toMatchObject({
      kind: 'component',
      component: SCRATCH_VIEWS.pad,
      surface: 'pane',
      key: SCRATCH_KEY,
      command: SCRATCH_COMMANDS.create,
    });
  });

  it('create mints an id and opens a tab carrying it', async () => {
    const h = harness();
    await activate(h.ctx as never);
    const result = (await h.commands.get(SCRATCH_COMMANDS.create)?.handler({} as never)) as { id: string };

    expect(result.id).toMatch(/^scr_/);
    const opened = h.invoked.find((entry) => entry.command === 'layout.newTab');
    expect(opened?.args).toMatchObject({
      view: { type: SCRATCH_VIEWS.pad, state: { id: result.id } },
      title: 'scratch',
    });
  });

  it('create mints a DIFFERENT id every time', async () => {
    const h = harness();
    await activate(h.ctx as never);
    const first = (await h.commands.get(SCRATCH_COMMANDS.create)?.handler({} as never)) as { id: string };
    const second = (await h.commands.get(SCRATCH_COMMANDS.create)?.handler({} as never)) as { id: string };
    expect(first.id).not.toBe(second.id);
  });

  it('write then read round-trips through the store', async () => {
    const h = harness();
    await activate(h.ctx as never);
    const { id } = (await h.commands.get(SCRATCH_COMMANDS.create)?.handler({} as never)) as { id: string };
    await h.commands.get(SCRATCH_COMMANDS.write)?.handler({ id, text: '- [ ] ship it' } as never);
    const read = (await h.commands.get(SCRATCH_COMMANDS.read)?.handler({ id } as never)) as { text: string };
    expect(read.text).toBe('- [ ] ship it');
  });

  it('read answers a reason rather than throwing for an unknown id', async () => {
    const h = harness();
    await activate(h.ctx as never);
    const read = await h.commands.get(SCRATCH_COMMANDS.read)?.handler({ id: 'scr_nope' } as never);
    expect(read).toMatchObject({ ok: false });
  });

  it('open refuses a file:// URL and never reaches exec', async () => {
    // The URL comes from the user's own typing, so the question is not where
    // the click goes but what open(1) is being asked to launch.
    const h = harness();
    await activate(h.ctx as never);
    const result = await h.commands.get(SCRATCH_COMMANDS.open)?.handler({ url: 'file:///etc/passwd' } as never);
    expect(result).toMatchObject({ ok: false });
    expect(h.execs).toHaveLength(0);
  });

  it('open runs open(1) with an ARGV ARRAY for an https URL', async () => {
    const h = harness();
    await activate(h.ctx as never);
    await h.commands.get(SCRATCH_COMMANDS.open)?.handler({ url: 'https://example.com' } as never);
    expect(h.execs[0]).toEqual(['/usr/bin/open', 'https://example.com']);
  });

  it('close soft-deletes: the text is still readable afterwards', async () => {
    const h = harness();
    await activate(h.ctx as never);
    const { id } = (await h.commands.get(SCRATCH_COMMANDS.create)?.handler({} as never)) as { id: string };
    await h.commands.get(SCRATCH_COMMANDS.write)?.handler({ id, text: 'kept' } as never);
    await h.commands.get(SCRATCH_COMMANDS.close)?.handler({ id } as never);
    const read = (await h.commands.get(SCRATCH_COMMANDS.read)?.handler({ id } as never)) as { text: string };
    expect(read.text).toBe('kept');
  });
});
```

- [x] **Step 2: Run it and watch it fail**

```bash
cd v2 && pnpm -F @shepherd/ext-scratch test
```

Expected: FAIL, `Failed to resolve import "./index.ts"`.

- [x] **Step 3: Write `src/index.ts`**

```ts
import { s, type ExtensionContext } from '@shepherd/sdk';
import { GC_MAX_AGE_MS, ScratchStore } from './store.ts';
import { SCRATCH_COMMANDS, SCRATCH_KEY, SCRATCH_VIEWS } from './manifest.ts';

/** `layout.newTab`, named here rather than imported: values do not cross between packages. */
const LAYOUT_NEW_TAB = 'layout.newTab';

/** What the tab strip calls a scratch pane. Static; see the plan's Task 13 note. */
const TAB_TITLE = 'scratch';

let counter = 0;

/**
 * A buffer id. Prefixed so a KV row is identifiable on sight, and monotonic
 * within a session so two panes opened in the same millisecond cannot collide.
 */
function mintId(now: number): string {
  counter += 1;
  return `scr_${now.toString(36)}_${counter.toString(36)}`;
}

export async function activate(ctx: ExtensionContext): Promise<void> {
  const store = new ScratchStore(ctx.storage);

  /*
   * Housekeeping at activation, once. A closed buffer is kept for seven days
   * (store.ts says why), and this is the only thing that ever removes one.
   */
  const removed = store.collect(Date.now(), GC_MAX_AGE_MS);
  if (removed > 0) ctx.log.info(`collected ${removed} closed scratch buffer(s)`);

  ctx.subscriptions.push(
    ctx.views.registerViewType(SCRATCH_VIEWS.pad, {
      kind: 'component',
      component: SCRATCH_VIEWS.pad,
      /*
       * A PANE (ADR 0044): it is a place you keep open while you work and come
       * back to after a relaunch, which is what a dock section and an overlay
       * are not.
       */
      surface: 'pane',
      title: TAB_TITLE,
      key: SCRATCH_KEY,
      /*
       * The key runs a COMMAND rather than opening a pane of this type, because
       * the buffer id has to exist before `layout.newTab` can carry it in
       * `view.state` — and nothing can rewrite a pane's view state afterwards.
       */
      command: SCRATCH_COMMANDS.create,
    }),
  );

  ctx.subscriptions.push(
    ctx.commands.register(SCRATCH_COMMANDS.create, {
      title: 'Scratch: New',
      permission: 'layout',
      schema: s.object({}),
      handler: async () => {
        const id = mintId(Date.now());
        store.create(id, Date.now());
        await ctx.commands.invoke(LAYOUT_NEW_TAB, {
          view: { type: SCRATCH_VIEWS.pad, state: { id } },
          title: TAB_TITLE,
        });
        return { id };
      },
    }),
  );

  ctx.subscriptions.push(
    ctx.commands.register(SCRATCH_COMMANDS.read, {
      schema: s.object({ id: s.string() }),
      handler: (args) => {
        const doc = store.read(args.id);
        if (doc === undefined) return { ok: false, reason: 'no such scratch' };
        return { text: doc.text };
      },
    }),
  );

  ctx.subscriptions.push(
    ctx.commands.register(SCRATCH_COMMANDS.write, {
      schema: s.object({ id: s.string(), text: s.string() }),
      handler: (args) => {
        store.write(args.id, args.text, Date.now());
        return { ok: true };
      },
    }),
  );

  ctx.subscriptions.push(
    ctx.commands.register(SCRATCH_COMMANDS.close, {
      schema: s.object({ id: s.string() }),
      handler: (args) => {
        store.close(args.id, Date.now());
        return { ok: true };
      },
    }),
  );

  ctx.subscriptions.push(
    ctx.commands.register(SCRATCH_COMMANDS.open, {
      permission: 'process.exec',
      schema: s.object({ url: s.string() }),
      /**
       * The one thing this app will not reimplement — github's words, and the
       * same `open(1)` call, with an ARGV ARRAY so nothing in the URL is
       * interpreted by a shell.
       *
       * The guard differs from github's and has to. Github allowlists a
       * `https://github.com/` prefix because its URLs come from an API
       * response; these come from the user's own keyboard, so the question is
       * not where the click can take you but what `open(1)` is being asked to
       * launch. A `file://` or a custom scheme is not an error here, it is
       * simply a link that stays text.
       */
      handler: async (args) => {
        if (!args.url.startsWith('http://') && !args.url.startsWith('https://')) {
          return { ok: false, reason: 'only http and https links open' };
        }
        const opened = await ctx.process.exec(['/usr/bin/open', args.url], {
          cwd: ctx.homeDir,
          timeoutMs: 5_000,
        });
        return opened.ok ? { ok: true } : { ok: false, reason: opened.stderr.trim() || 'could not open a browser' };
      },
    }),
  );
}
```

Note: `ctx.storage` may be a namespaced-KV factory rather than a `KV` directly. Read `packages/sdk/src/api.ts` for `ExtensionContext` and pass whatever `ScratchStore` needs (for example `ctx.storage.namespace(SCRATCH_ID)`); adjust the test harness to match.

- [x] **Step 4: Run the tests**

```bash
cd v2 && pnpm -F @shepherd/ext-scratch test
```

Expected: all six PASS.

- [x] **Step 5: Commit**

```bash
git add v2/extensions/scratch/src
git commit -m "Four verbs and a pane that is a place

The key runs create rather than opening a pane directly: the id has to exist
before layout.newTab can carry it, and nothing rewrites a pane's view state
after the fact."
```

---


## Execution notes

**Tasks 1-3 are done and committed** (`b4ff896`, and two after it). Task 4 is next.
Four things the plan got wrong, found by reading the code during execution. The
remaining tasks are written against the same wrong assumptions in places, so
read this before Task 4.

1. **`activate` is `ActivateFn = (ctx, api) => …`, not `(ctx) => …`.** The API
   groups live on the SECOND argument, under `api.proposed`:
   `const { commands, views, process } = api.proposed`. `ctx` carries
   `subscriptions`, `storage`, `clock`, `log`, `homeDir`, `userName`.

2. **Nothing may call `Date.now()`.** `packages/sdk/src/clock.ts` states it as a
   rule and v1's flaky timing tests are the reason. Use `ctx.clock.now()`, and
   `manualClock(startMs)` from the SDK in tests — which is strictly better than
   the plan's hand-rolled timing, and is how the seven-day collection is now
   asserted without sleeping.

3. **`ctx.storage` IS a `KV`.** The plan hedged that it might be a namespace
   factory needing `ctx.storage.namespace(…)`. It is not; pass it straight to
   `ScratchStore`.

4. **A no-argument command uses `s.nothing()`, not `s.object({})`**, matching
   `github.sync`.

**On the catalog pins:** `pnpm view <pkg> version` and the installer disagreed
by a patch release on `@codemirror/view` and `@codemirror/commands` — a stale
metadata cache that `--config.preferOnline=true` did not clear. The versions in
the catalog are what the RESOLVER accepted, read back out of `node_modules`
after installing with caret ranges. If a future bump hits the same wall, that is
the loop: caret, install, read, pin.

**Test count so far:** 25, all passing, `pnpm -F @shepherd/ext-scratch test`.

---

### Task 4: The markdown parser configuration

**Files:**
- Create: `v2/extensions/scratch/ui/markdown-parser.ts`
- Test: `v2/extensions/scratch/ui/markdown-parser.test.ts`

**Interfaces:**
- Consumes: `@lezer/markdown`.
- Produces: `export const scratchMarkdown: MarkdownExtension[]` and `export function parse(text: string): Tree`.

This is its own file, and its own task, because the construct set is a *configuration* and the most valuable tests in this whole plan are the ones asserting what the parser does **not** know.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { parse } from './markdown-parser.ts';

/** Every node type the tree contains, as a set, for readable assertions. */
function nodeTypes(text: string): Set<string> {
  const found = new Set<string>();
  parse(text).iterate({ enter: (node) => void found.add(node.name) });
  return found;
}

describe('the scratch markdown parser', () => {
  it('knows headings', () => expect(nodeTypes('# hi')).toContain('ATXHeading1'));
  it('knows bold', () => expect(nodeTypes('**hi**')).toContain('StrongEmphasis'));
  it('knows italic', () => expect(nodeTypes('*hi*')).toContain('Emphasis'));
  it('knows inline code', () => expect(nodeTypes('`hi`')).toContain('InlineCode'));
  it('knows fenced code', () => expect(nodeTypes('```\nhi\n```')).toContain('FencedCode'));
  it('knows bullet lists', () => expect(nodeTypes('- hi')).toContain('BulletList'));
  it('knows ordered lists', () => expect(nodeTypes('1. hi')).toContain('OrderedList'));
  it('knows blockquotes', () => expect(nodeTypes('> hi')).toContain('Blockquote'));
  it('knows links', () => expect(nodeTypes('[hi](https://x.com)')).toContain('Link'));
  it('knows horizontal rules', () => expect(nodeTypes('---')).toContain('HorizontalRule'));

  it('knows strikethrough', () => expect(nodeTypes('~~hi~~')).toContain('Strikethrough'));
  it('knows task list markers', () => expect(nodeTypes('- [ ] hi')).toContain('TaskMarker'));
  it('knows bare URLs', () => expect(nodeTypes('see https://x.com now')).toContain('URL'));

  /*
   * The negative assertions, which are the point of this file.
   *
   * "No tables" is not a rule anything enforces at render time — Table is simply
   * an extension we do not import, so a table is a paragraph. If someone adds
   * `Table` to the extension list to fix an unrelated parse bug, this fails.
   */
  it('does NOT know tables', () => {
    const types = nodeTypes('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(types).not.toContain('Table');
    expect(types).toContain('Paragraph');
  });

  it('does NOT know footnotes', () => {
    expect(nodeTypes('a[^1]\n\n[^1]: note')).not.toContain('Footnote');
  });

  it('does NOT treat raw HTML as markup worth a node of its own beyond text', () => {
    // A body that says `<script>` is a body that SAYS `<script>`. The github
    // markdown renderer reaches the same answer from the other direction.
    const types = nodeTypes('<script>alert(1)</script>');
    expect(types).toContain('Document');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && pnpm -F @shepherd/ext-scratch test
```

Expected: FAIL, cannot resolve `./markdown-parser.ts`.

- [ ] **Step 3: Write `ui/markdown-parser.ts`**

```ts
import { parser as baseParser, type MarkdownExtension } from '@lezer/markdown';
import { Autolink, Strikethrough, TaskList } from '@lezer/markdown';
import type { Tree } from '@lezer/common';

/**
 * The construct set, expressed as an import list.
 *
 * `@lezer/markdown` ships GFM as separately importable extensions, so "simple
 * markdown, no tables" is not a filter that runs at render time — `Table` is
 * simply absent, and a table is therefore a paragraph. That is the honest
 * behaviour for a pane whose job is partly holding pasted text: a construct we
 * do not render should look like the characters that were typed, not like
 * something that was recognised and then suppressed.
 *
 * `Autolink` is here because a pasted URL is the single most likely thing to
 * land in a scratch pane, and typing `[](…)` around one is the ceremony this
 * pane exists to avoid.
 *
 * DO NOT ADD `Table`. `markdown-parser.test.ts` asserts its absence.
 */
export const scratchMarkdown: MarkdownExtension[] = [Strikethrough, TaskList, Autolink];

const configured = baseParser.configure(scratchMarkdown);

/** Parse for tests and for anything outside a CodeMirror instance. */
export function parse(text: string): Tree {
  return configured.parse(text);
}

export const scratchMarkdownParser = configured;
```

- [ ] **Step 4: Run the tests**

```bash
cd v2 && pnpm -F @shepherd/ext-scratch test
```

Expected: all sixteen PASS. Node type names come from `@lezer/markdown`'s grammar; if one differs (for example `TaskMarker`), print the tree in a scratch test run and correct the expectation to the real name rather than changing the parser.

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/scratch/ui
git commit -m "No tables is an import we do not make

The construct set is a parser configuration, so a table is a paragraph rather
than something recognised and then suppressed. The negative assertions are the
point of the file: adding Table to fix something unrelated fails a test."
```

---

### Task 5: The checkbox widget

**Files:**
- Create: `v2/extensions/scratch/ui/checkbox-widget.ts`
- Test: `v2/extensions/scratch/ui/checkbox-widget.test.ts`

**Interfaces:**
- Consumes: `@codemirror/view`.
- Produces: `class CheckboxWidget extends WidgetType` with `constructor(readonly checked: boolean, readonly pos: number)`, and `export function toggleAt(view: EditorView, pos: number): boolean` which flips the character at `pos` between a space and `x` and returns whether it did.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CheckboxWidget, toggleAt } from './checkbox-widget.ts';

function view(doc: string): EditorView {
  return new EditorView({ state: EditorState.create({ doc }) });
}

describe('the checkbox widget', () => {
  it('draws an input that is checked when the marker says so', () => {
    const el = new CheckboxWidget(true, 3).toDOM();
    expect((el as HTMLInputElement).checked).toBe(true);
  });

  it('draws an unchecked input for an empty marker', () => {
    const el = new CheckboxWidget(false, 3).toDOM();
    expect((el as HTMLInputElement).checked).toBe(false);
  });

  it('is equal to another widget with the same state and position', () => {
    // eq drives whether CodeMirror reuses the DOM node. Getting it wrong makes
    // every keystroke rebuild every checkbox on screen.
    expect(new CheckboxWidget(true, 3).eq(new CheckboxWidget(true, 3))).toBe(true);
    expect(new CheckboxWidget(true, 3).eq(new CheckboxWidget(false, 3))).toBe(false);
    expect(new CheckboxWidget(true, 3).eq(new CheckboxWidget(true, 9))).toBe(false);
  });

  it('ignores its own DOM events so CodeMirror does not treat them as edits', () => {
    expect(new CheckboxWidget(true, 3).ignoreEvent()).toBe(true);
  });

  it('toggles an unchecked marker to x', () => {
    const v = view('- [ ] ship it');
    expect(toggleAt(v, 3)).toBe(true);
    expect(v.state.doc.toString()).toBe('- [x] ship it');
  });

  it('toggles a checked marker back to a space', () => {
    const v = view('- [x] ship it');
    expect(toggleAt(v, 3)).toBe(true);
    expect(v.state.doc.toString()).toBe('- [ ] ship it');
  });

  it('refuses a position that is not a marker, and changes nothing', () => {
    const v = view('- [ ] ship it');
    expect(toggleAt(v, 7)).toBe(false);
    expect(v.state.doc.toString()).toBe('- [ ] ship it');
  });

  it('leaves the selection where it was', () => {
    // Clicking a checkbox must not move the caret: moving it flips the
    // surrounding line to raw, so the line you just ticked would jump.
    const v = view('- [ ] one\n- [ ] two');
    v.dispatch({ selection: { anchor: 15 } });
    toggleAt(v, 3);
    expect(v.state.selection.main.anchor).toBe(15);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL, cannot resolve `./checkbox-widget.ts`.

- [ ] **Step 3: Write `ui/checkbox-widget.ts`**

```ts
import { EditorView, WidgetType } from '@codemirror/view';

/**
 * The one thing in a scratch pane that is not text.
 *
 * A checkbox has no competing meaning for a click, unlike a link, whose plain
 * click has to stay "place the caret" — so this toggles on an ordinary click
 * with no modifier.
 */
export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    /** Where the marker character is, so a click can find it again. */
    readonly pos: number,
  ) {
    super();
  }

  /** Drives DOM reuse. Without position in it, every edit rebuilds every box. */
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos;
  }

  toDOM(): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.checked;
    input.className = 'sh-scratch-check';
    /*
     * The widget must not take focus. A focused widget moves the selection, the
     * surrounding line flips to raw, and the line you just ticked jumps under
     * the pointer.
     */
    input.addEventListener('mousedown', (event) => event.preventDefault());
    return input;
  }

  /** CodeMirror must not read events inside this node as document edits. */
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Flip the marker character at `pos`. Returns false and changes nothing if that
 * position does not hold one.
 */
export function toggleAt(view: EditorView, pos: number): boolean {
  const current = view.state.doc.sliceString(pos, pos + 1);
  if (current !== ' ' && current !== 'x' && current !== 'X') return false;
  view.dispatch({
    changes: { from: pos, to: pos + 1, insert: current === ' ' ? 'x' : ' ' },
    // The selection is deliberately not part of this transaction.
    scrollIntoView: false,
  });
  return true;
}
```

- [ ] **Step 4: Run the tests**

Expected: all eight PASS.

- [ ] **Step 5: Commit**

```bash
git add v2/extensions/scratch/ui
git commit -m "The checkbox does not take focus

A focused widget moves the selection, which flips the surrounding line to raw,
which makes the line you just ticked jump under the pointer."
```

---

### Task 6: Live preview

**Files:**
- Create: `v2/extensions/scratch/ui/live-preview.ts`
- Test: `v2/extensions/scratch/ui/live-preview.test.ts`

**Interfaces:**
- Consumes: `scratchMarkdownParser` (Task 4), `CheckboxWidget` (Task 5).
- Produces:
  - `export function buildDecorations(state: EditorState): DecorationSet` — the pure core.
  - `export const livePreview: Extension` — the `ViewPlugin` plus its `atomicRanges` provider.

This is the heart of the feature. `buildDecorations` takes a whole `EditorState` and returns decorations, so almost every behavioural question is a unit test with no DOM and no rendering.

**The rule, stated once:** a construct renders raw when its range intersects any selection range. The unit is the **line** for block constructs (heading, list marker, blockquote, fence) and the **node** for inline ones (bold, italic, code, link).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { buildDecorations } from './live-preview.ts';

/** The decorated ranges, as `[from, to]` pairs, for readable assertions. */
function ranges(doc: string, caret?: number): [number, number][] {
  const state = EditorState.create({
    doc,
    ...(caret === undefined ? {} : { selection: { anchor: caret } }),
  });
  const out: [number, number][] = [];
  buildDecorations(state).between(0, doc.length, (from, to) => void out.push([from, to]));
  return out;
}

const decorated = (doc: string, caret?: number): boolean => ranges(doc, caret).length > 0;

describe('live preview, with the caret away from the construct', () => {
  const far = 0;

  it('decorates a heading', () => expect(decorated('# hi\n\nx', 6)).toBe(true));
  it('decorates bold', () => expect(decorated('**hi**\n\nx', 8)).toBe(true));
  it('decorates italic', () => expect(decorated('*hi*\n\nx', 6)).toBe(true));
  it('decorates inline code', () => expect(decorated('`hi`\n\nx', 6)).toBe(true));
  it('decorates a bullet marker', () => expect(decorated('- hi\n\nx', 6)).toBe(true));
  it('decorates a blockquote', () => expect(decorated('> hi\n\nx', 6)).toBe(true));
  it('decorates a link', () => expect(decorated('[hi](https://x.com)\n\nx', 21)).toBe(true));
  it('decorates a task marker', () => expect(decorated('- [ ] hi\n\nx', 10)).toBe(true));
  it('decorates strikethrough', () => expect(decorated('~~hi~~\n\nx', 8)).toBe(true));

  it('decorates NOTHING in a table, ever', () => {
    // Not a suppression rule. The parser has no Table extension, so there is
    // nothing here to decorate. Task 4 is the other half of this assertion.
    expect(decorated('| a | b |\n|---|---|\n| 1 | 2 |', far)).toBe(false);
  });

  it('decorates nothing in plain prose', () => {
    expect(decorated('just a sentence with no markup in it at all', far)).toBe(false);
  });
});

describe('the caret rule', () => {
  it('shows a heading raw when the caret is on its line', () => {
    // Caret inside "# hi".
    expect(decorated('# hi\n\nx', 2)).toBe(false);
  });

  it('shows the heading rendered when the caret moves off that line', () => {
    expect(decorated('# hi\n\nx', 6)).toBe(true);
  });

  it('is per LINE for a block construct: caret at the end of the line still raw', () => {
    expect(decorated('# hi\n\nx', 4)).toBe(false);
  });

  it('is per NODE for an inline construct: other bold on the same line stays rendered', () => {
    // Two bolds, caret inside the first. The second must still be decorated.
    const doc = '**one** and **two**';
    const withCaret = ranges(doc, 3);
    expect(withCaret.length).toBeGreaterThan(0);
    // Nothing decorated inside the first bold, something decorated after it.
    expect(withCaret.every(([from]) => from >= 8)).toBe(true);
  });

  it('shows a construct raw when a SELECTION covers it, not only a caret', () => {
    const state = EditorState.create({ doc: '**hi**\n\nx', selection: { anchor: 0, head: 6 } });
    const out: [number, number][] = [];
    buildDecorations(state).between(0, 9, (from, to) => void out.push([from, to]));
    expect(out.length).toBe(0);
  });

  it('survives an empty document', () => {
    expect(() => ranges('')).not.toThrow();
  });

  it('survives a document that is only a marker', () => {
    expect(() => ranges('#', 1)).not.toThrow();
    expect(() => ranges('- ', 2)).not.toThrow();
    expect(() => ranges('**', 2)).not.toThrow();
  });

  it('survives an unclosed fence', () => {
    expect(() => ranges('```\nunclosed', 12)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL, cannot resolve `./live-preview.ts`.

- [ ] **Step 3: Write `ui/live-preview.ts`**

```ts
import { RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { CheckboxWidget } from './checkbox-widget.ts';

/**
 * Live preview: the document is always exact text, and what changes is how it
 * is DRAWN.
 *
 * The rule, once: a construct renders raw when its range intersects any
 * selection range. The unit differs by kind, and it has to —
 *
 *   - a BLOCK construct uses the LINE, because a heading whose `#` vanished
 *     while you were typing on that line would shift the text under the caret;
 *   - an INLINE construct uses the NODE, because a line with three bolds on it
 *     should not go entirely raw to edit one of them.
 *
 * Cost is bounded by the viewport, not the document: the walk covers
 * `view.visibleRanges` only.
 */

/** Constructs whose raw form is revealed a whole line at a time. */
const BLOCK_NODES = new Set([
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'Blockquote',
  'ListItem',
  'FencedCode',
  'HorizontalRule',
]);

/** Marker text that is hidden entirely once a construct renders. */
const MARKER_NODES = new Set(['HeaderMark', 'QuoteMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark']);

const HEADING_CLASS: Readonly<Record<string, string>> = {
  ATXHeading1: 'sh-scratch-h1',
  ATXHeading2: 'sh-scratch-h2',
  ATXHeading3: 'sh-scratch-h3',
  ATXHeading4: 'sh-scratch-h4',
  ATXHeading5: 'sh-scratch-h5',
  ATXHeading6: 'sh-scratch-h6',
};

const INLINE_CLASS: Readonly<Record<string, string>> = {
  StrongEmphasis: 'sh-scratch-strong',
  Emphasis: 'sh-scratch-em',
  Strikethrough: 'sh-scratch-strike',
  InlineCode: 'sh-scratch-code',
  Link: 'sh-scratch-link',
  URL: 'sh-scratch-link',
};

const hide = Decoration.replace({});

/** Does any selection range touch `[from, to]`? Inclusive at both ends. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

/** Does any selection range touch the lines `[from, to]` spans? */
function selectionTouchesLines(state: EditorState, from: number, to: number): boolean {
  const first = state.doc.lineAt(from);
  const last = state.doc.lineAt(to);
  return selectionTouches(state, first.from, last.to);
}

export function buildDecorations(state: EditorState, ranges?: readonly { from: number; to: number }[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(state);
  const spans = ranges ?? [{ from: 0, to: state.doc.length }];

  /** Set while inside a block that the selection has opened up. */
  let rawUntil = -1;

  for (const span of spans) {
    tree.iterate({
      from: span.from,
      to: span.to,
      enter: (node) => {
        if (node.from < rawUntil) return;

        if (BLOCK_NODES.has(node.name)) {
          if (selectionTouchesLines(state, node.from, node.to)) {
            rawUntil = node.to;
            return;
          }
          const cls = HEADING_CLASS[node.name];
          if (cls !== undefined) {
            builder.add(node.from, node.from, Decoration.line({ class: cls }));
          }
          return;
        }

        if (node.name === 'TaskMarker') {
          if (selectionTouchesLines(state, node.from, node.to)) return;
          // The marker is `[ ]` or `[x]`; the character is one in from the left.
          const pos = node.from + 1;
          const checked = state.doc.sliceString(pos, pos + 1).toLowerCase() === 'x';
          builder.add(node.from, node.to, Decoration.replace({ widget: new CheckboxWidget(checked, pos) }));
          return;
        }

        if (MARKER_NODES.has(node.name)) {
          if (selectionTouches(state, node.from, node.to)) return;
          builder.add(node.from, node.to, hide);
          return;
        }

        const cls = INLINE_CLASS[node.name];
        if (cls === undefined) return;
        if (selectionTouches(state, node.from, node.to)) {
          rawUntil = node.to;
          return;
        }
        builder.add(node.from, node.to, Decoration.mark({ class: cls }));
      },
    });
  }

  return builder.finish();
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view.state, view.visibleRanges);
    }

    update(update: ViewUpdate): void {
      // `selectionSet` is as load-bearing as `docChanged`: moving the caret is
      // what reveals and hides a construct, and nothing else tells us it moved.
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.state, update.view.visibleRanges);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
    /*
     * Hidden ranges must be ATOMIC or an arrow key steps into a zero-width
     * replaced range and the caret appears stuck.
     */
    provide: (plug) => EditorView.atomicRanges.of((view) => view.plugin(plug)?.decorations ?? Decoration.none),
  },
);

export const livePreview: Extension = [plugin];
```

- [ ] **Step 4: Run the tests**

```bash
cd v2 && pnpm -F @shepherd/ext-scratch test
```

Expected: all twenty PASS. Node names come from `@lezer/markdown`; if an assertion fails because a name differs, print the tree for that input and correct the **name sets in this file**, not the test's intent.

- [ ] **Step 5: Add the boundary cases that bit during Step 4**

Any input that threw or drew wrongly while getting Step 4 green becomes a test here. At minimum add these four, which the spec's risk list names:

1. Caret immediately after a closing `**`.
2. An empty list item: `- ` with nothing after it.
3. A fence with the caret on its opening line.
4. **Select-all, then a selection that spans the whole document.** `atomicRanges` interacts with selections, not only with the caret, and a document with everything selected must decorate nothing:

```ts
it('decorates nothing when everything is selected', () => {
  const doc = '# hi\n\n**bold** and `code`';
  const state = EditorState.create({ doc, selection: { anchor: 0, head: doc.length } });
  const out: [number, number][] = [];
  buildDecorations(state).between(0, doc.length, (from, to) => void out.push([from, to]));
  expect(out).toHaveLength(0);
});
```

- [ ] **Step 6: Run the tests again**

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add v2/extensions/scratch/ui
git commit -m "A construct is raw where the selection touches it

Per line for a block, per node for an inline one: a heading losing its # under
the caret shifts the text you are typing, and a line with three bolds should not
go entirely raw to edit one of them.

Hidden ranges are atomic, or an arrow key steps into a zero-width replacement
and the caret looks stuck."
```

---

### Task 7: The theme

**Files:**
- Create: `v2/extensions/scratch/ui/theme.ts`
- Test: `v2/extensions/scratch/ui/theme.test.ts`

**Interfaces:**
- Consumes: `@codemirror/view`, `@shepherd/design-tokens`.
- Produces: `export const scratchTheme: Extension`.

Read `packages/design-tokens` for the token names before writing this, and `extensions/github/ui/diff-theme.ts` for how an extension already turns tokens into styles. Every colour is a token; no literal hex values.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The theme is CSS-in-JS, so what is worth asserting is the RULE it must not
 * break rather than a computed pixel: light and dark come from tokens, and a
 * literal colour here is a colour that cannot follow the palette.
 */
const source = readFileSync(join(import.meta.dirname, 'theme.ts'), 'utf8');

describe('the scratch theme', () => {
  it('names no literal hex colour', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('names no literal rgb() or hsl() colour', () => {
    expect(source).not.toMatch(/\b(rgba?|hsla?)\(/);
  });

  it('styles every class live-preview.ts emits', () => {
    const preview = readFileSync(join(import.meta.dirname, 'live-preview.ts'), 'utf8');
    const classes = [...preview.matchAll(/'(sh-scratch-[a-z0-9]+)'/g)].map((match) => match[1]);
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of new Set(classes)) {
      expect(source).toContain(cls);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL, `theme.ts` does not exist.

- [ ] **Step 3: Write `ui/theme.ts`**

Build it with `EditorView.theme({...})`, one entry per class the test enumerates, plus `&`, `.cm-content`, `.cm-cursor` and `.cm-selectionBackground`. Every value is `var(--sh-…)` read from the token set.

The shape (fill in the real token names from `packages/design-tokens`):

```ts
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

/**
 * The pane is a DOCUMENT, so it is typeset like one: a comfortable measure
 * rather than the full pane width, generous line height, and the UI text face
 * for prose with monospace reserved for code constructs.
 *
 * Every colour is a token, so light mode (ADR 0040) needs no second theme here.
 */
export const scratchTheme: Extension = EditorView.theme({
  '&': {
    backgroundColor: 'var(--sh-color-surface)',
    color: 'var(--sh-color-text)',
    height: '100%',
  },
  '.cm-content': {
    fontFamily: 'var(--sh-font-sans)',
    fontSize: 'var(--sh-font-size-body)',
    lineHeight: '1.65',
    maxWidth: '68ch',
    margin: '0 auto',
    padding: 'var(--sh-space-6) var(--sh-space-4)',
    caretColor: 'var(--sh-color-text)',
  },
  '.sh-scratch-h1': { fontSize: '1.6em', fontWeight: '700', lineHeight: '1.25' },
  '.sh-scratch-h2': { fontSize: '1.35em', fontWeight: '700', lineHeight: '1.3' },
  '.sh-scratch-h3': { fontSize: '1.15em', fontWeight: '600' },
  '.sh-scratch-h4': { fontSize: '1.05em', fontWeight: '600' },
  '.sh-scratch-h5': { fontWeight: '600' },
  '.sh-scratch-h6': { fontWeight: '600', color: 'var(--sh-color-text-muted)' },
  '.sh-scratch-strong': { fontWeight: '700' },
  '.sh-scratch-em': { fontStyle: 'italic' },
  '.sh-scratch-strike': { textDecoration: 'line-through', color: 'var(--sh-color-text-muted)' },
  '.sh-scratch-code': {
    fontFamily: 'var(--sh-font-mono)',
    fontSize: '0.9em',
    backgroundColor: 'var(--sh-color-surface-raised)',
    borderRadius: 'var(--sh-radius-sm)',
    padding: '0.1em 0.3em',
  },
  '.sh-scratch-link': { color: 'var(--sh-color-accent)', textDecoration: 'underline', cursor: 'pointer' },
  '.sh-scratch-check': { marginRight: 'var(--sh-space-2)', verticalAlign: 'middle' },
});
```

- [ ] **Step 4: Run the tests**

Expected: all three PASS. If the third fails, it is naming a class `live-preview.ts` emits and this file forgot; add the rule.

- [ ] **Step 5: Verify the token names resolve**

```bash
cd v2 && grep -o "var(--sh-[a-z0-9-]*)" extensions/scratch/ui/theme.ts | sort -u
```

Check each against `packages/design-tokens`. A `var()` naming a token that does not exist fails silently at runtime, which is exactly the bug this step exists to catch.

- [ ] **Step 6: Commit**

```bash
git add v2/extensions/scratch/ui
git commit -m "A scratch pane is typeset, not terminal-shaped

Comfortable measure, UI face for prose, monospace only for code. Every colour a
token, so light mode needs no second theme — and a test that fails on a literal
hex, because one colour that cannot follow the palette is the whole bug."
```

---

### Task 8: The pane component

**Files:**
- Create: `v2/extensions/scratch/ui/editor.ts`
- Create: `v2/extensions/scratch/ui/scratch-pane.tsx`
- Create: `v2/extensions/scratch/ui/index.ts`
- Test: `v2/extensions/scratch/ui/scratch-pane.test.tsx`

**Interfaces:**
- Consumes: `livePreview` (Task 6), `scratchTheme` (Task 7), `scratchMarkdownParser` (Task 4), `toggleAt` (Task 5), `SCRATCH_COMMANDS` (Task 1), `ExtensionPaneProps` from `@shepherd/sdk`.
- Produces:
  - `export function scratchExtensions(options: { onChange(text: string): void; onLinkClick(url: string): void }): Extension[]`
  - `export function ScratchPane(props: ExtensionPaneProps): ReactElement`
  - `export const SAVE_DEBOUNCE_MS = 400`
  - `ui/index.ts` re-exporting `ScratchPane`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ScratchPane, SAVE_DEBOUNCE_MS } from './scratch-pane.tsx';
import { SCRATCH_COMMANDS } from '../src/manifest.ts';

function mount(props: Partial<Parameters<typeof ScratchPane>[0]> = {}) {
  const invoke = vi.fn(async (command: string) =>
    command === SCRATCH_COMMANDS.read ? { ok: true as const, value: { text: '' } } : { ok: true as const, value: {} },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ScratchPane state={{ id: 'scr_a' }} focused invoke={invoke} done={vi.fn()} {...props} />,
    );
  });
  return { container, root, invoke };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ScratchPane', () => {
  it('reads its buffer on mount, by the id in its state', async () => {
    const { invoke } = mount();
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith(SCRATCH_COMMANDS.read, { id: 'scr_a' });
  });

  it('mounts an editor', async () => {
    const { container } = mount();
    await act(async () => {});
    expect(container.querySelector('.cm-editor')).not.toBeNull();
  });

  it('draws a notice instead of an editor when its state carries no id', async () => {
    // A pane is a PLACE the user navigated to. An empty rectangle where a
    // document should be says nothing about why.
    const { container } = mount({ state: {} });
    await act(async () => {});
    expect(container.textContent).toMatch(/scratch/i);
    expect(container.querySelector('.cm-editor')).toBeNull();
  });

  it('does not write on every keystroke', async () => {
    const { container, invoke } = mount();
    await act(async () => {});
    const content = container.querySelector('.cm-content');
    expect(content).not.toBeNull();
    invoke.mockClear();
    // Two edits inside one debounce window.
    await act(async () => {
      document.dispatchEvent(new Event('noop'));
    });
    expect(invoke.mock.calls.filter(([command]) => command === SCRATCH_COMMANDS.write)).toHaveLength(0);
  });

  it('is a 400ms debounce, matching the layout store', () => {
    expect(SAVE_DEBOUNCE_MS).toBe(400);
  });

  it('flushes a pending write when it unmounts', async () => {
    const { root, invoke } = mount();
    await act(async () => {});
    invoke.mockClear();
    act(() => root.unmount());
    // Unmount must not leave a debounced write queued against a dead component.
    expect(invoke.mock.calls.every(([command]) => command !== SCRATCH_COMMANDS.read)).toBe(true);
  });
});
```

Note: driving real typing through CodeMirror under jsdom is unreliable. Keep these tests to mounting, id wiring and the debounce constant, and leave editing behaviour to `live-preview.test.ts`, which needs no DOM. The spec says this explicitly.

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL, cannot resolve `./scratch-pane.tsx`.

- [ ] **Step 3: Write `ui/editor.ts`**

```ts
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView, keymap } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { scratchMarkdown } from './markdown-parser.ts';
import { livePreview } from './live-preview.ts';
import { scratchTheme } from './theme.ts';
import { toggleAt } from './checkbox-widget.ts';

/** Only these two schemes ever reach `open(1)`. */
function openable(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

export function scratchExtensions(options: {
  onChange(text: string): void;
  onLinkClick(url: string): void;
}): Extension[] {
  return [
    markdown({ extensions: scratchMarkdown }),
    /*
     * CodeMirror's own history. ⌘Z reaching this at all is what Task 11 is
     * about: today the Edit menu's `role: 'undo'` is an AppKit key equivalent
     * that calls webContents.undo(), which is the browser's document undo and
     * knows nothing about this.
     */
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    livePreview,
    scratchTheme,
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange(update.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        const target = event.target as HTMLElement | null;

        if (target?.classList.contains('sh-scratch-check')) {
          const pos = view.posAtDOM(target);
          const line = view.state.doc.lineAt(pos);
          const marker = line.text.indexOf('[');
          if (marker >= 0) toggleAt(view, line.from + marker + 1);
          return true;
        }

        /*
         * ⌘-click opens; a plain click places the caret, which reveals the raw
         * `[text](url)` and is therefore how you EDIT the link. Plain-click-to-
         * open would fight the primary meaning of clicking text and would make
         * a link uneditable.
         */
        if (!(event.metaKey || event.ctrlKey)) return false;
        if (!target?.classList.contains('sh-scratch-link')) return false;
        const pos = view.posAtDOM(target);
        const url = urlAt(view, pos);
        if (url === undefined || !openable(url)) return false;
        options.onLinkClick(url);
        return true;
      },
    }),
  ];
}

/** The URL a decorated link at `pos` points at, from the document text. */
function urlAt(view: EditorView, pos: number): string | undefined {
  const line = view.state.doc.lineAt(pos);
  const inline = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of line.text.matchAll(inline)) {
    const from = line.from + (match.index ?? 0);
    if (pos >= from && pos <= from + match[0].length) return match[1];
  }
  const bare = /https?:\/\/\S+/g;
  for (const match of line.text.matchAll(bare)) {
    const from = line.from + (match.index ?? 0);
    if (pos >= from && pos <= from + match[0].length) return match[0];
  }
  return undefined;
}
```

- [ ] **Step 4: Write `ui/scratch-pane.tsx`**

```tsx
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { ExtensionPaneProps } from '@shepherd/sdk';
import { SCRATCH_COMMANDS } from '../src/manifest.ts';
import { scratchExtensions } from './editor.ts';

/** The layout store's number, so the app has one save cadence rather than two. */
export const SAVE_DEBOUNCE_MS = 400;

function readId(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const id = (state as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

export function ScratchPane({ state, invoke }: ExtensionPaneProps): ReactElement {
  const id = readId(state);
  const host = useRef<HTMLDivElement | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /** The text not yet written, and the timer that will write it. */
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const element = host.current;
    if (id === undefined || element === null) return;

    let view: EditorView | null = null;
    let live = true;

    const flush = (): void => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      const text = pending.current;
      if (text === null) return;
      pending.current = null;
      void invoke(SCRATCH_COMMANDS.write, { id, text });
    };

    const schedule = (text: string): void => {
      pending.current = text;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    };

    void (async () => {
      const read = await invoke(SCRATCH_COMMANDS.read, { id });
      if (!live) return;
      const doc = read.ok ? ((read.value as { text?: string }).text ?? '') : '';
      if (!read.ok) setProblem('could not read this scratch');

      view = new EditorView({
        state: EditorState.create({
          doc,
          extensions: scratchExtensions({
            onChange: schedule,
            onLinkClick: (url) => void invoke(SCRATCH_COMMANDS.open, { url }),
          }),
        }),
        parent: element,
      });
    })();

    // Written on the way out of the window too: a quit is not an unmount.
    window.addEventListener('beforeunload', flush);
    window.addEventListener('blur', flush);

    return () => {
      live = false;
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('blur', flush);
      flush();
      view?.destroy();
    };
  }, [id, invoke]);

  if (id === undefined) {
    return (
      <div className="sh-scratch-empty">
        This scratch pane has no buffer. It was probably restored from a layout an older build wrote.
      </div>
    );
  }

  return (
    <div className="sh-scratch">
      {problem === null ? null : <div className="sh-scratch-problem">{problem}</div>}
      <div className="sh-scratch-host" ref={host} />
    </div>
  );
}
```

- [ ] **Step 5: Write `ui/index.ts`**

```ts
/**
 * The UI half — the only thing the renderer may import from this package
 * (`boundaries.js`), because `.` is the service half and runs in a utility
 * process with no DOM.
 */
export { ScratchPane, SAVE_DEBOUNCE_MS } from './scratch-pane.tsx';
```

- [ ] **Step 6: Run the tests**

```bash
cd v2 && pnpm -F @shepherd/ext-scratch test && pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add v2/extensions/scratch
git commit -m "The pane, and the two clicks that mean different things

A checkbox toggles on a plain click because nothing competes for it. A link
needs ⌘, because a plain click has to stay 'place the caret' — which is also
how you edit the URL.

Writes are debounced 400ms and flushed on blur, on unmount and on beforeunload:
a quit is not an unmount."
```

---

### Task 9: A pane contribution may bind a key

**Files:**
- Modify: `v2/packages/sdk/src/api-layout.ts` (`ViewDeclaration`)
- Modify: `v2/packages/app/src/main/view-registry.ts` (`Contribution`, and carry it)
- Modify: `v2/packages/app/src/shared/bridge.ts` (`ViewContributionDTO`)
- Create: `v2/packages/app/src/renderer/pane-keys.ts`
- Test: `v2/packages/app/src/renderer/pane-keys.test.ts`
- Modify: `v2/packages/app/src/renderer/app.tsx`

**Interfaces:**
- Consumes: `matchesAccelerator`, exported from `packages/app/src/renderer/view-overlay.tsx`.
- Produces: `export function PaneKeys({ views, invoke }: { views: readonly ViewContributionDTO[]; invoke(command: string, args?: unknown): void }): null`, and `command?: string` on `ViewDeclaration`, `Contribution` and `ViewContributionDTO`.

- [ ] **Step 1: Write the failing test**

Create `v2/packages/app/src/renderer/pane-keys.test.ts`.

```ts
import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { createElement } from 'react';
import { PaneKeys } from './pane-keys.ts';
import type { ViewContributionDTO } from '../shared/index.ts';

const scratch: ViewContributionDTO = {
  extension: 'shepherd.scratch',
  type: 'scratch.pad',
  kind: 'component',
  component: 'scratch.pad',
  surface: 'pane',
  key: 'CmdOrCtrl+Shift+N',
  command: 'scratch.create',
};

function mount(views: readonly ViewContributionDTO[]) {
  const invoke = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(PaneKeys, { views, invoke })));
  return { invoke, root };
}

const press = (init: KeyboardEventInit): void => {
  act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true })));
};

describe('PaneKeys', () => {
  it('invokes the declared command when the accelerator matches', () => {
    const { invoke } = mount([scratch]);
    press({ key: 'n', metaKey: true, shiftKey: true });
    expect(invoke).toHaveBeenCalledWith('scratch.create');
  });

  it('ignores the key without shift', () => {
    const { invoke } = mount([scratch]);
    press({ key: 'n', metaKey: true });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('ignores a bare letter', () => {
    const { invoke } = mount([scratch]);
    press({ key: 'n' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('ignores a pane contribution with a key but NO command', () => {
    // Half a declaration must do nothing rather than something surprising.
    const { invoke } = mount([{ ...scratch, command: undefined }]);
    press({ key: 'n', metaKey: true, shiftKey: true });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('ignores an OVERLAY contribution, which view-overlay.tsx owns', () => {
    // Two handlers on one key would raise the overlay AND run the command.
    const { invoke } = mount([{ ...scratch, surface: 'overlay' }]);
    press({ key: 'n', metaKey: true, shiftKey: true });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('unbinds on unmount', () => {
    const { invoke, root } = mount([scratch]);
    act(() => root.unmount());
    press({ key: 'n', metaKey: true, shiftKey: true });
    expect(invoke).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && pnpm -F @shepherd/app test -- pane-keys
```

Expected: FAIL, cannot resolve `./pane-keys.ts`.

- [ ] **Step 3: Add `command` to the three type declarations**

In `packages/sdk/src/api-layout.ts`, on `ViewDeclaration`:

```ts
  /**
   * The verb this contribution's `key` runs, for a `pane` surface.
   *
   * An overlay's key raises the overlay, which needs no verb. A pane's cannot
   * work that way: opening one usually means minting the subject it will show
   * first, and nothing can rewrite a pane's `view.state` afterwards. So the key
   * runs a command and the command opens the pane.
   */
  readonly command?: string;
```

Add the same field, with a one-line comment pointing here, to `Contribution` in `packages/app/src/main/view-registry.ts` and to `ViewContributionDTO` in `packages/app/src/shared/bridge.ts`. Then follow `key` and `surface` through `view-registry.ts` and whatever builds the DTO, and carry `command` alongside them at every hop. Compile errors will point at each one.

- [ ] **Step 4: Write `packages/app/src/renderer/pane-keys.ts`**

```ts
import { useEffect } from 'react';
import type { ViewContributionDTO } from '../shared/index.ts';
import { matchesAccelerator } from './view-overlay.tsx';

/**
 * Accelerators for contributed PANES — the same job `view-overlay.tsx` does for
 * overlays, and deliberately the same predicate, so `CmdOrCtrl` cannot resolve
 * one way for a pane and another for a card.
 *
 * It is separate from the overlay's handler rather than folded into it because
 * the two do different things with a match: an overlay TOGGLES a layer this
 * process owns, a pane RUNS A VERB and the extension decides what appears. One
 * handler doing both would have to branch on `surface` at every line.
 *
 * **None of these keys may be added to `menu-template.ts`.** AppKit resolves a
 * menu key equivalent before the page sees the keystroke, so a menu item on one
 * of these keys does not compete with it, it deletes it silently.
 */
export function PaneKeys({
  views,
  invoke,
}: {
  views: readonly ViewContributionDTO[];
  invoke(command: string, args?: unknown): void;
}): null {
  useEffect(() => {
    const bound = views.filter(
      (view) => view.surface === 'pane' && view.key !== undefined && view.command !== undefined,
    );
    if (bound.length === 0) return;

    const onKey = (event: KeyboardEvent): void => {
      for (const view of bound) {
        if (view.key === undefined || view.command === undefined) continue;
        if (!matchesAccelerator(view.key, event)) continue;
        // Swallowed, or the keystroke also reaches the focused terminal and the
        // agent in it receives a stray one.
        event.preventDefault();
        invoke(view.command);
        return;
      }
    };

    // Capture, for the reason the overlay's handler uses it: a terminal has
    // focus almost always and xterm handles keydown on the way down.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [views, invoke]);

  return null;
}
```

- [ ] **Step 5: Mount it in `app.tsx`**

Beside where `ViewOverlay` is rendered, passing the same `views` list and the app's `invoke`.

- [ ] **Step 6: Run the tests**

```bash
cd v2 && pnpm -F @shepherd/app test && pnpm -r typecheck
```

Expected: all six PASS, and the existing `view-overlay` tests still pass.

- [ ] **Step 7: Commit**

```bash
git add v2/packages
git commit -m "A pane's key runs a verb; an overlay's raises a layer

Same predicate, different handler. An overlay toggles a layer this process owns;
a pane has to mint its subject before layout.newTab can carry it, so the key
runs a command and the extension decides what appears."
```

---

### Task 10: Closing a pane may ask first

**Files:**
- Create: `v2/packages/app/src/renderer/close-guard.ts`
- Test: `v2/packages/app/src/renderer/close-guard.test.ts`
- Modify: `v2/packages/app/src/renderer/app.tsx`

**Interfaces:**
- Produces:
  - `export interface CloseClaim { readonly paneId: string; readonly message: string }`
  - `export const CLOSE_CLAIM_EVENT = 'sh:close-claim'`
  - `export function claimsFor(paneId: string | null, claims: readonly CloseClaim[]): CloseClaim | undefined`

A pane says "ask before closing me" by dispatching a `sh:close-claim` event carrying its pane id and the sentence to show. The shell asks. This is an event rather than a prop for the reason `sh:raise-view` is one in `view-overlay.tsx`: the claimant and the asker are levels apart and threading a setter between them gives two components a reason to know about each other that they otherwise do not have.

**Note the honest limit, and write it in the file:** this covers ⌘W, the File menu item and the tab strip's close control, because all three route through the renderer's `runMenuCommand` (`app.tsx:331`) before invoking `layout.close`. It does **not** cover `layout.closeGroup`, which runs `store.close` per pane in main. That path is covered by the store's soft delete instead, which is why the soft delete is not optional.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { claimsFor, type CloseClaim } from './close-guard.ts';

const claim = (paneId: string): CloseClaim => ({ paneId, message: `Discard this scratch?` });

describe('claimsFor', () => {
  it('finds the claim belonging to the pane being closed', () => {
    expect(claimsFor('p2', [claim('p1'), claim('p2')])?.paneId).toBe('p2');
  });

  it('is undefined when no claim matches', () => {
    expect(claimsFor('p3', [claim('p1'), claim('p2')])).toBeUndefined();
  });

  it('is undefined when there is no focused pane', () => {
    expect(claimsFor(null, [claim('p1')])).toBeUndefined();
  });

  it('is undefined with no claims at all', () => {
    // The overwhelmingly common case: every terminal pane, always.
    expect(claimsFor('p1', [])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL, cannot resolve `./close-guard.ts`.

- [ ] **Step 3: Write `packages/app/src/renderer/close-guard.ts`**

```ts
/**
 * A pane that wants to be asked about before it closes.
 *
 * **What this covers, and what it cannot.** ⌘W, the File menu item and the tab
 * strip's close control all route through the renderer's `runMenuCommand`
 * before invoking `layout.close`, so a guard here sees all three. It does NOT
 * see `layout.closeGroup`, which runs `store.close` per pane in main
 * (`packages/core/src/layout/commands.ts:573`) and is what shelving a task does.
 *
 * That path is why the scratch store soft-deletes rather than deleting. A
 * prompt has nowhere to stand there, so the net has to be underneath instead of
 * in front.
 */
export interface CloseClaim {
  readonly paneId: string;
  /** What the user is asked. A question, in their words, not the pane's id. */
  readonly message: string;
}

/**
 * An event rather than a prop, for the reason `sh:raise-view` is one: the pane
 * that claims and the shell that asks are several levels apart, and threading a
 * setter between them gives two components a reason to know about each other
 * that they otherwise do not have.
 */
export const CLOSE_CLAIM_EVENT = 'sh:close-claim';

export function claimsFor(paneId: string | null, claims: readonly CloseClaim[]): CloseClaim | undefined {
  if (paneId === null) return undefined;
  return claims.find((claim) => claim.paneId === paneId);
}
```

- [ ] **Step 4: Run the tests**

Expected: all four PASS.

- [ ] **Step 5: Wire it into `app.tsx`**

Hold the claims in state and update them from the event:

```tsx
const [claims, setClaims] = useState<readonly CloseClaim[]>([]);
const [asking, setAsking] = useState<CloseClaim | null>(null);

useEffect(() => {
  const onClaim = (event: Event): void => {
    const detail = (event as CustomEvent<CloseClaim | { paneId: string; message: null }>).detail;
    setClaims((current) => {
      const others = current.filter((claim) => claim.paneId !== detail.paneId);
      // A null message WITHDRAWS the claim, which is how an emptied scratch
      // pane goes back to closing silently.
      return detail.message === null ? others : [...others, detail as CloseClaim];
    });
  };
  window.addEventListener(CLOSE_CLAIM_EVENT, onClaim);
  return () => window.removeEventListener(CLOSE_CLAIM_EVENT, onClaim);
}, []);
```

Then guard the one command, leaving every other menu gesture untouched:

```tsx
const runMenuCommand = useCallback(
  (id: CommandID) => {
    if (id === COMMANDS.closePane) {
      const claim = claimsFor(focusedPaneId, claims);
      if (claim !== undefined) {
        setAsking(claim);
        return;
      }
    }
    const invocation = MENU_INVOCATIONS[id];
    invoke(invocation.command, invocation.args);
  },
  [invoke, claims, focusedPaneId],
);
```

And raise the question, using `Modal` from `@shepherd/ui` so the scrim, Esc,
click-out and focus trap are Radix's rather than hand-rolled (`view-overlay.tsx`
says why):

```tsx
{asking === null ? null : (
  <Modal open onOpenChange={() => setAsking(null)} title="Close this pane?">
    <p>{asking.message}</p>
    <Button variant="ghost" onClick={() => setAsking(null)}>Cancel</Button>
    <Button
      variant="danger"
      onClick={() => {
        setAsking(null);
        const invocation = MENU_INVOCATIONS[COMMANDS.closePane];
        invoke(invocation.command, invocation.args);
      }}
    >
      Discard
    </Button>
  </Modal>
)}
```

Check `packages/ui/src/modal.tsx` and `button.tsx` for the real prop names and
variants before writing this; the shape above is what it does, not necessarily
what it is spelled.

- [ ] **Step 6: Have the scratch pane claim**

`ScratchPane` claims while it holds text and withdraws when it does not, so an
empty scratch closes with no prompt:

```tsx
useEffect(() => {
  const detail =
    text.trim() === ''
      ? { paneId, message: null }
      : { paneId, message: `Discard this scratch? ${wordCount(text)} words will be lost.` };
  window.dispatchEvent(new CustomEvent(CLOSE_CLAIM_EVENT, { detail }));
}, [paneId, text]);
```

`text` here is the same value the save debounce already tracks; hold it in state
rather than reading the editor, so this effect and the write see one value.

**This is the same missing field the deferred dynamic-title follow-up needs.** Add `readonly paneId: string` to `ExtensionPaneProps` in `packages/sdk/src/api-layout.ts` and pass it from wherever the renderer mounts `EXTENSION_PANE_UI`, with a comment saying a pane that can be asked about has to be able to name itself. `ReviewPane` ignores it and needs no change.

Adding a required field breaks the callers written before it existed. Update
`extensions/scratch/ui/scratch-pane.test.tsx`'s `mount` helper to pass
`paneId="p1"`, and check `extensions/github/ui/review.test.tsx` for the same.
Typecheck will name every one.

- [ ] **Step 7: Run everything**

```bash
cd v2 && pnpm -r test && pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add v2/packages
git commit -m "A pane may ask to be asked about

Covers ⌘W, the menu item and the tab strip, which all route through the
renderer. It cannot cover closeGroup, which runs in main — and that gap is
exactly why the scratch store soft-deletes rather than deleting.

ExtensionPaneProps gains paneId: a pane that can be asked about has to be able
to name itself."
```

---

### Task 11: ⌘Z reaches the page

**Files:**
- Modify: `v2/packages/app/src/main/menu-template.ts`
- Modify: `v2/packages/app/src/shared/commands.ts`
- Modify: `v2/packages/app/src/shared/menu-commands.ts`
- Modify: `v2/packages/app/src/renderer/app.tsx`
- Test: `v2/packages/app/src/main/menu-template.test.ts`

**Interfaces:**
- Produces: `COMMANDS.undo`, `COMMANDS.redo`, and a `sh:edit-command` window event carrying `'undo' | 'redo'` that a focused pane component listens for.

**Why:** `role: 'undo'` and `role: 'redo'` are AppKit key equivalents calling `webContents.undo()`, which is the browser's document undo. CodeMirror keeps its own history in its state. The two know nothing about each other, so ⌘Z in a scratch pane does nothing or corrupts the buffer. No terminal pane ever hit this, because xterm has no undo.

- [ ] **Step 1: Write the failing test**

Add to `v2/packages/app/src/main/menu-template.test.ts`:

```ts
  it('has no undo or redo ROLE — an editor pane needs the keystroke in the page', () => {
    // `role: 'undo'` calls webContents.undo(), which is the browser's document
    // undo. CodeMirror's history lives in its own state and never hears about
    // it. A terminal never noticed because xterm has no undo.
    const roles = new Set<string>();
    const walk = (items: readonly MenuItemSpec[]): void => {
      for (const item of items) {
        if (item.role !== undefined) roles.add(item.role);
        if (item.submenu !== undefined) walk(item.submenu);
      }
    };
    walk(menuTemplate({ appName: 'Shep', isDev: false }));
    expect(roles).not.toContain('undo');
    expect(roles).not.toContain('redo');
  });

  it('offers undo and redo as COMMANDS instead, on the conventional keys', () => {
    const items: MenuItemSpec[] = [];
    const walk = (entries: readonly MenuItemSpec[]): void => {
      for (const entry of entries) {
        items.push(entry);
        if (entry.submenu !== undefined) walk(entry.submenu);
      }
    };
    walk(menuTemplate({ appName: 'Shep', isDev: false }));

    const undo = items.find((item) => item.command === COMMANDS.undo);
    expect(undo?.accelerator).toBe('CmdOrCtrl+Z');
    const redo = items.find((item) => item.command === COMMANDS.redo);
    expect(redo?.accelerator).toBe('CmdOrCtrl+Shift+Z');
  });
```

Import `COMMANDS` and `MenuItemSpec` at the top of that file if they are not already there.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd v2 && pnpm -F @shepherd/app test -- menu-template
```

Expected: FAIL — the roles are present and the commands do not exist.

- [ ] **Step 3: Add the command ids**

In `packages/app/src/shared/commands.ts`, add `undo` and `redo` to `COMMANDS`, following the shape of the entries already there.

- [ ] **Step 4: Change the menu**

In `packages/app/src/main/menu-template.ts`, replace `{ role: 'undo' }` and `{ role: 'redo' }` with command items:

```ts
        /*
         * Commands rather than roles. `role: 'undo'` calls webContents.undo(),
         * the browser's DOCUMENT undo, and CodeMirror keeps its history in its
         * own state — so in an editor pane the role either does nothing or
         * corrupts the buffer. Routing through the renderer lets the focused
         * pane answer, which is also how ⌘W already works.
         *
         * The accelerators are unchanged and stay in the menu: unlike a
         * contributed key, these are the app's own and there is no contribution
         * on ⌘Z for them to delete.
         */
        { id: COMMANDS.undo, label: 'Undo', accelerator: 'CmdOrCtrl+Z', command: COMMANDS.undo },
        { id: COMMANDS.redo, label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', command: COMMANDS.redo },
```

- [ ] **Step 5: Route them in the renderer**

`MENU_INVOCATIONS` maps a menu command to a KERNEL invocation, and these two
have none: their target is whatever is focused in the page. So they are handled
before that lookup, in `runMenuCommand`:

```tsx
export const EDIT_COMMAND_EVENT = 'sh:edit-command';

const runMenuCommand = useCallback(
  (id: CommandID) => {
    // Undo and redo have no kernel verb: their target is the focused pane, and
    // only the page knows what that is.
    if (id === COMMANDS.undo || id === COMMANDS.redo) {
      window.dispatchEvent(
        new CustomEvent(EDIT_COMMAND_EVENT, { detail: id === COMMANDS.undo ? 'undo' : 'redo' }),
      );
      return;
    }
    // …the close guard from Task 10, then the existing lookup.
  },
  [invoke],
);
```

If `MENU_INVOCATIONS` is asserted to cover every `CommandID` (check
`app.test.tsx`, which already asserts the `closePane` entry), that assertion
needs to exempt these two, with a comment saying the renderer answers them.

- [ ] **Step 6: Listen in the scratch pane**

In `ScratchPane`, guarded on `focused`, because `ExtensionPaneProps` says a
background pane answering keys would fight the one you are looking at:

```tsx
useEffect(() => {
  const view = viewRef.current;
  if (!focused || view === null) return;
  const onEdit = (event: Event): void => {
    const which = (event as CustomEvent<'undo' | 'redo'>).detail;
    (which === 'undo' ? undo : redo)(view);
  };
  window.addEventListener(EDIT_COMMAND_EVENT, onEdit);
  return () => window.removeEventListener(EDIT_COMMAND_EVENT, onEdit);
}, [focused]);
```

`undo` and `redo` are imported from `@codemirror/commands`. This needs the
`EditorView` in a ref rather than a local, so hoist it: `const viewRef =
useRef<EditorView | null>(null)` set inside the mount effect.

- [ ] **Step 7: Run the tests**

```bash
cd v2 && pnpm -r test && pnpm -r typecheck
```

Expected: PASS, including the pre-existing assertion that every accelerator carries a modifier.

- [ ] **Step 8: Commit**

```bash
git add v2/packages
git commit -m "⌘Z was never reaching the page

role: 'undo' calls webContents.undo(), the browser's document undo, and
CodeMirror's history lives in its own state. No terminal pane ever noticed,
because xterm has no undo. The editor is the first thing here for which ⌘Z means
anything."
```

---

### Task 12: Wire the extension into the app

**Files:**
- Modify: `v2/packages/app/src/main/index.ts`
- Modify: `v2/packages/app/src/ext-host/builtins.ts`
- Modify: `v2/packages/app/src/renderer/extension-ui.ts`
- Modify: `v2/packages/app/package.json`
- Modify: `v2/packages/app/tsconfig.json`

This is the first task after which anything is visible on screen.

- [ ] **Step 1: Add the dependency and the project reference**

`@shepherd/ext-scratch: "workspace:*"` in `packages/app/package.json`, and `{ "path": "../../extensions/scratch" }` in `packages/app/tsconfig.json`'s `references`. Run `pnpm install`.

- [ ] **Step 2: Register the manifest**

In `packages/app/src/main/index.ts`, import `scratchManifest` from `@shepherd/ext-scratch/manifest` and add it to **both** loops (registration around line 1285, activation around line 1324). Order does not matter: scratch declares no dependencies. Put it after `diagnosticsManifest` in both.

- [ ] **Step 3: Register the module**

In `packages/app/src/ext-host/builtins.ts`, import `activate as scratch` and `SCRATCH_ID`, and add `[SCRATCH_ID, scratch]` to `BUILTIN_MODULES`.

- [ ] **Step 4: Register the component**

In `packages/app/src/renderer/extension-ui.ts`, import `ScratchPane` from `@shepherd/ext-scratch/ui` and add to `EXTENSION_PANE_UI`:

```ts
  'scratch.pad': ScratchPane,
```

- [ ] **Step 5: Typecheck and test the workspace**

```bash
cd v2 && pnpm -r typecheck && pnpm -r test && pnpm -r lint
```

Expected: PASS. A lint failure naming `@shepherd/ext-scratch` means Task 1's `boundaries.js` entry is missing or wrong.

- [ ] **Step 6: Run the app and use it**

```bash
cd v2 && pnpm dev
```

Walk this list and fix what it turns up:

1. `⌘⇧N` opens a tab labelled `scratch`.
2. Type `# hello`, press Enter. The line becomes a heading and the `#` disappears.
3. Move the caret back onto it. The `#` returns.
4. Type `- [ ] a task`, move off the line. A real checkbox appears. Click it. It ticks, and the caret does not jump.
5. Type `**bold** and **more**`, put the caret inside the first. Only the first goes raw.
6. Paste `https://example.com`. It styles as a link. ⌘-click opens the browser.
7. Type a markdown table. It stays as the characters you typed.
8. Type `<script>alert(1)</script>`. It stays as the characters you typed.
9. `⌘Z` undoes. `⌘⇧Z` redoes.
10. Quit and relaunch. The pane is back with its text.
11. `⌘W` on a pane with text prompts. Cancel keeps it. Discard closes it.
12. `⌘W` on an empty scratch pane closes with no prompt.
13. Open a terminal pane. `⌘Z` there does nothing bad, and `⌘⇧N` still opens a scratch.

- [ ] **Step 7: Measure what CodeMirror cost**

The spec calls the bundle cost unmeasured and says it must be measured here.
CodeMirror is now the largest renderer dependency after xterm, and "large
enough to matter" is a number, not a feeling.

```bash
cd v2 && pnpm build
ls -la out/renderer/assets/*.js | awk '{print $5, $9}'
gzip -c out/renderer/assets/*.js | wc -c
```

Compare against the same two numbers from `git stash`-ing this branch and
building `master`. Record both in the ADR (Task 14).

If the gzipped delta is over ~250 KB, **do not change the design.** Make the
editor a dynamic `import()` inside `ScratchPane`'s effect, so the cost is paid
by the first scratch pane rather than by every launch. The pane already renders
asynchronously, so this is a change to one `await`, not to the architecture.

- [ ] **Step 8: Commit**

```bash
git add v2/packages
git commit -m "The second pane that is not a terminal

Manifest, module, component: the three lines ADR 0044's seam asks for. github
was the first consumer; this is the proof the seam was general."
```

---

### Task 13: Rename D9's Scratch to "loose tab"

**Files:**
- Modify: `docs/superpowers/plans/2026-08-07-v2-m3-plan.md`
- Modify: `docs/superpowers/plans/2026-08-08-v2-handoff.md`
- Modify: `docs/superpowers/plans/2026-08-12-v2-m4-punch-list.md`
- Modify: `CLAUDE.md`

`Scratch (D9)` means ⌘T opening a loose tab that is not a task, with a persisted list of cwd and title. It is documented and unbuilt. This feature takes the word; D9's concept becomes **loose tab**, which is more literally what it is.

**D9's design does not change. Only the word does.**

- [ ] **Step 1: Find every mention**

```bash
cd /Users/eshaannileshshah/.shepherd/v2/tasks/clay-lonk/shepherd
grep -rn "Scratch" docs/superpowers/plans/2026-08-07-v2-m3-plan.md \
  docs/superpowers/plans/2026-08-08-v2-handoff.md \
  docs/superpowers/plans/2026-08-12-v2-m4-punch-list.md CLAUDE.md
```

- [ ] **Step 2: Rewrite each one**

Rename the D9 heading in the m3 plan to `### D9 — a loose tab is not a degenerate task` and change the prose beneath it, including "Scratch is its own persisted list" and "promote-to-task". Do the same in the handoff's "What is left" item 1, the punch list's item 3 (including "Scratch (D9)'s persisted list" and "the persisted Scratch list"), and `CLAUDE.md`'s "Scratch (D9) and then M4" line.

Fix cross-references as you go, not only headings: anything reading "see D9's Scratch" or "the Scratch list" is part of this.

- [ ] **Step 3: Point the old name at the new feature**

Under the renamed D9 heading in the m3 plan, add one line so a reader arriving from an old link is not confused:

```markdown
> Renamed from **Scratch** on 2026-08-20. `scratch` is now the markdown pane
> (`docs/superpowers/specs/2026-08-20-scratch-pane-design.md`); this entry is
> about ⌘T opening a tab that is not a task, and its design is unchanged.
```

- [ ] **Step 4: Update CLAUDE.md's status line**

The "Scratch (D9) and then M4, the dogfood gate, are next" line is now wrong in two ways: the word moved, and the markdown pane is built. Rewrite it to say the scratch pane shipped, cite its ADR (Task 14), and that the loose tab and M4 remain.

- [ ] **Step 5: Verify nothing is left**

```bash
grep -rn "Scratch" docs/superpowers/plans/ CLAUDE.md | grep -vi "scratchpad\|from scratch\|scratch dir\|scratch.txt"
```

Expected: every remaining hit refers to the markdown pane.

- [ ] **Step 6: Commit**

```bash
git add docs CLAUDE.md
git commit -m "D9's Scratch is a loose tab

The word goes to the pane people will actually see and say. D9 is about ⌘T
opening a tab that is not a task, which 'loose tab' says more literally anyway.
Its design is unchanged; only the name moved."
```

---

### Task 14: The ADR

**Files:**
- Create: `.claude/adr/0046-v2-a-pane-may-be-a-document.md`
- Modify: `CLAUDE.md`

The repo's own instruction is to read the ADRs before changing anything load-bearing, and this work changed three load-bearing things.

- [ ] **Step 1: Write the ADR**

Follow the shape of `.claude/adr/0044-v2-a-pane-may-be-a-contributed-view.md`: Status, Date, Scope, Extends, then Context, Decision, and a section per consequence.

It must record, each with the reason rather than the change:

1. **A pane's key runs a command, an overlay's raises a layer.** The buffer id has to exist before `layout.newTab` can carry it in `view.state`, and nothing can rewrite a pane's view state afterwards. `contributes.commands[].key` was the other candidate and stays unread, because command contributions do not cross to the renderer at all while `ViewContributionDTO` already carries `key` and `surface`.
2. **Close may be guarded in the renderer, and only there.** ⌘W, the menu item and the tab strip route through `runMenuCommand`; `layout.closeGroup` does not, because it runs `store.close` per pane in main. The soft delete exists for that gap, and deleting eagerly would make shelving a task destroy notes with nowhere for a prompt to stand.
3. **Undo and redo stopped being menu roles.** `webContents.undo()` is the browser's document undo and CodeMirror's history is in its own state. No terminal pane noticed because xterm has no undo.
4. **`ExtensionPaneProps` gained `paneId`.** A pane that can be asked about before closing has to be able to name itself, and the same field is what a self-naming tab title will need.
5. **A document lives in the extension's KV, never in `view.state`.** The layout's 400ms debounce exists so it does not write once per keystroke.

- [ ] **Step 2: Add it to CLAUDE.md's ADR list**

Extend the `0021`–`0045` range to `0046` and add a paragraph in the style of the ones already there.

- [ ] **Step 3: Commit**

```bash
git add .claude/adr CLAUDE.md
git commit -m "0046: a pane may be a document

Three load-bearing things moved. A pane's key runs a verb because its subject
must exist before the pane does. Close can only be guarded in the renderer, so
the store soft-deletes for the path that cannot be. And ⌘Z was never reaching
the page at all — role: 'undo' is the browser's document undo, and no terminal
ever noticed because xterm has no undo."
```

---

## Verification

After Task 14, from `v2/`:

```bash
pnpm -r typecheck && pnpm -r test && pnpm -r lint && pnpm build
```

Then re-run the thirteen checks in Task 12 Step 6 against a built app rather than `pnpm dev`, because ADR 0045's `PATH` harvesting is the kind of thing that differs between the two and `scratch.open` shells out to `/usr/bin/open`.
