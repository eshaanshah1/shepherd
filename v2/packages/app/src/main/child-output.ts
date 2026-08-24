import type { CategoryLogger } from '@shepherd/sdk';

/**
 * A child process's own output, in the log.
 *
 * The extension host writes a few lines that cannot go through the port, because
 * each one says the port is unusable. Inherited stdio sends them to a terminal an
 * installed app does not have.
 */

/**
 * Chunks in, whole lines out — a pipe splits wherever it likes, so a chunk
 * boundary is not a line boundary.
 *
 * A tail with no trailing newline is held, never emitted.
 */
export function lineReader(emit: (line: string) => void): (chunk: Buffer | string) => void {
  let held = '';
  return (chunk) => {
    held += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = held.split('\n');
    held = lines.pop() ?? '';
    for (const line of lines) if (line.trim() !== '') emit(line);
  };
}

/** The two streams a piped child exposes. Both may be absent. */
export interface ChildOutput {
  readonly stdout?: NodeJS.ReadableStream | null;
  readonly stderr?: NodeJS.ReadableStream | null;
}

/**
 * Point a piped child's stdout and stderr at `log`.
 *
 * stderr logs at warn and stdout at info: the child chose the stream, and a log
 * where every line from it reads the same is one you cannot skim. A missing
 * stream is reported — piping was asked for, so absent means output is going
 * nowhere.
 */
export function forwardChildOutput(child: ChildOutput, log: CategoryLogger, what: string): void {
  if (child.stdout === undefined || child.stdout === null) log.warn(`${what} has no stdout to read`);
  else child.stdout.on('data', lineReader((line) => log.info(line)));

  if (child.stderr === undefined || child.stderr === null) log.warn(`${what} has no stderr to read`);
  else child.stderr.on('data', lineReader((line) => log.warn(line)));
}
