import { systemHome } from './system.ts';

/**
 * What a new terminal session inherits when the renderer does not say.
 *
 * The renderer cannot answer any of this: it has no `os.homedir()`, no
 * `$SHELL`, and no environment. Main could read them directly, but reaching the
 * machine is this package's whole job — so the OS lookup is here and the pure
 * decision (what to fall back to, what to strip) is a function with a test.
 */

export interface ShellDefaults {
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface ShellInputs {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** POSIX login shells we are willing to launch by default, best first. */
const FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash', '/bin/sh'] as const;

/**
 * **Another Shepherd's correlation env, which must never reach one of our panes.**
 *
 * v1 injects these into every pane it opens. v2 development happens *inside* v1 —
 * so `pnpm dev` launched from a v1 pane gives this Electron process
 * `SHEPHERD_TAB_ID` and a live `SHEPHERD_SOCK`, and without this list every key of
 * `process.env` is copied into every session below. A `claude` in a v2 pane would
 * then fire v1's globally-installed plugin, which guards on exactly those two
 * names, and post its lifecycle events to the **running v1 app** — flipping an
 * unrelated v1 pane's state, badging its dock and firing its notifications.
 * `SHEPHERD_CTL_SOCK` is the same leak one door along: v1's `shepherd` CLI, run in
 * a v2 pane, would drive v1.
 *
 * This is not v1-specific and does not expire with v1. Any Shepherd inherits any
 * other Shepherd's environment whenever one is launched from the other, including
 * v2-dev from v2-daily; the app must inject its own correlation env and never pass
 * one along. Stripping is the only place that can be decided, because the
 * injection seam (`WillCreatePatch`) merges and cannot delete
 * (`session/host.ts`).
 *
 * Kept exported so a test can assert against the same list the code uses rather
 * than a copy of it that can drift.
 */
export const INHERITED_SHEPHERD_VARS = [
  'SHEPHERD_TAB_ID',
  'SHEPHERD_SOCK',
  'SHEPHERD_CTL_SOCK',
  'SHEPHERD_PTY_SOCK',
  'SHEPHERD_SESSION_ID',
  'SHEPHERD_EVENTS_SOCK',
  'SHEPHERD_CONTROL_SOCK',
] as const;

/**
 * Variables that describe the *app's* process and would lie inside a child:
 * they are Electron's, not the shell's, and a program that reads them
 * (`node`, another Electron app, a test runner) behaves differently for no
 * visible reason. `TERM` is dropped for a different reason — node-pty sets it
 * from the spec, and an inherited one would silently win.
 */
const STRIPPED = new Set([
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_RENDERER_URL',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'NODE_OPTIONS',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'COLORTERM',
  ...INHERITED_SHEPHERD_VARS,
]);


/**
 * Session-scoped variables another AGENT's process planted in our environment.
 *
 * Measured, not hypothetical: the dev app launched from inside a Claude Code
 * session inherits that session's `CLAUDE_CODE_CHILD_SESSION` et al., and every
 * agent spawned in a pane then believes it is a nested child of a session it
 * has never met — transcript saving off, a warning banner, wrong attribution.
 * ADR 0024's class of bug (a pane inheriting another Shepherd's correlation
 * env), one vendor over.
 *
 * A prefix match rather than a list, deliberately: these names are another
 * program's private vocabulary and grow without notice — an allow-list here
 * would be stale the day it shipped. `CLAUDE_CONFIG_DIR` survives via the
 * explicit carve-out because it is the USER's setting (which account/profile to
 * use), not a session's breadcrumb — v1's profiles feature depends on exactly
 * that distinction.
 */
export function isForeignAgentVar(key: string): boolean {
  if (key === 'CLAUDE_CONFIG_DIR') return false;
  return key.startsWith('CLAUDE_CODE_') || key.startsWith('CLAUDE_') || key === 'CLAUDECODE';
}

export function shellDefaultsFrom({ home, env }: ShellInputs): ShellDefaults {
  const shell = env['SHELL'];
  const command =
    shell !== undefined && shell.startsWith('/') ? shell : (FALLBACK_SHELLS[0] as string);

  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || STRIPPED.has(key) || isForeignAgentVar(key)) continue;
    inherited[key] = value;
  }
  inherited['HOME'] = home;

  return {
    cwd: home,
    command,
    // `-l`: a pane's shell is a login shell, which is how a GUI-launched app
    // ends up with the PATH the user actually configured. v1 learned this the
    // hard way — a `.app` inherits a minimal PATH and cannot find Homebrew.
    args: ['-l'],
    env: inherited,
  };
}

/** The same thing, against the real machine. */
export function shellDefaults(): ShellDefaults {
  return shellDefaultsFrom({ home: systemHome(), env: process.env });
}

export { FALLBACK_SHELLS };
