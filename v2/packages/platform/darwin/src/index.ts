export type { AppPaths, PathOptions } from './paths.ts';
export { appName, appPaths } from './paths.ts';
export { resolveAppPaths, systemHome, systemHostName, systemUserName } from './system.ts';
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
export {
  HARVESTED,
  LAUNCHCTL_TIMEOUT_MS,
  LOGIN_SHELL_TIMEOUT_MS,
  captureScript,
  installShellEnvironment,
  mergePath,
  readCaptured,
  shellCandidates,
  spawnProbe,
} from './shell-env.ts';
export type { HarvestedName, PathOrigin, Probe, ShellEnvReport } from './shell-env.ts';
