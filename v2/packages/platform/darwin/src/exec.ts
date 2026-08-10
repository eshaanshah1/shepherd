import { execFile, spawn as spawnChild } from 'node:child_process';
import { mkdirSync, openSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The one runner — Rebuild checklist item 4, and the only place in the app that
 * spawns a program.
 *
 * It lives here because `tooling/eslint/boundaries.js` denies `child_process`
 * everywhere else: `packages/platform/**` is the single production directory
 * that may touch an OS API, and only `packages/app/src/main/**` may import it.
 * An extension therefore reaches this across a message port, which is what makes
 * running a program a reviewable, permission-gated, testable act rather than a
 * `spawn` call in somebody's extension.
 *
 * v1 had four git runners and paid for it twice, so both fixes are **structural**
 * here rather than remembered at each call site:
 *
 *   - **`gitRead` always sets `GIT_OPTIONAL_LOCKS=0`.** A plain `git status`
 *     rewrites `.git/index`; in v1 that woke the file watcher that had just run
 *     it, and the two sustained each other with nothing happening in the repo.
 *   - **`gitWrite` MERGES into the inherited environment.** Replacing it loses
 *     `HOME`, and with it git's config — so a commit fails on an unset
 *     `user.name` in a repo that is configured perfectly well.
 *   - **Every program is resolved to an absolute path, and every child is
 *     handed a PATH that contains the standard locations.** A GUI-launched
 *     `.app` inherits whatever launchd gave it, which is not the PATH the user
 *     configured in their shell — see `resolveProgram` for the whole story.
 *
 * Arguments are arrays and reach `execFile`, never a shell. There is no string
 * to quote, so there is nothing to quote wrongly.
 */

export interface RunOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs: number;
}

export interface RunResult {
  readonly ok: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * How much output may cross the port.
 *
 * A `git diff` is unbounded and gets structured-cloned into the extension host
 * as one string. The HTTP ingresses cap their bodies; this path is the one that
 * did not, and an extension asking for a diff of a large branch should get a
 * capped answer rather than a stalled process.
 */
export const MAX_OUTPUT_BYTES = 1_000_000;

export function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_BYTES) return { text, truncated: false };
  // Says so, in the output, because silent truncation reads as a complete
  // answer — which is how a caller concludes there are no more matches.
  return {
    text: `${text.slice(0, MAX_OUTPUT_BYTES)}\n[shepherd: truncated at ${MAX_OUTPUT_BYTES} bytes]`,
    truncated: true,
  };
}

/**
 * Where a program is looked for, ahead of whatever PATH this process inherited.
 *
 * A pane is fine without this because it spawns `$SHELL -l`, and a login shell
 * reads the user's profile; this runner is the other half of the app, and it
 * spawns `git` straight out of main with the PATH the app process happens to
 * have. Launched from Finder or the Dock that PATH is launchd's, not the one
 * the user configured — no `/opt/homebrew/bin`, no `/usr/local/bin` — and the
 * symptom is `spawn git ENOENT` from provisioning, archiving and deleting a
 * task, which are exactly the operations a dogfood week is made of.
 *
 * v1 recorded the discipline and `GH.executablePath` implemented it: probe the
 * standard locations FIRST, then fall back to the inherited PATH. The order is
 * that way round on purpose. The inherited PATH is the untrustworthy input here
 * — it is minimal precisely when the app was launched the way a user launches
 * it — so putting it first would make which `git` we run depend on how the app
 * was started. v1 also records why the fallback is not `bash -lc "command -v"`:
 * that reads BASH profiles, so a PATH configured in zsh is invisible and the
 * probe concludes the tool is not installed.
 */
export const STANDARD_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'] as const;

/**
 * The one search order, used for BOTH our own lookup and the PATH we hand the
 * child.
 *
 * Sharing it is the point: `git` shells out constantly — credential helpers,
 * `ssh`, `gpg`, hooks, `git-lfs` — and resolving our own `git` while handing it
 * a PATH that cannot find its helpers moves the failure one process along
 * instead of fixing it. Duplicates are dropped so the string stays readable in
 * a log line.
 */
