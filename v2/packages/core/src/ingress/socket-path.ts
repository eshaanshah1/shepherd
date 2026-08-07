import { createConnection } from 'node:net';
import { unlink } from 'node:fs/promises';
import { err, ok, type Logger, type Result } from '@shepherd/sdk';

/**
 * Deciding whether a socket file may be taken over.
 *
 * v1 `unlink`ed `~/.shepherd/control.sock` unconditionally at startup with no
 * check, so **a second app instance silently stole the CLI from the first** —
 * every `shepherd` command then drove the wrong window, with nothing anywhere
 * saying so. Electron's single-instance lock (already held before this runs)
 * closes the ordinary case, but it is keyed on the userData directory: a dev
 * build, a differently-pointed build, or a crashed process mid-cleanup can all
 * leave a file here that we must reason about rather than delete.
 *
 * The reasoning is a connect probe, and it has exactly two useful outcomes:
 *
 *   - the connect **succeeds** ⇒ somebody is listening. The file is not ours to
 *     remove, and taking it would be the v1 bug on purpose.
 *   - the connect is **refused** ⇒ the file is a corpse from a process that no
 *     longer exists. Unlink it and bind.
 *
 * Anything else (a permissions error, a path that is not a socket) is reported
 * rather than guessed at.
 */

export type ReclaimOutcome =
  /** Nothing was there. */
  | 'vacant'
  /** A dead socket file was removed. */
  | 'reclaimed';

const PROBE_TIMEOUT_MS = 250;

export async function reclaimSocketPath(path: string, logger: Logger): Promise<Result<ReclaimOutcome, string>> {
  const log = logger.child('ingress');
  const probe = await probeSocket(path);

  switch (probe) {
    case 'vacant':
      return ok('vacant');

    case 'live':
      // The one branch that must never "fix" itself by deleting the file.
      log.error(`${path} is already served by a live process — refusing to take it over`);
      return err(`${path} is in use by another Shepherd instance`);

    case 'dead':
      try {
        await unlink(path);
      } catch (error) {
        if (isCode(error, 'ENOENT')) return ok('vacant'); // raced with another cleanup
        log.error(`could not remove the stale socket at ${path}: ${messageOf(error)}`);
        return err(`could not remove stale socket ${path}: ${messageOf(error)}`);
      }
      log.info(`removed a stale socket at ${path}`);
      return ok('reclaimed');
  }
}

type Probe = 'vacant' | 'live' | 'dead';

/**
 * A connect that neither succeeds nor is refused within `PROBE_TIMEOUT_MS`
 * counts as **live**: something is holding that path in a state we cannot
 * explain, and "I could not tell" must fail closed. Guessing `dead` here is how
 * a wedged-but-present instance gets its socket pulled out from under it.
 */
function probeSocket(path: string): Promise<Probe> {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    let settled = false;
    const settle = (probe: Probe): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(probe);
    };

    const timer = setTimeout(() => settle('live'), PROBE_TIMEOUT_MS);
    timer.unref();

    socket.once('connect', () => {
      clearTimeout(timer);
      settle('live');
    });
    socket.once('error', (error: unknown) => {
      clearTimeout(timer);
      if (isCode(error, 'ENOENT')) return settle('vacant');
      if (isCode(error, 'ECONNREFUSED')) return settle('dead');
      settle('live');
    });
  });
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
