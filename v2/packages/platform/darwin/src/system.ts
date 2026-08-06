import { homedir } from 'node:os';
import { appPaths, type AppPaths } from './paths.ts';

// The one place a node OS API is reached for (lint-enforced: `node:os` is
// restricted everywhere else in the workspace). Everything above this line is
// pure and testable without a machine.
export function systemHome(): string {
  return homedir();
}

export function resolveAppPaths(isDev: boolean): AppPaths {
  return appPaths({ home: systemHome(), isDev });
}
