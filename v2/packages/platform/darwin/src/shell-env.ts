import { execFile } from 'node:child_process';
import { clearResolvedPrograms } from './exec.ts';
import { FALLBACK_SHELLS } from './shell.ts';

/**
 * The user's real `PATH`, harvested once from their login shell.
 *
 * A process inherits its environment from its parent. A terminal's shell has run
 * the user's profile, so `PATH` there has `/opt/homebrew/bin` on it and `gh` is
 * findable by name. An app launched from Finder or the Dock is a child of
 * **launchd**, which sourced no profile — its `PATH` is roughly
 * `/usr/bin:/bin:/usr/sbin:/sbin`. So the identical `exec` call succeeds in a
 * terminal and fails with `ENOENT` in the shipped app, which is the worst shape a
 * bug can have: it cannot be reproduced in the loop you develop in.
 *
 * `exec.ts` already answers half of this — `STANDARD_BIN_DIRS` prepends the two
 * places Homebrew installs to, plus `/usr/bin` and `/bin`. That covers `git` and
 * `gh` and stops there. It does nothing for a version manager, which is where
 * `node`, `python`, `ruby` and their entire ecosystems live for most people:
 * `mise`, `asdf`, `nvm`, `volta`, `pyenv`, `rbenv`, `fnm` all put their shims in
 * a directory that only exists because a shell profile said so, and half of them
 * pick the version from the *directory* the shell started in. A fixed list cannot
 * be extended to cover that. Asking the shell can.
 *
 * So: **run the user's login shell once, at startup, and take its `PATH`.** Then
 * every consumer downstream — `resolveProgram`, `execPath`, `gitEnv`, the daemon
 * `spawnDetached` inherits `process.env` into — improves without knowing this
 * happened. That is the whole reason it installs into `process.env` rather than
 * returning a value somebody has to thread: a fix every call site has to opt into
 * is a rule, and this codebase has already paid for that rule twice (v1's four
 * git runners, and `token.ts` carrying its own copy of a `PATH`).
 *
 * Read from `pingdotgg/t3code`'s `DesktopShellEnvironment`, which solves the same
 * problem for the same reason. Four things worth copying exactly, each of which
 * is a bug avoided rather than a preference:
 *
 *   - **`-i`, not just `-l`.** Login shells read `.zprofile`; the line that adds
 *     a version manager to `PATH` is overwhelmingly in `.zshrc`, which is the
 *     INTERACTIVE file. A non-interactive login shell reports a `PATH` the user
 *     has never seen in a terminal.
 *   - **Marker-delimited `printenv`, never a dump of `env`.** A profile prints
 *     things — motd, `fastfetch`, a version-manager warning, a stray `echo` —
 *     and any of it can look like `KEY=value`. Markers mean the parser reads the
 *     one variable it asked for out of arbitrary surrounding noise.
 *   - **`launchctl getenv PATH` as the fallback**, which is the other place a
 *     GUI-launched process could have got a configured `PATH` from.
 *   - **MERGE with the inherited `PATH`, never replace it.** A harvest that came
 *     back short — a profile that overwrote `PATH` instead of appending — would
 *     otherwise take away directories that were working a moment ago.
 *
 * Failure of every kind lands on the same outcome: the environment is left
 * exactly as it was, and the app behaves as it did before this file existed.
 */

/**
 * What we are willing to take from a shell profile, and it is deliberately two.
 *
 * Every name adopted here is a value the app's behaviour now depends on somebody
 * else's dotfiles for, so the list is a liability rather than a feature. `shell.ts`
 * is the counterweight and worth reading beside this: it exists to STRIP inherited
 * variables — proxies pointing at a dead port, another agent's session ids, forty
 * `npm_*` keys — because the app inheriting its launcher's environment has already
 * cost this project debugging sessions. Widening this list is walking back toward
 * that, so a third entry needs the same kind of argument these two have.
 *
 * `PATH` is the point. `SSH_AUTH_SOCK` is here because it is the difference
 * between `git push` over ssh working and hanging on a passphrase prompt that no
 * window in this app can answer — and it is only ever filled in when launchd did
 * not supply one, never overwritten.
 */
