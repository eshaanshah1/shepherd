import { describe, expect, it } from 'vitest';
import { appName, appPaths } from './paths.ts';
import { resolveAppPaths, systemHome } from './system.ts';

const home = '/Users/tester';

describe('appPaths', () => {
  it('gives dev and prod different userData roots, so the single-instance lock cannot be shared', () => {
    const prod = appPaths({ home, isDev: false });
    const dev = appPaths({ home, isDev: true });
    expect(prod.userData).not.toBe(dev.userData);
    expect(prod.userData).toBe(`${home}/Library/Application Support/Shep`);
    expect(dev.userData).toBe(`${home}/Library/Application Support/Shep Night`);
  });

  it('separates every dev path from every prod path', () => {
    const prod = appPaths({ home, isDev: false });
    const dev = appPaths({ home, isDev: true });
    for (const key of Object.keys(prod) as (keyof typeof prod)[]) {
      expect(dev[key], key).not.toBe(prod[key]);
    }
  });

  it('never claims v1 shepherd paths — v1 is still the daily driver', () => {
    for (const isDev of [false, true]) {
      const p = appPaths({ home, isDev });
      expect(p.controlSocket).not.toBe(`${home}/.shepherd/control.sock`);
      expect(p.support.startsWith(`${home}/.shepherd/v2`)).toBe(true);
    }
  });

  it('puts both sockets inside the support dir', () => {
    const p = appPaths({ home, isDev: false });
    expect(p.controlSocket.startsWith(`${p.support}/`)).toBe(true);
    expect(p.hookSocket.startsWith(`${p.support}/`)).toBe(true);
    expect(p.controlSocket).not.toBe(p.hookSocket);
  });

  it('names the app so the dev build is unmistakable in the menu bar', () => {
    expect(appName(false)).toBe('Shep');
    // Different NAME, not a suffix: the two run side by side, and telling them
    // apart in the Dock and the menu bar is the whole point of the split.
    expect(appName(true)).toBe('Shep Night');
    expect(appName(true)).not.toBe(appName(false));
  });
});

describe('resolveAppPaths', () => {
  it('is appPaths over the real home directory', () => {
    expect(resolveAppPaths(false)).toEqual(appPaths({ home: systemHome(), isDev: false }));
    expect(systemHome().startsWith('/')).toBe(true);
  });
});