export function searchDirs(inheritedPath: string | undefined): readonly string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const dir of [...STANDARD_BIN_DIRS, ...(inheritedPath ?? '').split(':')]) {
    // An empty entry means "the current directory" to execvp, which is a place
    // we never want a program found.
    if (dir === '' || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

/** The PATH every child of this runner gets. Pure. */
export function execPath(inheritedPath: string | undefined): string {
  return searchDirs(inheritedPath).join(':');
}

/**
 * Which of `dirs` holds `program`. Pure — the filesystem arrives as a predicate
 * so the probe order can be tested without one.
 *
 * A name with a separator in it is already a path and is returned untouched: a
 * caller who said `/usr/bin/git` or `./script` means that file, and searching
 * for its basename would run a different program than the one they named.
 */
export function findProgram(
  program: string,
  dirs: readonly string[],
  isExecutable: (path: string) => boolean,
): string | undefined {
  if (program.includes('/')) return program;
  for (const dir of dirs) {
    const candidate = `${dir}/${program}`;
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The cache, and it holds successes only.
 *
 * A resolved `git` does not move while the app runs, so the probe is worth
 * doing once. A FAILED probe is a different thing: it means the tool is not
 * installed yet, and caching that would make installing git mid-session require
 * a restart to take effect. Re-probing is a handful of `stat` calls against a
 * fixed list — nothing next to the process spawn it precedes.
 */
const resolved = new Map<string, string>();

function isExecutableFile(path: string): boolean {
  try {
    // `statSync` follows symlinks deliberately: Homebrew's `git` is a link into
    // the Cellar, and refusing to follow it would miss the one directory this
    // probe exists for. The `isFile` check is what keeps a traversable
    // DIRECTORY named `git` from reading as an executable, since a directory
    // carries the same x bits.
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * A program's absolute path, or the name back unchanged when nothing has it.
 *
 * Unresolved falls through to `execFile` with the bare name on purpose. It will
 * fail — but it fails as `spawn git ENOENT`, which is the true and recognisable
 * error for "git is not installed", rather than as an invented one from here
 * that a caller would then have to translate back.
 */
export function resolveProgram(program: string, inheritedPath = process.env['PATH']): string {
  const cached = resolved.get(program);
  if (cached !== undefined) return cached;
  const found = findProgram(program, searchDirs(inheritedPath), isExecutableFile);
  if (found === undefined) return program;
  resolved.set(program, found);
  return found;
}

/** Drop the cache. For tests, which need each case to probe for itself. */
export function clearResolvedPrograms(): void {
  resolved.clear();
}

/** The environment a git invocation runs in. Pure, so both rules are testable. */
export function gitEnv(
  mode: 'read' | 'write',
  overrides: Readonly<Record<string, string>>,
  inherited: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  // Merged, never replaced. An inherited key with no value is dropped rather
  // than passed as `undefined`, which spawn rejects.
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) env[key] = value;
  }
  if (mode === 'read') env.GIT_OPTIONAL_LOCKS = '0';
  // An explicit override wins — that is what an override is — including over the
  // flag above, so a caller who genuinely needs locks on a read can say so.
  for (const [key, value] of Object.entries(overrides)) env[key] = value;
  // Last, and over the override too, because this is not a value anybody is
  // choosing: it PREPENDS the standard locations to whatever PATH was decided
  // and keeps every entry of it. Git's own subprocesses — credential helpers,
  // `ssh`, hooks — are looked up in this string, and inheriting launchd's PATH
  // for them is the same bug as inheriting it for `git` itself.
  env['PATH'] = execPath(env['PATH']);
  return env;
}

export function runExec(cmd: readonly string[], opts: RunOptions): Promise<RunResult> {
  const [program, ...args] = cmd;
  if (program === undefined) {
    return Promise.resolve({ ok: false, code: -1, stdout: '', stderr: 'no program to run' });
  }
  // The caller's env is kept exactly as given except for PATH, which is theirs
  // plus the standard locations. `exec` is the grant that lets an extension run
  // an arbitrary program, and a program that cannot be found is not a
  // permission decision anybody made.
  return spawn(program, args, opts, {
    ...opts.env,
    PATH: execPath(opts.env?.['PATH'] ?? process.env['PATH']),
  });
}

export function runGit(
  mode: 'read' | 'write',
  args: readonly string[],
  opts: RunOptions,
): Promise<RunResult> {
  return spawn('git', [...args], opts, gitEnv(mode, opts.env ?? {}, process.env));
}

function spawn(
  program: string,
  args: readonly string[],
  opts: RunOptions,
  env: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      // Resolved rather than left to the child's own PATH lookup. The PATH
      // above would find it too, but doing it here means the log line, the
      // error and the process table all name the file we actually ran — which
      // is the difference between debugging "git is missing" and debugging
      // "which git is this".
      resolveProgram(program),
      [...args],
      {
        cwd: opts.cwd,
        env,
        timeout: opts.timeoutMs,
        // Node's own cap, above ours, so the buffer error is unreachable in
        // practice and `truncate` is what a caller actually sees.
        maxBuffer: MAX_OUTPUT_BYTES * 4,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const out = truncate(stdout);
        const errText = truncate(stderr);
        if (error === null) {
          resolve({ ok: true, code: 0, stdout: out.text, stderr: errText.text });
          return;
        }
        // A killed-by-timeout child has no exit code, and reporting 0 for it
        // would read as success. `code` is the number a caller branches on, so
        // it must never be absent.
        const code = typeof error.code === 'number' ? error.code : -1;
        resolve({
          ok: false,
          code,
          stdout: out.text,
          stderr: errText.text === '' ? error.message : errText.text,
        });
      },
    );
    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    }
  });
}

