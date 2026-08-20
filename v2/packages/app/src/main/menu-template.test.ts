import { describe, expect, it } from 'vitest';
import { COMMANDS, commandIds } from '../shared/index.ts';
import {
  commandsInMenu,
  declaredAccelerators,
  flattenMenu,
  hasModifier,
  menuTemplate,
  missingCommands,
  type MenuItemSpec,
} from './menu-template.ts';

/**
 * The menu, checked for the one property that cannot be seen by looking at it:
 * **a menu accelerator is a key the page never receives.** macOS resolves key
 * equivalents in AppKit before the event reaches the web contents, so a bare
 * `'a'` here would delete the letter `a` from every terminal in the app — and
 * the app would look completely normal until somebody tried to type.
 *
 * (This is the same lesson v1 recorded for the workbench keys, where the fix
 * was to stop declaring them in the menu bar at all.)
 */

const template = menuTemplate({ appName: 'Shepherd v2', isDev: false });

describe('menu accelerators', () => {
  it('every declared accelerator needs a modifier held', () => {
    const bare = declaredAccelerators(template).filter((a) => !hasModifier(a));
    expect(bare).toEqual([]);
    expect(declaredAccelerators(template).length).toBeGreaterThan(0); // not vacuous
  });

  it("does not bind 'a' — the plain keystroke the smoke types into xterm", () => {
    expect(declaredAccelerators(template)).not.toContain('a');
    expect(declaredAccelerators(template).map((a) => a.toLowerCase())).not.toContain('a');
  });

  it('binds no single character at all, in dev or in prod', () => {
    for (const isDev of [false, true]) {
      for (const accelerator of declaredAccelerators(menuTemplate({ appName: 'x', isDev }))) {
        expect(accelerator.length, accelerator).toBeGreaterThan(1);
        expect(hasModifier(accelerator), accelerator).toBe(true);
      }
    }
  });

  it('hasModifier is not vacuously true — the negative controls', () => {
    expect(hasModifier('a')).toBe(false);
    expect(hasModifier('F1')).toBe(false);
    expect(hasModifier('Escape')).toBe(false);
    // A modifier in the wrong place is not a modifier.
    expect(hasModifier('D+CmdOrCtrl')).toBe(false);
    expect(hasModifier('CmdOrCtrl+D')).toBe(true);
    expect(hasModifier('CmdOrCtrl+Alt+Left')).toBe(true);
    expect(hasModifier('Shift+Cmd+D')).toBe(true);
  });

  it('a template with a bare accelerator is caught by the same predicate', () => {
    const bad: MenuItemSpec[] = [
      { label: 'Bad', submenu: [{ id: 'x', label: 'Type A', accelerator: 'a' }] },
    ];
    expect(declaredAccelerators(bad).filter((a) => !hasModifier(a))).toEqual(['a']);
  });
});

describe('undo and redo reach the page', () => {
  /*
   * `role: 'undo'` is an AppKit key equivalent that calls `webContents.undo()`
   * — the browser's DOCUMENT undo. An editor pane keeps its history in its own
   * state and never hears about it, so ⌘Z there does nothing or corrupts the
   * buffer. No terminal pane ever noticed, because xterm has no undo.
   */
  const roles = (): Set<string> => {
    const found = new Set<string>();
    for (const item of flattenMenu(menuTemplate({ appName: 'Shep', isDev: false }))) {
      if (item.role !== undefined) found.add(item.role);
    }
    return found;
  };

  it('has no undo ROLE', () => {
    expect(roles()).not.toContain('undo');
  });

  it('has no redo ROLE', () => {
    expect(roles()).not.toContain('redo');
  });

  it('keeps cut, copy, paste and select-all as roles — xterm reads their DOM events', () => {
    // The negative control. Only the two with an in-page owner move.
    for (const role of ['cut', 'copy', 'paste', 'selectAll']) {
      expect(roles()).toContain(role);
    }
  });

  it('does not replace them with commands either — ⌘Z belongs to the page', () => {
    // A menu ITEM on ⌘Z would take the key back whatever it then did with it.
    // The whole fix is that the accelerator stops existing here.
    const keys = declaredAccelerators(menuTemplate({ appName: 'Shep', isDev: false }));
    expect(keys).not.toContain('CmdOrCtrl+Z');
    expect(keys).not.toContain('CmdOrCtrl+Shift+Z');
  });
});

describe('menu commands', () => {
  it('offers every command exactly once', () => {
    expect(commandsInMenu(template).sort()).toEqual([...commandIds].sort());
    expect(missingCommands(template)).toEqual([]);
    expect(new Set(commandsInMenu(template)).size).toBe(commandIds.length);
  });

  it('gives every command item a stable id, so the smoke can click the real thing', () => {
    const withCommands = flattenMenu(template).filter((item) => item.command !== undefined);
    for (const item of withCommands) expect(item.id, item.label).toBe(item.command);
    const ids = withCommands.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('binds the pane keys the plan names, on the axes ADR 0012 names', () => {
    const byId = new Map(flattenMenu(template).map((item) => [item.id, item]));
    expect(byId.get(COMMANDS.splitRight)?.accelerator).toBe('CmdOrCtrl+D');
    expect(byId.get(COMMANDS.splitDown)?.accelerator).toBe('CmdOrCtrl+Shift+D');
    expect(byId.get(COMMANDS.closePane)?.accelerator).toBe('CmdOrCtrl+W');
    expect(byId.get(COMMANDS.focusLeft)?.accelerator).toBe('CmdOrCtrl+Alt+Left');
    expect(byId.get(COMMANDS.focusRight)?.accelerator).toBe('CmdOrCtrl+Alt+Right');
    expect(byId.get(COMMANDS.focusUp)?.accelerator).toBe('CmdOrCtrl+Alt+Up');
    expect(byId.get(COMMANDS.focusDown)?.accelerator).toBe('CmdOrCtrl+Alt+Down');
  });

  it('takes ⌘W away from the window-close role — the pane owns it', () => {
    const roles = flattenMenu(template).map((item) => item.role);
    expect(roles).not.toContain('close');
    const closers = flattenMenu(template).filter((item) => item.accelerator === 'CmdOrCtrl+W');
    expect(closers.map((item) => item.command)).toEqual([COMMANDS.closePane]);
  });

  it('never gives an item both a role and a command', () => {
    for (const item of flattenMenu(template)) {
      expect(item.role !== undefined && item.command !== undefined, item.label).toBe(false);
    }
  });

  it('keeps copy and paste as roles, so xterm gets the DOM clipboard events', () => {
    const roles = flattenMenu(template).map((item) => item.role);
    expect(roles).toContain('copy');
    expect(roles).toContain('paste');
    expect(roles).toContain('quit');
  });

  it('shows the reload/devtools menu only in dev', () => {
    const dev = flattenMenu(menuTemplate({ appName: 'x', isDev: true })).map((i) => i.role);
    const prod = flattenMenu(menuTemplate({ appName: 'x', isDev: false })).map((i) => i.role);
    expect(dev).toContain('toggleDevTools');
    expect(prod).not.toContain('toggleDevTools');
  });
});
