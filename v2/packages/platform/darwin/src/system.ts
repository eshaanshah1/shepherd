import { homedir, hostname, userInfo } from 'node:os';
import { appPaths, type AppPaths } from './paths.ts';

// The one place a node OS API is reached for (lint-enforced: `node:os` is
// restricted everywhere else in the workspace). Everything above this line is
// pure and testable without a machine.
export function systemHome(): string {
  return homedir();
}

/**
 * The account name — what `USER` holds in a shell.
 *
 * `userInfo().username` rather than `process.env['USER']`, because this runs in a
 * GUI-launched `.app` whose environment is launchd's rather than a shell's: the
 * same reason `execPath` exists for PATH. It reaches an extension as
 * `ctx.userName`, and the thing that needs it is a child process built an
 * environment from nothing — see `ExtensionContext.userName`.
 */
export function systemUserName(): string {
  return userInfo().username;
}

/**
 * What this machine calls itself — the name a shep-net shows other members.
 *
 * A person recognises "Eshaan's MacBook Air" and recognises nothing about a
 * device id, so this is what a join sheet and a member list read from. It is a
 * display string only: membership is decided by a signed credential, never by a
 * name anybody can claim.
 */
export function systemHostName(): string {
  return hostname();
}

export function resolveAppPaths(isDev: boolean): AppPaths {
  return appPaths({ home: systemHome(), isDev });
}
