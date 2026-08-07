import { describe, expect, it } from 'vitest';
import { LAYOUT_COMMANDS } from '@shepherd/core/layout';
import { COMMANDS, commandIds } from './commands.ts';
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

const kernelCommands = new Set<string>(Object.values(LAYOUT_COMMANDS));

describe('MENU_INVOCATIONS', () => {
  it('maps every menu command, and nothing else', () => {
    expect(unmappedCommands()).toEqual([]);
    expect(Object.keys(MENU_INVOCATIONS).sort()).toEqual([...commandIds].sort());
    expect(commandIds.length).toBeGreaterThan(0); // not vacuous
  });

  it('only ever targets a command the kernel really registers', () => {
    // The point of reading `LAYOUT_COMMANDS` rather than restating strings: a
    // renamed kernel verb fails here instead of at the first click.
    for (const [id, invocation] of Object.entries(MENU_INVOCATIONS)) {
      expect(kernelCommands, `${id} -> ${invocation.command}`).toContain(invocation.command);
    }
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
