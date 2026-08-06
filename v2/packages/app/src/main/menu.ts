import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import { EMIT, type CommandID, type CommandMessage } from '../shared/index.ts';
import {
  hasModifier,
  declaredAccelerators,
  menuTemplate,
  missingCommands,
  type MenuItemSpec,
  type MenuOptions,
} from './menu-template.ts';

/**
 * Turn the template into the real application menu.
 *
 * The only judgement here is the two guards below, and they run at startup on
 * purpose: a bare-letter accelerator makes that letter untypeable in every
 * terminal, and there is no way to notice that from a screenshot.
 */
export interface InstallMenuOptions extends MenuOptions {
  /** Where a chosen command goes. Defaults to the focused window's renderer. */
  readonly dispatch?: (command: CommandID) => void;
}

export function installMenu(options: InstallMenuOptions): Menu {
  const template = menuTemplate(options);

  const bare = declaredAccelerators(template).filter((accelerator) => !hasModifier(accelerator));
  if (bare.length > 0) {
    throw new Error(
      `menu accelerators without a modifier would delete those keys from every terminal: ${bare.join(', ')}`,
    );
  }
  const missing = missingCommands(template);
  if (missing.length > 0) {
    throw new Error(`commands with no menu item (so no key can reach them): ${missing.join(', ')}`);
  }

  const dispatch = options.dispatch ?? sendToFocusedWindow;
  const menu = Menu.buildFromTemplate(template.map((item) => toElectron(item, dispatch)));
  Menu.setApplicationMenu(menu);
  return menu;
}

function toElectron(
  spec: MenuItemSpec,
  dispatch: (command: CommandID) => void,
): MenuItemConstructorOptions {
  const command = spec.command;
  return {
    ...(spec.id === undefined ? {} : { id: spec.id }),
    ...(spec.label === undefined ? {} : { label: spec.label }),
    ...(spec.role === undefined ? {} : { role: spec.role as MenuItemConstructorOptions['role'] }),
    ...(spec.accelerator === undefined ? {} : { accelerator: spec.accelerator }),
    ...(spec.type === undefined ? {} : { type: spec.type }),
    ...(spec.submenu === undefined
      ? {}
      : { submenu: spec.submenu.map((child) => toElectron(child, dispatch)) }),
    ...(command === undefined ? {} : { click: () => dispatch(command) }),
  };
}

/**
 * A command means nothing in main — the layout lives in the renderer. So the
 * menu says what was chosen and the renderer decides what it means.
 *
 * `getFocusedWindow()` can be null when the menu is driven programmatically
 * (the terminal smoke does exactly that), so it falls back to the only window
 * there is rather than dropping the command in silence.
 */
function sendToFocusedWindow(command: CommandID): void {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (target === undefined || target.isDestroyed()) return;
  const message: CommandMessage = { command };
  target.webContents.send(EMIT.command, message);
}
