import { app } from 'electron';
import { resolveAppPaths } from '@shepherd/platform-darwin';

/**
 * The first thing the app does, and the order of its two lines is the feature.
 *
 * Chromium keys the single-instance lock off the **user-data directory**. So:
 *
 *   1. `app.setPath('userData', …)` — decide which directory this build owns;
 *   2. `app.requestSingleInstanceLock()` — take the lock *in* that directory.
 *
 * Reverse them and the lock is taken under Electron's default path, which is
 * the same for a dev build and a shipped one — so the two share a lock, and
 * launching the dev app beside the daily one makes one of them exit at startup
 * with no window and no message. That is the exact collision the redirect
 * exists to prevent, and it is invisible from the outside: a build that always
 * runs alone looks completely healthy.
 *
 * This lives in its own module, importing the real `electron`, so the ordering
 * is asserted by a test that swaps the module for a recorder and reads back the
 * call sequence — not by the comment above.
 */

/** What the process exits with when another copy owns this userData dir. */
export const EXIT_SECOND_INSTANCE = 2;

/** Points the app at a throwaway directory. Smoke runs pass it; users do not. */
export const USER_DATA_FLAG = '--shepherd-user-data';

export interface BootstrapOptions {
  /**
   * Decided when the bundle is written (`build-flags.ts`), never read from the
   * environment: the thing it selects is which directory this build owns, and a
   * runtime switch there is a way to talk a dev build into the production one.
   */
  readonly isDev: boolean;
  readonly argv: readonly string[];
  /** Injectable so a test can assert about paths without a real home dir. */
  readonly resolvePaths?: (isDev: boolean) => { readonly userData: string };
}

export interface BootstrapResult {
  /** Read back out of Electron, so a redirect that did not land shows up here. */
  readonly userData: string;
  readonly hasLock: boolean;
  readonly isDev: boolean;
}

export function flagValue(argv: readonly string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

/**
 * Which userData directory this build owns. Pure — no Electron call, no lock —
 * so the `--shepherd-print-paths` mode can answer without ever taking one.
 */
export function resolveUserData(options: BootstrapOptions): string {
  const resolve = options.resolvePaths ?? resolveAppPaths;
  return flagValue(options.argv, USER_DATA_FLAG) ?? resolve(options.isDev).userData;
}

export function bootstrap(options: BootstrapOptions): BootstrapResult {
  const userData = resolveUserData(options);

  // --- 1. the directory this build owns.
  app.setPath('userData', userData);

  // --- 2. the lock, which Chromium places INSIDE that directory.
  const hasLock = app.requestSingleInstanceLock();

  return { userData: app.getPath('userData'), hasLock, isDev: options.isDev };
}
