/**
 * How a prompt reaches an agent — v1's `AgentLaunch`, ported because the trap it
 * avoids has not changed.
 *
 * A pane's `initialCommand` is typed into a pty, and **a newline is an Enter
 * press**. A multi-line prompt typed directly submits its first line and
 * scatters the rest into whatever comes next; a prompt with a quote in it ends
 * the argument early and the shell reads the remainder as commands. Both are
 * silent, and both are likely — a brief is prose.
 *
 * So the prompt is written to a file and the command reads it back:
 *
 *     p=$(cat '<file>'); rm -f '<file>'; claude "$p"
 *
 * One line, no user text on it, and the file is consumed whether or not the
 * agent starts — so a prompt cannot be left lying in a data directory.
 */

export interface LaunchPlan {
  /** Where the prompt must be written before the pane mounts. */
  readonly promptFile: string;
  /** The single line to type. */
  readonly command: string;
}

/**
 * Single-quote a path for `sh`. A single quote inside is closed, escaped and
 * reopened — the only escape POSIX single-quoting has.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * `claude` by name, and this is the seam where an agent kind should eventually
 * say it (§7c: kinds already declare `capabilities`, and a launch command
 * belongs beside them). Hardcoded until a second kind exists, because inventing
 * the registry with one consumer would shape it around this caller — ADR 0031's
 * rule, applied to a smaller thing.
 */
export const AGENT_BINARY = 'claude';

/**
 * Reattach to an agent that already exists, by the token its kind gave us.
 *
 * No prompt and no prompt file: the transcript IS the context, and typing the
 * original brief at a resumed session would restate what it already knows and
 * read as a second instruction.
 *
 * `--resume` is spelled here for the same reason `AGENT_BINARY` is: one kind
 * exists, and inventing a launch-command registry with one consumer would shape
 * it around this caller. The TARGET is opaque and travels from the kind that
 * captured it (D11); only the flag around it is assumed.
 */
export function planResume(target: string): string {
  return `${AGENT_BINARY} --resume ${shellQuote(target)}`;
}

export function planLaunch(input: { readonly promptFile: string; readonly prompt: string }): LaunchPlan {
  const file = shellQuote(input.promptFile);
  // An empty prompt starts the agent with no argument, which is the right
  // behaviour for "open an agent here" — and is why the prompt is not required.
  const run = input.prompt.trim() === '' ? AGENT_BINARY : `${AGENT_BINARY} "$p"`;
  return {
    promptFile: input.promptFile,
    command: `p=$(cat ${file}); rm -f ${file}; ${run}`,
  };
}
