import { request } from 'node:http';
import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import { sessionId as toSessionId } from '@shepherd/sdk';
import type { SessionHostLike } from './session-bridge.ts';
import { check, die, say, seedHomePane, snapshotOf, waiter, waitForLoad } from './smoke-support.ts';
import type { M1SmokeOptions } from './smoke-m1.ts';

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
 *
 * **It also carries the agent's STATE across that restart**, which is a separate
 * claim and was the bug: the pty surviving is worth nothing if the app comes back
 * believing nothing is running in it. A `claude` that did not restart fires no
 * new `SessionStart`, so pass 2 asks with no hook of its own — every state it
 * reads was earned in pass 1. Unit tests cannot reach this: they supply both
 * halves of the correlation, and the whole failure was the two halves being in
 * different processes.
 */

const TIMEOUT_MS = 60_000;
const MARKER = 'DAEMON-SURVIVES-ME';
/** The vendor's own session id, so the slot's survival is checkable too. */
const CLAUDE_SESSION = 'claude-daemon-smoke-1';
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
  options: M1SmokeOptions,
): Promise<void> {
  const deadline = setTimeout(() => die(`did not finish within ${TIMEOUT_MS}ms`), TIMEOUT_MS);
  const until = waiter(TIMEOUT_MS);
  const screenText = async (id: string) =>
    (await Promise.resolve(host.screen(toSessionId(id))))?.text ?? '';

  /** A command over the real control socket, exactly as the CLI would ask. */
  const invoke = async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const body = JSON.stringify({ command, args, caller: { kind: 'device', deviceId: 'local-cli' } });
    const raw = await postTo(options.controlSocket, '/invoke', body);
    const parsed = JSON.parse(raw) as { ok?: boolean; value?: unknown; error?: { message?: string } };
    if (parsed.ok !== true) die(`${command}: ${parsed.error?.message ?? raw}`);
    return parsed.value;
  };

  const agentState = async (sessionId: string): Promise<string> => {
    const answer = (await invoke('agents.list')) as { agents?: { sessionId?: string; state?: string }[] };
    return answer.agents?.find((row) => row.sessionId === sessionId)?.state ?? '';
  };

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

    /*
     * Make it an AGENT, over the real hook wire.
     *
     * Two events, because one would not be a mid-turn state: `SessionStart`
     * adopts the session (and is where `claude-code` records its resume target,
     * which is the slot the restore has to carry), and `UserPromptSubmit` opens
     * a turn. `working` is then the state that must survive — it is also the one
     * the ordering guard needs, since a mid-turn event arriving at a session
     * restored as `shell` is discarded.
     */
    await postHook(options.hookSocket, pane.sessionId, 'SessionStart');
    await postHook(options.hookSocket, pane.sessionId, 'UserPromptSubmit');
    await until('pass 1’s agent to read working', () => agentState(pane.sessionId as string), (s) => s === 'working');
    check(true, 'pass 1 left a working agent in the pane');

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

  /*
   * THE assertion, and it discriminates between both halves of the fix.
   *
   * Pass 1 left the agent `working`. The RUNNER then posted a `Stop` to the
   * daemon's hook socket with no app running at all — an agent finishing its turn
   * while the app is being replaced, which is the case that used to be lost
   * outright. Pass 2 posts nothing itself, because a `claude` that did not restart
   * never fires another `SessionStart`; that is exactly why none of this can be
   * inferred and all of it has to be carried.
   *
   * Each outcome names a different missing piece:
   *
   *   - `''`        — nothing restored the registry; the session was never adopted.
   *   - `working`   — the journal did not hold the `Stop`, or nobody replayed it.
   *   - `idle`      — the snapshot restored the base AND the real event was folded
   *                   onto it. Which is the pass.
   *
   * **`idle` rather than `needsCheck`, and that is ADR 0020 rather than a
   * compromise.** This smoke restores exactly ONE pane, so it is focused and
   * `viewing` is true, and a turn ending under the user's eyes lands `idle`
   * directly — `needsCheck` means "you have not seen this yet", and green clears
   * to grey the moment you look. A real window of several tasks lands `needsCheck`
   * on the panes you are not looking at, which is `stop-policy`'s own test.
   *
   * It is no weaker as a discriminator: `idle` is unreachable here without the
   * replay (the state would still be `working`) and unreachable without the
   * snapshot (a mid-turn event arriving at an unrestored session reads `shell`,
   * and the ordering guard discards it — ADR 0004).
   */
  const state = await until(
    'the restored agent state to arrive',
    () => agentState(pane.sessionId as string),
    (s) => s !== '' && s !== 'working',
  );
  check(
    state === 'idle',
    `the turn that ended while the app was DOWN was folded, not lost (read ${state})`,
  );

  /*
   * And the vendor's slot with it. Without this the session is tracked but
   * unresumable — `agents.resumeTarget` answers null, which reads as "this agent
   * was never resumable" rather than "its lock was dropped on restart".
   */
  const resume = (await invoke('agents.resumeTarget', { sessionId: pane.sessionId })) as {
    resumeTarget?: string | null;
  };
  check(
    resume.resumeTarget === CLAUDE_SESSION,
    `the kind’s resume target survived too (${String(resume.resumeTarget)})`,
  );

  say(`daemon-pass2 pane=${pane.paneId} session=${pane.sessionId} pid=${host.get(toSessionId(pane.sessionId))?.pid ?? 0}`);
  clearTimeout(deadline);
  say('OK');
  app.quit();
}

/**
 * Exactly the envelope `report.sh` builds, over exactly the socket it uses —
 * the same rule `smoke-m2` states: a second transport that happened to work
 * would say nothing about the first.
 */
function postHook(socket: string, sessionId: string, event: string): Promise<void> {
  const body = JSON.stringify({
    topic: 'claude.hook',
    session_id: sessionId,
    payload: { event, hook: { session_id: CLAUDE_SESSION } },
  });
  return postTo(socket, '/events', body).then(() => undefined);
}

function postTo(socketPath: string, path: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
