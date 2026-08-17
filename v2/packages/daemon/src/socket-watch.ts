/**
 * Is the socket we bound still ours — and so is anybody still able to reach us?
 *
 * The third exit rule, and the one the other two leave a hole for. A daemon with
 * **no clients and no sessions** exits after a grace period; a daemon with
 * **sessions but no clients** never exits, because that is precisely the app
 * being closed with agents running, which is what this process exists for.
 *
 * That second rule has no way to tell "the app is restarting" from "the app is
 * never coming back", so it assumes the first — forever. Every abandoned dev run
 * and every smoke left a daemon holding its ptys for good: measured at 51 of them
 * on one machine, 475 of macOS's 511 pseudo-terminals consumed, and every fresh
 * `pty create` failing as a result.
 *
 * The signal that ends it is not a timer, and that is the point. A smoke deletes
 * its whole support directory on the way out — the socket file with it — so
 * nothing can ever dial that daemon again. That is not a heuristic about how long
 * an app might be closed; it is a fact about reachability. The same is true one
 * step along: a socket file that exists but is a DIFFERENT one than we bound
 * means a replacement daemon owns the name now, and every client that matters is
 * already talking to it.
 *
 * The production daemon is untouched by both. `~/.shepherd/v2/session.sock`
 * outlives an app close, stays the file this process bound, and is reconnected
 * the next time the app opens — so agents still survive being closed for as long
 * as the socket does.
 */

/** Enough of `fs.Stats` to identify a file, and nothing this has no use for. */
export interface SocketIdentity {
  readonly dev: number;
  readonly ino: number;
}

export type SocketVerdict =
  /** The file we bound is still there. Nothing to do. */
  | 'ours'
  /** Unlinked. No client can ever connect again. */
  | 'gone'
  /** A different file under our name — somebody replaced us. */
  | 'replaced';

/**
 * `undefined` for `now` means the path does not exist, which is the caller's
 * translation of `ENOENT` — a stat that fails for any other reason must NOT
 * reach here as "gone". A daemon that killed its own sessions because a stat
 * raised `EINTR` would be a far worse bug than the leak this fixes.
 */
export function socketVerdict(
  bound: SocketIdentity,
  now: SocketIdentity | undefined,
): SocketVerdict {
  if (now === undefined) return 'gone';
  // Both halves: an inode number is only unique within a filesystem, and a temp
  // directory is routinely on a different one from a home directory.
  return now.dev === bound.dev && now.ino === bound.ino ? 'ours' : 'replaced';
}

/** What the log says, so the reason a daemon exited is legible after the fact. */
export function verdictReason(verdict: Exclude<SocketVerdict, 'ours'>, path: string): string {
  return verdict === 'gone'
    ? `${path} is gone — nothing can reach this daemon any more, exiting`
    : `${path} is now a different socket — another daemon has replaced this one, exiting`;
}