export const HARVESTED = ['PATH', 'SSH_AUTH_SOCK'] as const;
export type HarvestedName = (typeof HARVESTED)[number];

/**
 * Long enough for a slow profile, short enough to keep out of the way of a launch.
 *
 * This is the one cost of the whole design — it is awaited before anything spawns
 * a program, so it is time added to every start. Three seconds is a real profile
 * budget (`nvm` alone routinely takes over one), and a timeout is not a failure
 * here: it lands on the inherited `PATH`, which is what shipped before.
 */
export const LOGIN_SHELL_TIMEOUT_MS = 3_000;

/** A local read of a launchd key. If this needs seconds, something is very wrong. */
export const LAUNCHCTL_TIMEOUT_MS = 2_000;

const marker = (name: string, edge: 'start' | 'end'): string => `__SHEPHERD_ENV_${name}_${edge}__`;

/**
 * The script the login shell runs.
 *
 * `printenv NAME || true` rather than `echo $NAME`: an unset variable makes
 * `printenv` exit non-zero, which under a profile that set `set -e` would end the
 * script before the remaining names were printed.
 */
export function captureScript(names: readonly string[]): string {
  return names
    .map((name) =>
      [
        `printf '%s\\n' '${marker(name, 'start')}'`,
        `printenv ${name} || true`,
        `printf '%s\\n' '${marker(name, 'end')}'`,
      ].join('; '),
    )
    .join('; ');
}

/**
 * The variables, read back out of whatever else the profile printed.
 *
 * A name whose markers are missing or out of order is simply absent from the
 * result — a half-captured value is indistinguishable from a profile that printed
 * something marker-shaped, and neither is worth guessing about.
 */
export function readCaptured(
  output: string,
  names: readonly string[],
): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of names) {
    const open = marker(name, 'start');
    const start = output.indexOf(open);
    if (start === -1) continue;
    const from = start + open.length;
    const end = output.indexOf(marker(name, 'end'), from);
    if (end === -1) continue;
    const value = output.slice(from, end).replace(/^\r?\n/, '').replace(/\r?\n$/, '').trim();
    if (value !== '') found[name] = value;
  }
  return found;
}

/**
 * The harvested PATH ahead of the inherited one, de-duplicated, order kept.
 *
 * Harvested first because it is the one the user configured; inherited kept
 * because dropping it could only ever take something away. An empty entry is
 * dropped — to `execvp` it means the current directory, which is never a place we
 * want a program found (`exec.ts` makes the same call for the same reason).
 */
export function mergePath(harvested: string | undefined, inherited: string | undefined): string {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of [...(harvested ?? '').split(':'), ...(inherited ?? '').split(':')]) {
    const trimmed = dir.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    dirs.push(trimmed);
  }
  return dirs.join(':');
}

/**
 * Which shells to ask, best first.
 *
 * `$SHELL` is the user's own answer and is tried first; the fallbacks are
 * `shell.ts`'s list, shared rather than copied so a pane's shell and the shell we
 * interrogate about that pane's environment can never come to differ. A relative
 * `$SHELL` is ignored: it would be resolved against a `PATH` we do not trust yet,
 * which is the problem this file exists to solve.
 */
export function shellCandidates(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const seen = new Set<string>();
  const shells: string[] = [];
  for (const candidate of [env['SHELL'], ...FALLBACK_SHELLS]) {
    if (candidate === undefined || !candidate.startsWith('/') || seen.has(candidate)) continue;
    seen.add(candidate);
    shells.push(candidate);
  }
  return shells;
}

/** Where the PATH we ended up with came from. For the log line, and for a test. */
export type PathOrigin = 'login-shell' | 'launchctl' | 'inherited';

export interface ShellEnvReport {
  readonly origin: PathOrigin;
  /** The shell that answered, when one did. */
  readonly shell: string | null;
  /** Directories the harvest ADDED to the inherited PATH. Zero is the common case. */
  readonly added: number;
  readonly ms: number;
}

