import { COMMANDS, commandIds, type CommandID } from '../shared/index.ts';

/**
 * The application menu, as data.
 *
 * It is a template rather than a `Menu` so the thing most likely to be wrong
 * can be asserted without an Electron process: **an accelerator is a key the
 * page never sees.** macOS resolves menu key equivalents before the key reaches
 * the web contents, so a bare-letter accelerator anywhere in here would make
 * that letter untypeable in every terminal in the app — v1 hit exactly this
 * with the workbench keys, and the fix there was to stop declaring them in the
 * menu bar at all.
 *
 * `menu-template.test.ts` therefore asserts that every accelerator carries a
 * modifier, that no single character is bound, and that the command items are
 * exactly the command ids — a menu and a command set that can drift are two
 * sources of truth for one thing.
 */

export interface MenuItemSpec {
  /** Stable id — the terminal smoke clicks the REAL MenuItem by it. */
  readonly id?: string;
  readonly label?: string;
  readonly role?: string;
  readonly accelerator?: string;
  /** What this item asks the renderer to do. Mutually exclusive with `role`. */
  readonly command?: CommandID;
  readonly type?: 'separator';
  readonly submenu?: readonly MenuItemSpec[];
}

export interface MenuOptions {
  readonly appName: string;
  readonly isDev: boolean;
}

export function menuTemplate({ appName, isDev }: MenuOptions): MenuItemSpec[] {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `About ${appName}` },
        { type: 'separator' },
        {
          id: COMMANDS.openSettings,
          label: 'Settings…',
          /*
           * The macOS-standard accelerator, and the one gesture in this app that
           * belongs in the menu bar rather than in the page. ⌘F and ⌘K are bound
           * in the renderer because AppKit resolving them first would make a find
           * bar and a palette impossible to close with the key that opened them;
           * ⌘, has no such second meaning, and Settings is the first place
           * anybody looks in this menu.
           */
          accelerator: 'CmdOrCtrl+,',
          command: COMMANDS.openSettings,
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      // Roles, not commands: ⌘C/⌘V in a terminal are the macOS convention
      // (interrupt is ⌃C, and always was), and xterm reads the DOM clipboard
      // events these produce. Their accelerators come from Electron, so they
      // are not in this file's accelerator audit — none of them is a bare key.
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Pane',
      submenu: [
        {
          id: COMMANDS.splitRight,
          label: 'Split Right',
          // ADR 0012: ⌘D is a ROW of panes — side by side.
          accelerator: 'CmdOrCtrl+D',
          command: COMMANDS.splitRight,
        },
        {
          id: COMMANDS.splitDown,
          label: 'Split Down',
          accelerator: 'CmdOrCtrl+Shift+D',
          command: COMMANDS.splitDown,
        },
        { type: 'separator' },
        {
          id: COMMANDS.closePane,
          // Deliberately replaces the default `close` role on ⌘W. The window is
          // closed only when this was the last pane, and only the renderer
          // knows that — see `runCommand`'s `close-window` effect.
          label: 'Close Pane',
          accelerator: 'CmdOrCtrl+W',
          command: COMMANDS.closePane,
        },
        { type: 'separator' },
        {
          id: COMMANDS.focusLeft,
          label: 'Focus Left',
          accelerator: 'CmdOrCtrl+Alt+Left',
          command: COMMANDS.focusLeft,
        },
        {
          id: COMMANDS.focusRight,
          label: 'Focus Right',
          accelerator: 'CmdOrCtrl+Alt+Right',
          command: COMMANDS.focusRight,
        },
        {
          id: COMMANDS.focusUp,
          label: 'Focus Up',
          accelerator: 'CmdOrCtrl+Alt+Up',
          command: COMMANDS.focusUp,
        },
        {
          id: COMMANDS.focusDown,
          label: 'Focus Down',
          accelerator: 'CmdOrCtrl+Alt+Down',
          command: COMMANDS.focusDown,
        },
      ],
    },
    ...(isDev
      ? [
          {
            label: 'Develop',
            submenu: [
              { role: 'reload' },
              { role: 'forceReload' },
              { role: 'toggleDevTools' },
            ],
          } satisfies MenuItemSpec,
        ]
      : []),
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
  ];
}

/** Every item, depth-first. */
export function flattenMenu(template: readonly MenuItemSpec[]): MenuItemSpec[] {
  return template.flatMap((item) => [item, ...flattenMenu(item.submenu ?? [])]);
}

/** Every accelerator this template declares itself (role defaults are Electron's). */
export function declaredAccelerators(template: readonly MenuItemSpec[]): string[] {
  return flattenMenu(template)
    .map((item) => item.accelerator)
    .filter((accelerator): accelerator is string => accelerator !== undefined);
}

const MODIFIERS = new Set([
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta',
]);

/**
 * True when an accelerator can only fire with a modifier held.
 *
 * This is the predicate the "plain keystrokes still reach xterm" claim rests
 * on: a menu key equivalent is consumed by AppKit before the renderer's key
 * handler runs, so `'a'` in this file is `a` deleted from every terminal.
 */
export function hasModifier(accelerator: string): boolean {
  const parts = accelerator.split('+').map((part) => part.trim().toLowerCase());
  return parts.length > 1 && parts.slice(0, -1).every((part) => MODIFIERS.has(part));
}

/** The commands a template actually offers, in menu order. */
export function commandsInMenu(template: readonly MenuItemSpec[]): CommandID[] {
  return flattenMenu(template)
    .map((item) => item.command)
    .filter((command): command is CommandID => command !== undefined);
}

/** Sanity used by both the test and `installMenu`: the menu covers the vocabulary. */
export function missingCommands(template: readonly MenuItemSpec[]): CommandID[] {
  const present = new Set(commandsInMenu(template));
  return commandIds.filter((id) => !present.has(id));
}
