export type { AppPaths, PathOptions } from './paths.ts';
export { appName, appPaths } from './paths.ts';
export { resolveAppPaths, systemHome, systemUserName } from './system.ts';
export {
  FALLBACK_SHELLS,
  shellDefaults,
  shellDefaultsFrom,
  type ShellDefaults,
  type ShellInputs,
} from './shell.ts';
export {
  runExec,
  runGit,
  gitEnv,
  truncate,
  MAX_OUTPUT_BYTES,
  STANDARD_BIN_DIRS,
  searchDirs,
  execPath,
  findProgram,
  resolveProgram,
  clearResolvedPrograms,
} from './exec.ts';
export type { RunOptions, RunResult } from './exec.ts';
export { spawnDetached } from './exec.ts';
