import type { Manifest } from '@shepherd/sdk';

/**
 * The manifest, typed, so main can register this extension without importing
 * its code (`@shepherd/ext-editor/manifest`).
 *
 * It duplicates the `shepherd` key of `package.json`, which is the shape a
 * third-party extension is discovered by, and `manifest.test.ts` asserts the two
 * are identical rather than trusting anybody to keep them so. The copy rather
 * than a JSON import is the same small trade every extension here makes:
 * `resolveJsonModule` is off across this repo.
 */
export const EDITOR_ID = 'shepherd.editor';

/**
 * `tasks`' id and `scratch`'s, re-stated rather than imported.
 *
 * `boundaries.js`: an extension's `src/` may make TYPE-only imports of another
 * extension, and values go through `extensions.get` or a command id. An id is a
 * value, so it is written out here the way `index.ts` writes out
 * `layout.newTab` — and for the same reason, which is that the alternative
 * evaluates another extension's module to learn a string.
 */
export const TASKS_ID = 'shepherd.tasks';
export const SCRATCH_ID = 'shepherd.scratch';

export const EDITOR_COMMANDS = {
  /** Open the editor tab for a path, or go to the one already on it. */
  open: 'editor.open',
  /**
   * Every path the tree should show for one root, with its git marks.
   *
   * One command rather than two because the tree draws both at once and a
   * second round trip would land the marks a frame after the rows they belong
   * to — a tree that flickers from clean to modified on every refresh.
   */
  tree: 'editor.tree',
  /** One file's text, plus the stamp a later write is checked against. */
  read: 'editor.read',
  /** Write a file, refusing if its stamp moved. */
  write: 'editor.write',
  /** What differs from HEAD: the paths, and what happened to each. */
  changes: 'editor.changes',
  /** One file's patch against HEAD. */
  diff: 'editor.diff',
} as const;

/**
 * The view type AND the component name, deliberately one string.
 *
 * The renderer resolves the type against the contributions an extension
 * registered, and only then resolves that contribution's `component` against
 * its static table (ADR 0044). Two hops, one name, so a persisted `view` on
 * disk reads as the thing it is.
 */
export const EDITOR_VIEWS = { workspace: 'editor.workspace' } as const;

/**
 * What the tab strip calls this pane.
 *
 * Named here because nothing else could: a view pane runs no program, so
 * nothing ever sets an OSC title on it and every contributed tab would
 * otherwise read `term` (ADR 0044).
 */
export const TAB_TITLE = 'editor';

export const editorManifest: Manifest = {
  id: EDITOR_ID,
  name: 'Editor',
  version: '0.1.0',
  api: '^1.0.0',
  /**
   * `onStartup`, because a persisted editor pane must resolve on the restore
   * that draws it. A view type is looked up against the contributions an
   * extension REGISTERED (ADR 0044), so an extension woken by its own first use
   * cannot answer for the tab that was already open when the app closed.
   */
  activation: ['onStartup'],
  /**
   * `process.exec` is for git and only git — the tree, its marks and its
   * diffs are all `gitRead`. Reading and writing the files themselves needs no
   * grant: fs and path are stdlib, and `extensions/scratch/src/install.ts`
   * records the same reasoning.
   */
  permissions: ['storage', 'process.exec', 'views', 'layout'],
  /**
   * Both are SOFT in behaviour. With no `tasks` the pane still opens on a path;
   * with no `scratch` the tree simply has no `Notes` root. Declared because
   * `extensions.get` and a cross-extension command resolve only ids a manifest
   * names — reaching another extension is declared, not discovered (§7c).
   */
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
