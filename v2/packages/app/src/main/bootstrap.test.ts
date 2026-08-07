import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one property that matters here cannot be seen in the result: `bootstrap`
 * returns the same object whichever order its two calls happen in. So the test
 * swaps the electron module for a recorder and reads the call SEQUENCE back.
 *
 * A comment saying "setPath must come first" is what this replaces. The bug it
 * guards is silent — a build that always runs alone behaves identically either
 * way, and the collision only appears when two builds are open at once, on
 * somebody else's machine.
 */

const electron = vi.hoisted(() => {
  const calls: string[] = [];
  const paths = new Map<string, string>();
  const state = { lock: true };
  return {
    calls,
    paths,
    state,
    app: {
      setPath(name: string, value: string): void {
        calls.push(`setPath(${name}, ${value})`);
        paths.set(name, value);
      },
      getPath(name: string): string {
        return paths.get(name) ?? `<unset:${name}>`;
      },
      requestSingleInstanceLock(): boolean {
        calls.push('requestSingleInstanceLock()');
        return state.lock;
      },
    },
  };
});

vi.mock('electron', () => ({ app: electron.app }));

// After the mock, so the module under test binds to the recorder. (`vi.mock` is
// hoisted above every import in the file, which is what makes this safe.)
import {
  bootstrap,
  flagValue,
  resolveUserData,
  EXIT_SECOND_INSTANCE,
  USER_DATA_FLAG,
} from './bootstrap.ts';

const fakePaths = (isDev: boolean) => ({
  userData: isDev
    ? '/Users/x/Library/Application Support/Shepherd v2 (dev)'
    : '/Users/x/Library/Application Support/Shepherd v2',
});

beforeEach(() => {
  electron.calls.length = 0;
  electron.paths.clear();
  electron.state.lock = true;
});

describe('bootstrap ordering', () => {
  it('sets userData BEFORE requesting the single-instance lock', () => {
    bootstrap({ isDev: true, argv: [], resolvePaths: fakePaths });

    expect(electron.calls).toEqual([
      'setPath(userData, /Users/x/Library/Application Support/Shepherd v2 (dev))',
      'requestSingleInstanceLock()',
    ]);
  });

  it('takes the lock under the REDIRECTED directory, not the default one', () => {
    bootstrap({ isDev: true, argv: [], resolvePaths: fakePaths });

    const setAt = electron.calls.findIndex((call) => call.startsWith('setPath(userData,'));
    const lockAt = electron.calls.indexOf('requestSingleInstanceLock()');
    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeGreaterThanOrEqual(0);
    // The whole claim: by the time Chromium looks for the lock, the path it
    // looks in is already ours.
    expect(setAt).toBeLessThan(lockAt);
    expect(electron.paths.get('userData')).toBe(fakePaths(true).userData);
  });

  it('reads the path back out of electron rather than trusting the input', () => {
    const result = bootstrap({ isDev: false, argv: [], resolvePaths: fakePaths });
    expect(result.userData).toBe(electron.app.getPath('userData'));
    expect(result.userData).toBe(fakePaths(false).userData);
  });
});

describe('which directory this build owns', () => {
  it('gives a dev build a differently-named directory from a prod build', () => {
    const dev = resolveUserData({ isDev: true, argv: [], resolvePaths: fakePaths });
    const prod = resolveUserData({ isDev: false, argv: [], resolvePaths: fakePaths });
    expect(dev).not.toBe(prod);
    expect(dev.endsWith('(dev)')).toBe(true);
    expect(prod.endsWith('(dev)')).toBe(false);
  });

  it('lets a smoke run redirect to a throwaway dir, whichever build it is', () => {
    const argv = ['electron', 'index.js', `${USER_DATA_FLAG}=/tmp/throwaway-42`];
    expect(resolveUserData({ isDev: true, argv, resolvePaths: fakePaths })).toBe('/tmp/throwaway-42');
    expect(resolveUserData({ isDev: false, argv, resolvePaths: fakePaths })).toBe('/tmp/throwaway-42');
  });

  it('resolves nothing from a flag that merely starts the same way', () => {
    expect(flagValue([`${USER_DATA_FLAG}-other=/tmp/x`], USER_DATA_FLAG)).toBeUndefined();
    expect(flagValue([`${USER_DATA_FLAG}=/tmp/x`], USER_DATA_FLAG)).toBe('/tmp/x');
  });
});

describe('a second instance', () => {
  it('reports the refusal instead of returning a half-started app', () => {
    electron.state.lock = false;
    const result = bootstrap({ isDev: false, argv: [], resolvePaths: fakePaths });
    expect(result.hasLock).toBe(false);
    // Still redirected: the refusal is about the directory, so the caller can
    // say WHICH directory is taken.
    expect(result.userData).toBe(fakePaths(false).userData);
  });

  it('exits non-zero, so a launcher can tell "already running" from "started"', () => {
    expect(EXIT_SECOND_INSTANCE).toBeGreaterThan(0);
  });
});
