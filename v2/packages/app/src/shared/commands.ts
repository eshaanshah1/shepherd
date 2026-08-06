// The command vocabulary. Declared in shared because main OWNS the menu items
// and the renderer OWNS what they mean — a string that travels between two
// processes gets exactly one definition.

/**
 * M0's whole command set. The ids are also the menu item ids, so the terminal
 * smoke can click the real `MenuItem` by name and drive the real handler,
 * rather than asserting about a template nobody installed.
 */
export const COMMANDS = {
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

export function isCommandID(value: unknown): value is CommandID {
  return typeof value === 'string' && (commandIds as string[]).includes(value);
}

export interface CommandMessage {
  readonly command: CommandID;
}
