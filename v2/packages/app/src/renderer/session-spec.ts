import type { Pane } from '@shepherd/core/layout';
import type { SessionCreateRequest } from '../shared/index.ts';

/**
 * How a pane asks for its session.
 *
 * Almost everything is left out on purpose: `cwd` only when the pane has one,
 * and no `command`/`env` at all, because main fills those from
 * `shellDefaults()` — the renderer has no `$SHELL`, no `$HOME` and no
 * environment, and a value it invented here would be a guess with a
 * plausible-looking shape.
 *
 * `paneId` rides along for correlation only. The session host never looks a
 * session up by pane; the mapping lives in `PaneSessionRegistry`, in exactly
 * one place, which is the point.
 */
export function defaultSessionSpec(pane: Pane): SessionCreateRequest {
  return {
    paneId: pane.id,
    ...(pane.cwd === null ? {} : { cwd: pane.cwd }),
  };
}

/**
 * The terminal smoke's spec: print the needle, then hold the pty open.
 *
 * `exec cat` matters. Without it the shell exits the instant it has printed,
 * and the keystroke half of the smoke would be writing to a session that is
 * already gone — which fails as `unknown-session`, i.e. it would look like a
 * bridge defect rather than a dead child.
 */
export const SMOKE_NEEDLE = 'hello-from-pty';

export function smokeSessionSpec(pane: Pane): SessionCreateRequest {
  /**
   * A pane an EXTENSION opened gets a real shell, in its own directory.
   *
   * `exec cat` is right for the pane the terminal smoke types into — it echoes
   * a keystroke and nothing else, which is exactly what that smoke asserts. It
   * is wrong for a pane carrying an `initialCommand`, because `cat` does not
   * run commands: the line would be echoed, the agent would never start, and
   * the smoke would be asserting against its own fixture rather than the
   * product. Measured — `tasks.spawn`'s first live run put the orchestrator's
   * session in `/tmp` with its prompt file still on disk.
   */
  if (pane.cwd !== null || pane.initialCommand !== null) {
    return {
      paneId: pane.id,
      cwd: pane.cwd ?? '/tmp',
      command: '/bin/sh',
      args: [],
      env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
    };
  }
  return {
    paneId: pane.id,
    cwd: '/tmp',
    command: '/bin/sh',
    args: ['-c', `echo ${SMOKE_NEEDLE}; exec cat`],
    env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
  };
}
