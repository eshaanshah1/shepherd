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
  /**
   * ⌘, — the settings screen.
   *
   * In the MENU rather than bound in the page like ⌘K and ⌘F, and the difference
   * is which key it is: AppKit resolving ⌘, before the page sees it costs nothing,
   * whereas a find or a palette in the menu bar could never be closed by the key
   * that opened it. It is also the macOS-standard place to look for Settings.
   */
  openSettings: 'app.openSettings',
} as const;

export type CommandID = (typeof COMMANDS)[keyof typeof COMMANDS];

/**
 * `window.settings` — the kernel verb the item above maps to.
 *
 * Declared HERE rather than beside its handler in `main/settings-visibility.ts`
 * because `menu-commands.ts` needs it and shared may not import main. A command
 * id is public vocabulary, like a CLI verb, so one definition in the file both
 * processes already load beats the same string written twice.
 */
export const SETTINGS_VISIBILITY_COMMAND = 'window.settings';

export const commandIds = Object.values(COMMANDS) as CommandID[];

// There is deliberately no `isCommandID` guard any more. It existed to validate
// the `app:command` message main used to send the renderer, and no `CommandID`
// crosses a process boundary now — the menu resolves one to a kernel command in
// main, and the page only ever names the kernel command. A validator for a
// channel that no longer exists reads as load-bearing and is not.
