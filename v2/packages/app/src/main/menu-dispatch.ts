import { USER } from '@shepherd/sdk';
import type { CommandRegistry } from '@shepherd/core';
import type { CommandID } from '../shared/index.ts';
import { MENU_INVOCATIONS } from '../shared/menu-commands.ts';

/**
 * A menu click becomes a kernel command invocation attributed to the user.
 *
 * This is P4a's chrome half in one function. M0 sent `app:command` to the focused
 * window and let the renderer decide what it meant, which made ⌘D-the-menu-item
 * and ⌘D-the-CLI-verb two implementations of one gesture that could disagree.
 * The menu is now a *transport*, exactly like the toolbar button and (from M1's
 * control socket) `shepherd pane split`, and all of them land on the single
 * handler `registerLayoutCommands` registered.
 *
 * Deliberately electron-free so it can be driven by a real `CommandRegistry` in a
 * test — `menu.ts` is the twenty lines that build `MenuItem`s and nothing else.
 *
 * `registry.invoke` never throws and never rejects; it answers with a `Result`.
 * So the only thing to handle is a command that reported failure, and it is
 * reported rather than dropped: a menu item that quietly does nothing is
 * indistinguishable from a feature that has stopped working.
 */
export function menuDispatcher(
  registry: CommandRegistry,
  onFailure: (command: CommandID, message: string) => void,
): (command: CommandID) => void {
  return (command) => {
    const invocation = MENU_INVOCATIONS[command];
    if (invocation === undefined) {
      // Unreachable while `installMenu`'s startup guard holds. Reported anyway:
      // the guard runs once, this runs per click, and a table is editable.
      onFailure(command, `no kernel command mapped to "${command}"`);
      return;
    }
    void registry.invoke(invocation.command, invocation.args, USER).then((result) => {
      if (!result.ok) onFailure(command, result.error.message);
    });
  };
}
