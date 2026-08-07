// What a chrome gesture MEANS, as the one lookup table between the menu's
// vocabulary and the kernel's.
//
// Deliberately NOT re-exported from `shared/index.ts`. That barrel is what
// `preload/api.ts` imports, and this file has a *value* import of
// `@shepherd/core/layout`; keeping it out of the barrel keeps the sandboxed
// preload bundle free of a runtime dependency on core. Import it by path — main
// and the renderer both do.

import { LAYOUT_COMMANDS } from '@shepherd/core/layout';
import { COMMANDS, commandIds, type CommandID } from './commands.ts';

/**
 * One place, so a keystroke and a button cannot come to mean different things.
 *
 * The M0 shape of this was a `runCommand(state, command)` in the renderer, which
 * meant ⌘D-the-menu-item and ⌘D-the-CLI-verb were two implementations of one
 * gesture. Now they are two transports: main invokes `layout.split` when the
 * menu item is clicked, the renderer invokes `layout.split` when the toolbar
 * button is, `shepherd pane split` will invoke `layout.split` over the control
 * socket, and the handler is registered exactly once, in core.
 *
 * `args` omits `pane` and `root` on purpose: a chrome gesture means "the pane I
 * am looking at", and that default lives in `registerLayoutCommands`. Naming
 * the focused pane here would be a second opinion about which pane that is.
 */
export interface Invocation {
  readonly command: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export const MENU_INVOCATIONS: Readonly<Record<CommandID, Invocation>> = {
  // ADR 0012's vocabulary, read off `@shepherd/core/layout` rather than from the
  // word: `row` is a ROW OF PANES — side by side. `column` is stacked.
  [COMMANDS.splitRight]: { command: LAYOUT_COMMANDS.split, args: { axis: 'row' } },
  [COMMANDS.splitDown]: { command: LAYOUT_COMMANDS.split, args: { axis: 'column' } },
  [COMMANDS.closePane]: { command: LAYOUT_COMMANDS.close, args: {} },
  [COMMANDS.focusLeft]: { command: LAYOUT_COMMANDS.focusDirection, args: { direction: 'left' } },
  [COMMANDS.focusRight]: { command: LAYOUT_COMMANDS.focusDirection, args: { direction: 'right' } },
  [COMMANDS.focusUp]: { command: LAYOUT_COMMANDS.focusDirection, args: { direction: 'up' } },
  [COMMANDS.focusDown]: { command: LAYOUT_COMMANDS.focusDirection, args: { direction: 'down' } },
};

/**
 * The table's own completeness check, exported so `installMenu` can run it at
 * startup alongside the accelerator audit. A menu item wired to nothing is a key
 * that does nothing and says nothing — the failure mode this whole file is here
 * to make impossible.
 */
export function unmappedCommands(): CommandID[] {
  return commandIds.filter((id) => MENU_INVOCATIONS[id] === undefined);
}
