import type { Manifest } from '@shepherd/sdk';

/**
 * The manifest, typed, so main can register this extension without importing its
 * code (`@shepherd/ext-shell/manifest`).
 *
 * It duplicates the `shepherd` key of `package.json`, which is the shape a
 * third-party extension is discovered by, and `manifest.test.ts` asserts the two
 * are identical rather than trusting anybody to keep them so. The copy rather
 * than a JSON import is the same trade every extension here makes:
 * `resolveJsonModule` is off across this repo.
 */
export const SHELL_ID = 'shepherd.shell';

export const SHELL_COMMANDS = {
  /** Go to the shells. What ⌘0 runs, and what the head row's click runs. */
  reveal: 'shell.reveal',
  /** The `… +N` / `… less` toggle. */
  expand: 'shell.expand',
  /** Start a task on the repo a shell is sitting in. */
  promote: 'shell.promote',
} as const;

export const SHELL_VIEWS = { tree: 'shell.tree' } as const;

/**
 * The pane group the shells live in — the HOME root's.
 *
 * Not a group of its own, and that is the decision the whole feature rests on
 * (ADR 0047). `closeGroup` and `closeRoot` both fall back to the home root, so
 * making it the shells' home means finishing a task lands you among them rather
 * than on an empty stage. A separate group would leave the fallback destination
 * and the shells as two different places, which is the same lostness with an
 * extra row.
 *
 * The accepted cost: `window-1` cannot be closed, so the first shell row is
 * undeletable and reads `Empty` once its last pane goes.
 *
 * A literal rather than a read, because the kernel exposes no "which root is
 * home" verb and adding one would teach it that this extension exists.
 */
export const SHELL_GROUP = 'window-1';

export const shellManifest: Manifest = {
  id: SHELL_ID,
  name: 'Shell',
  version: '0.1.0',
  api: '^1.0.0',
  /**
   * `onStartup` because the row IS the app's way back to a task-less terminal.
   * An extension woken by its own first use cannot draw the row that is its own
   * first use.
   */
  activation: ['onStartup'],
  /** `views` to contribute the tree, `layout` to switch and open roots. */
  permissions: ['views', 'layout'],
  contributes: {
    commands: [
      { id: SHELL_COMMANDS.reveal, title: 'Shell: Reveal' },
      /*
       * No `title`, deliberately: the SDK documents `title` as exactly the
       * palette filter, and both of these answer a question a row asked.
       * "Shell: Expand" in the palette would be a verb with no row to expand.
       */
      { id: SHELL_COMMANDS.expand },
      { id: SHELL_COMMANDS.promote },
    ],
  },
};
