/**
 * Every path the app owns, derived from one `home` and one `isDev` flag.
 *
 * Pure on purpose (the caller passes `home`): the dev/prod split is the thing
 * most likely to be got wrong once and then be invisible, so it is a function
 * with a test rather than string concatenation at three call sites.
 *
 * Ordering note for whoever wires this into main (P4): Chromium keys the
 * single-instance lock off the user-data directory, so
 * `app.setPath('userData', paths.userData)` MUST run BEFORE
 * `app.requestSingleInstanceLock()`. Locked first, dev and prod share one lock
 * and the dev build refuses to launch beside the daily one — which is the exact
 * isolation this function exists to provide. Measured in the Electron probe.
 */
export interface AppPaths {
  /** Electron's userData root — the single-instance lock lives here too. */
  readonly userData: string;
  /** Long-lived state we own outside Electron's control (sockets, worktrees). */
  readonly support: string;
  /** The control CLI's unix socket. */
  readonly controlSocket: string;
  /** The extension/agent hook ingress socket. */
  readonly hookSocket: string;
  /** Where `shepherdd` listens. It outlives the app, so it lives in `support`. */
  readonly sessionSocket: string;
  /** Debug log. Note /tmp, not support: it is disposable and grep-able. */
  readonly logFile: string;
}

export interface PathOptions {
  readonly home: string;
  readonly isDev: boolean;
}

/** The user-visible app name; also Electron's userData directory name. */
/**
 * What the app is called — **Shep**, and the dev build is **Shep Night**.
 *
 * Two names because they are two apps that must never share state: the dev
 * build is where a testing session creates and deletes tasks, and it takes its
 * own userData directory, its own sockets and its own Dock identity from this
 * one function. v1 learned that as Shepherd/ShepherdDev; the icons differ for
 * the same reason (day/night), so you can tell at a glance which one just asked
 * you something.
 */
export function appName(isDev: boolean): string {
  return isDev ? 'Shep Night' : 'Shep';
}

export function appPaths({ home, isDev }: PathOptions): AppPaths {
  // Deliberately NOT ~/.shepherd — v1 is still the daily driver and owns that
  // directory, including a control.sock a v2 build must never answer on.
  const support = isDev ? `${home}/.shepherd/v2-dev` : `${home}/.shepherd/v2`;
  return {
    userData: `${home}/Library/Application Support/${appName(isDev)}`,
    support,
    controlSocket: `${support}/control.sock`,
    hookSocket: `${support}/hooks.sock`,
    /**
     * Where `shepherdd` listens (R1). Beside the other two rather than under
     * userData: the daemon outlives the app, so its socket belongs with the
     * state that outlives the app, not with the state a build owns.
     */
    sessionSocket: `${support}/session.sock`,
    logFile: isDev ? '/tmp/shepherd-v2-dev.log' : '/tmp/shepherd-v2.log',
  };
}
