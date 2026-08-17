import { describe, expect, it } from 'vitest';
import { socketVerdict, verdictReason } from './socket-watch.ts';

/**
 * The rule that stops an abandoned daemon holding its ptys for ever.
 *
 * Every case here is about REACHABILITY rather than about time: the daemon may
 * not guess how long an app might be closed, and it does not have to — a socket
 * nobody can dial is a fact.
 */
describe('socketVerdict', () => {
  const bound = { dev: 1, ino: 42 };

  it('is ours while the file we bound is still there', () => {
    expect(socketVerdict(bound, { dev: 1, ino: 42 })).toBe('ours');
  });

  // What a smoke does on its way out: `rmSync(support)` takes the socket with
  // it, and the daemon that was serving it is unreachable from that instant.
  it('is gone when the path no longer exists', () => {
    expect(socketVerdict(bound, undefined)).toBe('gone');
  });

  it('is replaced when the name is held by a different file', () => {
    expect(socketVerdict(bound, { dev: 1, ino: 43 })).toBe('replaced');
  });

  /**
   * MUTATION TARGET. An inode number is unique only within a filesystem, and a
   * temp directory is routinely on a different one from a home directory — so a
   * comparison on `ino` alone calls a stranger's socket ours and keeps a daemon
   * alive that has certainly been replaced.
   */
  it('compares the device too, so an inode from another filesystem is not ours', () => {
    expect(socketVerdict(bound, { dev: 2, ino: 42 })).toBe('replaced');
  });
});

describe('verdictReason', () => {
  it('says which of the two happened, and names the path', () => {
    expect(verdictReason('gone', '/tmp/a.sock')).toContain('/tmp/a.sock');
    expect(verdictReason('gone', '/tmp/a.sock')).toContain('nothing can reach');
    expect(verdictReason('replaced', '/tmp/a.sock')).toContain('replaced');
  });
});
