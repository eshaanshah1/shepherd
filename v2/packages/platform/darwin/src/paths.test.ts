import { describe, expect, it } from 'vitest';
import { appName, appPaths } from './paths.ts';
import { resolveAppPaths, systemHome } from './system.ts';

const home = '/Users/tester';

describe('appPaths', () => {
  it('gives dev and prod different userData roots, so the single-instance lock cannot be shared', () => {
    const prod = appPaths({ home, isDev: false });
    const dev = appPaths({ home, isDev: true });
    expect(prod.userData).not.toBe(dev.userData);
    expect(prod.userData).toBe(`${home}/Library/Application Support/Shepherd v2`);
    expect(dev.userData).toBe(`${home}/Library/Application Support/Shepherd v2 (dev)`);
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
    expect(appName(false)).toBe('Shepherd v2');
    expect(appName(true)).toContain('dev');
  });
});

describe('resolveAppPaths', () => {
  it('is appPaths over the real home directory', () => {
    expect(resolveAppPaths(false)).toEqual(appPaths({ home: systemHome(), isDev: false }));
    expect(systemHome().startsWith('/')).toBe(true);
  });
});
