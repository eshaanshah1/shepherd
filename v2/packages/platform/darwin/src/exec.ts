import { execFile } from 'node:child_process';

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
  return env;
}

export function runExec(cmd: readonly string[], opts: RunOptions): Promise<RunResult> {
  const [program, ...args] = cmd;
  if (program === undefined) {
    return Promise.resolve({ ok: false, code: -1, stdout: '', stderr: 'no program to run' });
  }
  return spawn(program, args, opts, { ...opts.env });
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
      program,
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
