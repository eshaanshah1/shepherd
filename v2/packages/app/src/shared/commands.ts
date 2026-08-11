// The CHROME's vocabulary: the gestures the app itself offers. Declared in
// shared because main owns the menu items and the renderer owns the toolbar, and
// a name two processes both use gets exactly one definition.
//
// It is no longer a *command* set — the commands are the kernel's
// (`LAYOUT_COMMANDS`), and each id here maps to one of them in
// `menu-commands.ts`. This file is the menu's index, nothing more.

/**
 * The ids are also the menu item ids, so the terminal smoke can click the real
 * `MenuItem` by name and drive the real handler, rather than asserting about a
 * template nobody installed.
 */
export const COMMANDS = {
  newTab: 'tab.new',
  splitRight: 'pane.splitRight',
  splitDown: 'pane.splitDown',
  closePane: 'pane.close',
  focusLeft: 'pane.focusLeft',
  focusRight: 'pane.focusRight',
  focusUp: 'pane.focusUp',
  focusDown: 'pane.focusDown',
} as const;

export type CommandID = (typeof COMMANDS)[keyof typeof COMMANDS];

export const commandIds = Object.values(COMMANDS) as CommandID[];

// There is deliberately no `isCommandID` guard any more. It existed to validate
// the `app:command` message main used to send the renderer, and no `CommandID`
// crosses a process boundary now — the menu resolves one to a kernel command in
// main, and the page only ever names the kernel command. A validator for a
// channel that no longer exists reads as load-bearing and is not.
