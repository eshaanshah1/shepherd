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
]);

export function shellDefaultsFrom({ home, env }: ShellInputs): ShellDefaults {
  const shell = env['SHELL'];
  const command =
    shell !== undefined && shell.startsWith('/') ? shell : (FALLBACK_SHELLS[0] as string);

  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || STRIPPED.has(key)) continue;
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
