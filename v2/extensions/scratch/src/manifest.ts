import type { Manifest } from '@shepherd/sdk';

/**
 * The manifest, typed, so main can register this extension without importing
 * its code (`@shepherd/ext-scratch/manifest`).
 *
 * It duplicates the `shepherd` key of `package.json`, which is the shape a
 * third-party extension is discovered by, and `manifest.test.ts` asserts the two
 * are identical rather than trusting anybody to keep them so. The copy rather
 * than a JSON import is the same small trade every extension here makes:
 * `resolveJsonModule` is off across this repo.
 */
export const SCRATCH_ID = 'shepherd.scratch';

/**
 * `tasks`' id, re-stated rather than imported.
 *
 * `boundaries.js`: an extension's `src/` may make TYPE-only imports of another
 * extension, and values go through `extensions.get`. An id is a value, so it is
 * written out here the way `index.ts` writes out `layout.newTab` — and for the
 * same reason, which is that the alternative evaluates another extension's module
 * to learn a string.
 */
const TASKS_ID = 'shepherd.tasks';

export const SCRATCH_COMMANDS = {
  /** Mint a buffer and open a tab holding it. What ⌘⇧N runs. */
  create: 'scratch.create',
  read: 'scratch.read',
  write: 'scratch.write',
  /** Soft-delete. Called by the pane on its way out, not by the shell. */
  close: 'scratch.close',
  /** ⌘-click on a link. http/https only; see `index.ts` for the guard. */
  open: 'scratch.open',
  /**
   * Where this buffer's skill could go — the user's home, plus the repos of the
   * task that owns this tab.
   *
   * Takes a PANE rather than a task, because a scratch pane does not know it is in
   * a task and must not have to: the extension walks `layout.listRoots` to find
   * the tab holding the pane, then asks `tasks` which task claims that tab.
   */
  skillTargets: 'scratch.skillTargets',
  /** Write this buffer to `<target>/.claude/skills/<name>/SKILL.md`. */
  installSkill: 'scratch.installSkill',
  /**
   * Every live buffer — what `editor`'s `Notes` root is drawn from.
   *
   * The KV is keyed by id and nothing needed to enumerate it before: a pane
   * always arrived already holding one. Another extension asking "what notes
   * are there" is the first caller.
   */
  list: 'scratch.list',
  /**
   * Open, or go to, the tab holding this buffer.
   *
   * NOT `open`, which is the ⌘-click-a-link verb and takes a URL. A note is its
   * own PLACE, and something that lists notes needs a way to send you to one.
   */
  reveal: 'scratch.reveal',
  /**
   * Give this buffer a path: write it into a repo and close the KV row.
   *
   * The moment a note stops being a note. A scratchpad is a document that has
   * not chosen a path yet; after this it is a file, and `editor` owns it.
   */
  saveAs: 'scratch.saveAs',
} as const;

/**
 * The view type AND the component name, deliberately one string.
 *
 * The renderer resolves the type against the contributions an extension
 * registered, and only then resolves that contribution's `component` against
 * its static table (ADR 0044). Two hops, one name, so a persisted `view` on
 * disk reads as the thing it is.
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
   * `onStartup` because the accelerator must work before anything
   * scratch-shaped has happened. An extension woken by its own first use cannot
   * own the key that IS its own first use.
   */
  activation: ['onStartup'],
  /**
   * `layout` because `scratch.create` opens a tab. `process.exec` because a
   * ⌘-clicked link runs `open(1)`: there is no kernel `shell.openExternal`, and
   * `extensions/github/src/index.ts:461` says so and says what to do instead.
   */
  permissions: ['storage', 'views', 'layout', 'process.exec'],
  /**
   * `tasks`, for the repos a skill can be installed into.
   *
   * Declared because `extensions.get` resolves only ids a manifest names —
   * reaching another extension is declared, not discovered (§7c). It is a SOFT
   * dependency in behaviour: with no `tasks` the target list is the user's home
   * and nothing else, which is the right answer for a scratch pane in a plain tab
   * anyway.
   */
  dependencies: [TASKS_ID],
  contributes: {
    commands: [
      { id: SCRATCH_COMMANDS.create, title: 'Scratch: New' },
      { id: SCRATCH_COMMANDS.read },
      { id: SCRATCH_COMMANDS.write },
      { id: SCRATCH_COMMANDS.close },
      { id: SCRATCH_COMMANDS.open },
      { id: SCRATCH_COMMANDS.skillTargets },
      { id: SCRATCH_COMMANDS.installSkill, title: 'Scratch: Install Skill' },
      { id: SCRATCH_COMMANDS.list },
      { id: SCRATCH_COMMANDS.reveal },
      { id: SCRATCH_COMMANDS.saveAs, title: 'Scratch: Save to Repo' },
    ],
  },
};
