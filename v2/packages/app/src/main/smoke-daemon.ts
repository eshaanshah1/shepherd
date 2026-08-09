import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import { sessionId as toSessionId } from '@shepherd/sdk';
import type { SessionHostLike } from './session-bridge.ts';
import { check, die, say, seedHomePane, snapshotOf, waiter, waitForLoad } from './smoke-support.ts';

/**
 * `pnpm smoke:daemon` — R1's claim, across a real app restart.
 *
 * The runner drives this TWICE against the same userData and the same support
 * directory, quitting in between, and the two passes assert opposite halves:
 *
 *   **Pass 1** opens a pane, types a marker into it, and reports the session id
 *   and the pty pid. Then it quits.
 *
 *   **Pass 2** must find the SAME session on the SAME pane — adopted, not
 *   recreated — with the marker still on its screen. If pane ids or bindings did
 *   not survive (ADR 0036), pass 2 creates a second pty and the daemon's
 *   original keeps running with nothing pointing at it. That is the failure this
 *   exists to catch, and a smoke that only checked "a pane exists" would pass
 *   straight through it.
 *
 * The runner checks what only a runner can: that the pty is still alive between
 * the two passes, with no app running at all.
 */

const TIMEOUT_MS = 60_000;
const MARKER = 'DAEMON-SURVIVES-ME';
/**
 * Typed straight in, not run as a command.
 *
 * The seeded pane's session is `exec cat` (see `session-spec.ts`) — it echoes a
 * keystroke and runs nothing, so a `printf` would appear on screen twice and
 * execute zero times. That cost this smoke its first run, and the mirror smoke
 * its third.
 *
 * The echo is not a workaround, it is the better proof: what has to survive the
 * restart is a screen only THIS pty ever produced, and an echoed marker is
 * exactly that. A freshly spawned lookalike shows nothing.
 */
const MARKER_CMD = `${MARKER}\r`;

export async function runDaemonSmoke(
  win: BrowserWindow,
  host: SessionHostLike,
  pass: number,
): Promise<void> {
  const deadline = setTimeout(() => die(`did not finish within ${TIMEOUT_MS}ms`), TIMEOUT_MS);
  const until = waiter(TIMEOUT_MS);
  const screenText = async (id: string) =>
    (await Promise.resolve(host.screen(toSessionId(id))))?.text ?? '';

  await waitForLoad(win);
  win.show();

  if (pass === 1) {
    await seedHomePane(win, TIMEOUT_MS);
    const seeded = await until(
      'the seeded pane to bind a session',
      () => snapshotOf(win),
      (s) => s.ready && (s.panes[0]?.sessionId ?? null) !== null,
    );
    const pane = seeded.panes[0];
    if (pane?.sessionId == null) return die('pass 1 got no session');

    host.write(toSessionId(pane.sessionId), MARKER_CMD);
    await until('the marker on the screen', () => screenText(pane.sessionId as string), (t) =>
      t.includes(MARKER),
    );
    check(true, 'pass 1 ran a marker command in its pane');

    const info = host.get(toSessionId(pane.sessionId));
    // The runner reads these back out of stdout and checks the pid between runs.
    say(`daemon-pass1 pane=${pane.paneId} session=${pane.sessionId} pid=${info?.pid ?? 0}`);
    clearTimeout(deadline);
    say('OK');
    // `quit`, so `will-quit` runs — the whole question is whether that ends the
    // pty, and it must not.
    app.quit();
    return;
  }

  // --- pass 2: the layout restores, and the pane must find its session again.
  const restored = await until(
    'the restored pane to report a session',
    () => snapshotOf(win),
    (s) => s.ready && s.paneIds.length > 0 && (s.panes[0]?.sessionId ?? null) !== null,
  );
  const pane = restored.panes[0];
  if (pane?.sessionId == null) return die('pass 2 restored a pane with no session');

  check(restored.paneIds.length === 1, `pass 2 restored exactly one pane (${restored.paneIds.length})`);
  check(
    host.list().length === 1,
    `the daemon holds exactly one session — no second pty was created (${host.list().length})`,
  );

  // The marker is the proof it is the SAME pty and not a lookalike: a freshly
  // spawned shell has an empty screen.
  const text = await screenText(pane.sessionId);
  check(text.includes(MARKER), 'the restored pane’s screen still carries pass 1’s marker');

  say(`daemon-pass2 pane=${pane.paneId} session=${pane.sessionId} pid=${host.get(toSessionId(pane.sessionId))?.pid ?? 0}`);
  clearTimeout(deadline);
  say('OK');
  app.quit();
}
