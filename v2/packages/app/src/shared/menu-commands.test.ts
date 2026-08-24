import { describe, expect, it } from 'vitest';
import { LAYOUT_COMMANDS } from '@shepherd/core/layout';
import { shellManifest } from '@shepherd/ext-shell/manifest';
import { COMMANDS, SETTINGS_VISIBILITY_COMMAND, commandIds } from './commands.ts';
import { MENU_INVOCATIONS, unmappedCommands } from './menu-commands.ts';

/**
 * The table between the chrome's vocabulary and the kernel's.
 *
 * It replaced a `runCommand(state, command)` whose exhaustiveness the compiler
 * checked, so what the compiler no longer does these assertions have to: every
 * menu id maps to something, every target is a command that actually exists, and
 * the axes are the ones ADR 0012 names — the single most invertible pair of
 * values in the layout, and the one a screenshot cannot tell you is wrong.
 */

/**
 * Every verb a menu item is allowed to name.
 *
 * `LAYOUT_COMMANDS` is core's, read rather than restated so a renamed kernel verb
 * fails here instead of at the first click. `SETTINGS_VISIBILITY_COMMAND` is
 * main's — it is a window concern, like `window.reload`, so it is not in core's
 * table — and it is read from the same constant `settings-visibility.ts`
 * registers with, which is what keeps the two from drifting.
 */
const kernelCommands = new Set<string>([...Object.values(LAYOUT_COMMANDS), SETTINGS_VISIBILITY_COMMAND]);

/**
 * …and every verb a menu item may name that is an EXTENSION's.
 *
 * ⌘0 is the first menu key whose target is not the kernel's: which group the
 * shells are is `shepherd.shell`'s business and the kernel does not know it. The
 * guard keeps its teeth by reading the extension's MANIFEST — a static import,
 * the same trick `builtins.test.ts` uses — so a renamed or dropped contribution
 * fails here rather than as `unknown-command` under the user's finger. It does
 * NOT prove the extension registers what it declares; that is the extension's own
 * gate, and it was missing, which is exactly how ⌘0 shipped doing nothing.
 */
const extensionCommands = new Set<string>(
  (shellManifest.contributes?.commands ?? []).map((command) => command.id),
);

describe('MENU_INVOCATIONS', () => {
  it('maps every menu command, and nothing else', () => {
    expect(unmappedCommands()).toEqual([]);
    expect(Object.keys(MENU_INVOCATIONS).sort()).toEqual([...commandIds].sort());
    expect(commandIds.length).toBeGreaterThan(0); // not vacuous
  });

  it('only ever targets a command something really declares', () => {
    // The point of reading `LAYOUT_COMMANDS` and the manifest rather than
    // restating strings: a renamed verb fails here instead of at the first click.
    for (const [id, invocation] of Object.entries(MENU_INVOCATIONS)) {
      const declared = kernelCommands.has(invocation.command) || extensionCommands.has(invocation.command);
      expect(declared, `${id} -> ${invocation.command} is declared by neither the kernel nor a built-in`).toBe(true);
    }
  });

  it('sends ⌘0 to the shell extension, because the kernel does not know which group the shells are', () => {
    expect(MENU_INVOCATIONS[COMMANDS.revealShell]).toEqual({ command: 'shell.reveal', args: {} });
    expect(kernelCommands.has('shell.reveal')).toBe(false);
    expect(extensionCommands.has('shell.reveal')).toBe(true);
  });

  it('sends ⌘D to a ROW of panes and ⌘⇧D to a column — ADR 0012, not intuition', () => {
    expect(MENU_INVOCATIONS[COMMANDS.splitRight]).toEqual({
      command: LAYOUT_COMMANDS.split,
      args: { axis: 'row' },
    });
    expect(MENU_INVOCATIONS[COMMANDS.splitDown]).toEqual({
      command: LAYOUT_COMMANDS.split,
      args: { axis: 'column' },
    });
    // The negative control for the pair being inverted: they must not agree.
    expect(MENU_INVOCATIONS[COMMANDS.splitRight].args['axis']).not.toBe(
      MENU_INVOCATIONS[COMMANDS.splitDown].args['axis'],
    );
  });

  it('gives each arrow key its own direction, all four distinct', () => {
    const directions = [
      COMMANDS.focusLeft,
      COMMANDS.focusRight,
      COMMANDS.focusUp,
      COMMANDS.focusDown,
    ].map((id) => {
      expect(MENU_INVOCATIONS[id].command).toBe(LAYOUT_COMMANDS.focusDirection);
      return MENU_INVOCATIONS[id].args['direction'];
    });
    expect(directions).toEqual(['left', 'right', 'up', 'down']);
    expect(new Set(directions).size).toBe(4);
  });

  it('names no pane and no root — "the pane I am looking at" is core\'s default', () => {
    // A chrome gesture that named the focused pane would be a second opinion
    // about which pane that is, and `LayoutStore.focused` is the one that
    // resolves a stale id. ⌘W in particular must reach `layout.close` with no
    // pane, or closing a pane twice in quick succession addresses a corpse.
    for (const [id, invocation] of Object.entries(MENU_INVOCATIONS)) {
      expect(Object.keys(invocation.args), id).not.toContain('pane');
      expect(Object.keys(invocation.args), id).not.toContain('root');
    }
    expect(MENU_INVOCATIONS[COMMANDS.closePane]).toEqual({
      command: LAYOUT_COMMANDS.close,
      args: {},
    });
  });
});
