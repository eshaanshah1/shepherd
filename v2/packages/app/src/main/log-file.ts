import { mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogSink } from '@shepherd/sdk';

/**
 * The app's log, on disk — beside the daemon's.
 *
 * `packages/sdk` may not open a file; this package is the one that may.
 */

/** How big the log may get before the previous one is rolled aside. */
export const APP_LOG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Open `path` for appending and return a sink that writes to it — `undefined`
 * when it cannot be opened, so the caller can say so on stdout.
 *
 * Rotation happens at open rather than on the write that crosses the cap: a
 * rename does not move an open descriptor.
 */
export function openLogFile(path: string): LogSink | undefined {
  let fd: number;
  try {
    mkdirSync(dirname(path), { recursive: true });
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > APP_LOG_MAX_BYTES) {
      // One generation, so two rotations cannot fill a disk.
      renameSync(path, `${path}.1`);
    }
    fd = openSync(path, 'a');
  } catch {
    return undefined;
  }

  return (line) => {
    // Synchronous: an async write loses whatever is buffered when the process
    // dies, and those are the lines worth reading.
    writeSync(fd, `${line}\n`);
  };
}