/**
 * Run a probe and give back what it printed.
 *
 * An injection point rather than a direct call, and it earns that: the default
 * spawns the user's INTERACTIVE login shell, so a test suite that used it would
 * run the developer's own profile several times per run — every `nvm`, every
 * `fastfetch`, every prompt hook — and would then assert about whatever that
 * machine happens to be configured with. One test still uses the real thing, for
 * the one property that has to hold on a machine we have never seen.
 */
export type Probe = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

/** One command, its output, and never a rejection — a failed probe is an empty string. */
export const spawnProbe: Probe = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        timeout: timeoutMs,
        // SIGKILL rather than the default TERM: this is an INTERACTIVE shell, and
        // an interactive shell is entitled to have a handler for TERM. The one
        // case that matters here is the one where it is wedged.
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        // A profile that prints a great deal must not make this throw. We read
        // markers out of the output, so extra is only ever noise to skip.
        maxBuffer: 4 * 1024 * 1024,
      },
      // Output is kept even on failure: a profile whose last line exits non-zero
      // still printed the markers, and a timed-out shell may have printed them
      // before it wedged.
      (_error, stdout) => resolve(stdout === undefined ? '' : stdout),
    )
      /*
       * Nothing to read on stdin, said immediately. An interactive shell with a
       * live stdin can sit on a profile that prompts, and the timeout above would
       * then be the only thing that ever ended it.
       */
      .stdin?.end();
  });

/**
 * Ask the login shell, fall back to launchd, and install the answer into
 * `process.env`.
 *
 * Mutating the process environment is the point rather than a shortcut — see the
 * header. Two consequences worth stating: it must run **before anything spawns a
 * program**, which in practice means first inside `whenReady` (the daemon is
 * spawned lazily and inherits `process.env`, so it gets this for free); and it
 * drops `exec.ts`'s resolved-program cache afterwards, because an entry resolved
 * against the old `PATH` would outlive the reason it was wrong.
 */
export async function installShellEnvironment(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: () => number;
    readonly probe?: Probe;
  } = {},
): Promise<ShellEnvReport> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const probe = options.probe ?? spawnProbe;

  const started = now();
  const inherited = env['PATH'];

  let shell: string | null = null;
  let harvested: Record<string, string> = {};
  for (const candidate of shellCandidates(env)) {
    /*
     * `-ilc`: interactive AND login. See the header — the line that puts a
     * version manager on `PATH` is usually in the interactive file, so a login
     * shell alone reports a PATH the user has never seen in a terminal.
     */
    const output = await probe(candidate, ['-ilc', captureScript(HARVESTED)], LOGIN_SHELL_TIMEOUT_MS);
    harvested = readCaptured(output, HARVESTED);
    if (harvested['PATH'] !== undefined) {
      shell = candidate;
      break;
    }
  }

  let origin: PathOrigin = 'login-shell';
  let path = harvested['PATH'];
  if (path === undefined) {
    // The other place a GUI process could have been given a configured PATH.
    const launchd = (await probe('/bin/launchctl', ['getenv', 'PATH'], LAUNCHCTL_TIMEOUT_MS)).trim();
    if (launchd !== '') {
      path = launchd;
      origin = 'launchctl';
    } else {
      origin = 'inherited';
    }
  }

  const before = new Set((inherited ?? '').split(':').filter((dir) => dir !== ''));
  const merged = mergePath(path, inherited);
  if (merged !== '') env['PATH'] = merged;

  /*
   * Filled in only when launchd did not supply one. Overwriting a live agent
   * socket with a profile's idea of where one should be is how you break ssh for
   * somebody it was working for.
   */
  const agent = harvested['SSH_AUTH_SOCK'];
  if (agent !== undefined && (env['SSH_AUTH_SOCK'] ?? '') === '') env['SSH_AUTH_SOCK'] = agent;

  // The cache holds absolute paths found under the old PATH. Anything in it was
  // resolved against a strictly smaller search, so re-probing can only improve.
  clearResolvedPrograms();

  const added = merged
    .split(':')
    .filter((dir) => dir !== '' && !before.has(dir)).length;
  return { origin, shell, added, ms: now() - started };
}
