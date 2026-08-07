import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { CommandID } from '../shared/index.ts';
import { unmappedCommands } from '../shared/menu-commands.ts';
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
 * The only judgement here is the three guards below, and they run at startup on
 * purpose: a bare-letter accelerator makes that letter untypeable in every
 * terminal, and there is no way to notice that from a screenshot.
 */
export interface InstallMenuOptions extends MenuOptions {
  /**
   * What a chosen menu item does. `index.ts` supplies the one that invokes the
   * kernel; the terminal smoke drives these same items, so there is no second
   * path to test against.
   */
  readonly dispatch: (command: CommandID) => void;
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
  // The third guard, new with P4a: an item can now also be wired to nothing.
  // Before this, "the menu covers the vocabulary" was the whole claim because the
  // renderer's `runCommand` had an exhaustive switch and the compiler checked it.
  // The vocabulary now maps to the kernel's verbs through a table, and a hole in a
  // table is a key that does nothing and says nothing.
  const unmapped = unmappedCommands();
  if (unmapped.length > 0) {
    throw new Error(`menu commands that map to no kernel command: ${unmapped.join(', ')}`);
  }

  const menu = Menu.buildFromTemplate(template.map((item) => toElectron(item, options.dispatch)));
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