/**
 * Start a long-lived process that must OUTLIVE this one.
 *
 * Its own function rather than an option on `run`, because it is a different
 * thing: `run` awaits an answer, this deliberately never gets one. `shepherdd`
 * is the only caller, and everything about the call is load-bearing:
 *
 *   - **`detached: true` + `unref()`** — the child reparents to init and keeps
 *     running when we exit. That IS the milestone; a child that died with its
 *     parent would make the whole daemon an elaborate way to change nothing.
 *   - **`stdio` is a FILE, never a pipe** — a pipe to a parent that has gone
 *     away is a write that eventually blocks the daemon. A file has neither
 *     problem and, unlike `'ignore'`, survives the process that wrote it: the
 *     daemon owns every pty in the app, so "it exited and nobody knows why" is
 *     the one failure it must not be able to have.
 *   - **`ELECTRON_RUN_AS_NODE=1`** — `execPath` under Electron is the app
 *     binary, and this is what makes it behave as node. Measured: node-pty
 *     loads there against the ABI it is already built for, so the daemon needs
 *     no second native build.
 *
 * It lives HERE for the same reason `run` does — `boundaries.js` denies
 * `child_process` everywhere else, and the first version of this was a
 * `require()` inside main that satisfied lint by routing around it. A boundary
 * that is bypassed by changing the import syntax is not a boundary.
 */
export function spawnDetached(options: {
  readonly execPath: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Where the child's stdout and stderr go, appended.
   *
   * Absent means `'ignore'`, which is what a detached child with nowhere to
   * write had before — and it cost two debugging sessions. The first could only
   * report "did not come up within 10000ms". The second was worse: the daemon
   * had exited an hour into a run, taking every pty with it, and the only trace
   * anywhere was a pid that no longer existed. `SHEPHERD_DAEMON_STDIO=inherit`
   * still overrides this when you want the output in your own terminal.
   */
  readonly logFile?: string;
}): void {
  const child = spawnChild(options.execPath, [...options.args], {
    detached: true,
    stdio: resolveDetachedStdio(options.logFile),
    env: { ...process.env, ...options.env },
  });
  child.unref();
}

/** How big the log may get before the previous one is rolled aside. */
const DETACHED_LOG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * stdio for a detached child: inherit if asked, a file if we have one, else drop.
 *
 * Rotation happens HERE rather than in the child, because the child appends to
 * an fd it is handed and renaming a file out from under an open fd changes
 * nothing about where the bytes land. Spawn time is the one moment the file is
 * closed by everyone.
 */
function resolveDetachedStdio(logFile: string | undefined): 'inherit' | 'ignore' | (number | 'ignore')[] {
  if (process.env['SHEPHERD_DAEMON_STDIO'] === 'inherit') return 'inherit';
  if (logFile === undefined) return 'ignore';
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    if ((statSync(logFile, { throwIfNoEntry: false })?.size ?? 0) > DETACHED_LOG_MAX_BYTES) {
      renameSync(logFile, `${logFile}.1`);
    }
    const fd = openSync(logFile, 'a');
    return ['ignore', fd, fd];
  } catch {
    // A log we cannot open must not stop the daemon starting — the terminals
    // matter more than the diagnostics about them.
    return 'ignore';
  }
}
