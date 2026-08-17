// The daemon's argument parsing.
//
// Small, and worth testing precisely because it is: every one of these arrives
// from a launcher in another process, and a flag silently ignored here presents
// as a feature that does not work with nothing anywhere saying why. `--support`
// is the live example — without it the daemon serves the local socket and no
// device can ever open a terminal, which looks exactly like a network fault.
//
// `main.ts` guards its own entry on `process.argv[1]`, so importing it here
// parses arguments without binding a socket.

import { describe, expect, it } from 'vitest';
import { parseArgs } from './main.ts';

describe('parseArgs', () => {
  it('reads the socket, the support dir and the level', () => {
    expect(parseArgs(['--socket=/tmp/s.sock', '--support=/tmp/sup', '--log-level=debug'])).toEqual({
      socketPath: '/tmp/s.sock',
      support: '/tmp/sup',
      level: 'debug',
      transport: 'loopback',
      socketCheckMs: 60_000,
    });
  });

  it('defaults the level, and omits support rather than inventing one', () => {
    const args = parseArgs(['--socket=/tmp/s.sock']);
    expect(args.level).toBe('info');
    // Absent means "serve the local socket only" — a default path here would be
    // a daemon serving devices from a directory nobody chose.
    expect(args.support).toBeUndefined();
  });

  it('answers an empty socket path rather than guessing one', () => {
    // `main` refuses to start on this, which is the honest response: a daemon
    // that picked a path would be a second instance nobody can reach.
    expect(parseArgs([]).socketPath).toBe('');
  });

  it('ignores arguments it does not know', () => {
    const args = parseArgs(['--socket=/tmp/s.sock', '--something-newer=1', 'stray']);
    expect(args.socketPath).toBe('/tmp/s.sock');
  });

  it('keeps a path containing an equals sign intact', () => {
    // Split on the FIRST `=` only: a temp dir can contain one, and truncating
    // it would bind a socket somewhere adjacent to where the app is looking.
    expect(parseArgs(['--socket=/tmp/a=b/s.sock']).socketPath).toBe('/tmp/a=b/s.sock');
  });

  it('reads the hostname the launcher resolved', () => {
    expect(parseArgs(['--socket=/tmp/s.sock', '--hostname=mac-b.local']).hostname).toBe(
      'mac-b.local',
    );
  });

  /**
   * Absent and empty are one case: a mirror handed `''` would compare every
   * OSC 7 host against nothing, and `cwdFromOsc7` reads that as "refuse" — the
   * same answer, reached less obviously.
   */
  it('omits an absent or empty hostname rather than passing one on', () => {
    expect(parseArgs(['--socket=/tmp/s.sock']).hostname).toBeUndefined();
    expect(parseArgs(['--socket=/tmp/s.sock', '--hostname=']).hostname).toBeUndefined();
  });
});

/**
 * The socket-reachability check's interval.
 *
 * A flag because the rule it drives is otherwise unobservable in a test that
 * finishes: the condition it detects is permanent, so production wants a minute
 * and a smoke wants a beat.
 */
describe('--socket-check-ms', () => {
  it('defaults to a minute, which is the production cadence', () => {
    expect(parseArgs(['--socket=/tmp/a.sock']).socketCheckMs).toBe(60_000);
  });

  it('takes a value a smoke can wait for', () => {
    expect(parseArgs(['--socket=/tmp/a.sock', '--socket-check-ms=250']).socketCheckMs).toBe(250);
  });

  /**
   * MUTATION TARGET. A zero busy-loops and a word produces a `NaN` interval that
   * never fires — and a rule that never fires is a rule that stopped existing,
   * silently, which is exactly the shape of the leak this was written to close.
   */
  it('refuses a value that would disable the rule rather than tune it', () => {
    for (const bad of ['0', '-1', 'soon', '']) {
      expect(parseArgs(['--socket=/tmp/a.sock', `--socket-check-ms=${bad}`]).socketCheckMs).toBe(60_000);
    }
  });
});
