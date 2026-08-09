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
 * The agent's binary, for LAUNCHING a new session.
 *
 * `planResume` used to live beside this and is gone: a resume command now comes
 * from the agent kind through `agents.resumeCommand` (ADR 0036 §3), because R1
 * gave that seam its second consumer. This one stays for now, and for the same
 * reason it always did — a LAUNCH carries a prompt file and a shell line built
 * around it, which is a bigger shape than a kind declares today. It is the next
 * thing to move, not a decision to keep it here.
 */
export const AGENT_BINARY = 'claude';

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
