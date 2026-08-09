import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import { TerminalMirror, type SessionHost } from '@shepherd/core';
import { sessionId as toSessionId } from '@shepherd/sdk';
import {
  check,
  die,
  say,
  seedHomePane,
  short,
  waiter,
  waitForLoad,
} from './smoke-support.ts';

/**
 * `pnpm smoke:mirror` — R0's claim, against a real pty running a real
 * full-screen program.
 *
 * The unit tests drive a `TerminalMirror` directly. This drives the thing the
 * whole design is for: a viewer that was not watching attaches to a session
 * already inside `less`, and has to get *`less`* — not a stream of escape codes
 * it cannot reconstruct. v1's remote design lists that exact case as an accepted
 * limitation ("full-screen apps across a cold reconnect may need one redraw"),
 * so a smoke that only checked a shell prompt would pass on the architecture
 * this milestone exists to replace.
 *
 * Four claims, in order:
 *
 *   1. the host's screen follows a real pty into the ALT SCREEN;
 *   2. a cold attach replays that screen, and repainting it into a fresh
 *      emulator reproduces the host's screen exactly;
 *   3. bytes arriving DURING an attach appear exactly once — the p4 defect,
 *      through a real pty rather than a synthetic feed;
 *   4. leaving the full-screen app returns the screen to the primary buffer.
 */

const TIMEOUT_MS = 45_000;

/**
 * The markers are ASSEMBLED BY THE SHELL, so the echo of the command line does
 * not itself contain them.
 *
 * The first run of this smoke asserted on `t.includes(PRIMARY_MARKER)` with the
 * marker written literally into the command, and it passed instantly — against
 * the shell's ECHO of a line that had not run. Same trick `host.test.ts` uses,
 * for the same reason, and this is the second time it has paid for itself.
 */
const PRIMARY_MARKER = 'PRIMARY-SCREEN-MARKER';
const PRIMARY_CMD = `printf 'PRIMARY-SCREEN-%s\\n' 'MARKER'\r`;
const ALT_MARKER = 'INSIDE-THE-ALT-SCREEN';
const ALT_CMD = `printf 'INSIDE-THE-ALT-%s\\n' 'SCREEN' | less\r`;
const AFTER_MARKER = 'AFTER-DETACH';
const AFTER_CMD = `printf 'AFTER-%s\\n' 'DETACH'\r`;

/** The pty the mirror is asserted against. Explicit, so the screen has a size. */
const COLS = 100;
const ROWS = 30;

/** Writes issued DURING the attach, so the capture window is never empty. */
const BURST = 40;

export async function runMirrorSmoke(win: BrowserWindow, host: SessionHost): Promise<void> {
  const deadline = setTimeout(() => die(`did not finish within ${TIMEOUT_MS}ms`), TIMEOUT_MS);
  const until = waiter(TIMEOUT_MS);

  await waitForLoad(win);
  win.show();
  win.focus();
  await seedHomePane(win, TIMEOUT_MS);

  /**
   * A session of this smoke's own, and NOT the seeded pane's.
   *
   * The seeded pane runs `exec cat` (see `session-spec.ts`) — it echoes a
   * keystroke and runs nothing, which is exactly right for the terminal smoke
   * and useless here: this one needs a real shell that can enter a full-screen
   * program. Measured on the first run, where every command echoed twice and
   * ran zero times.
   */
  const created = host.create({
    cwd: '/tmp',
    command: '/bin/sh',
    args: [],
    env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
    cols: COLS,
    rows: ROWS,
  });
  if (!created.ok) return die(`could not create a session: ${created.error.message}`);
  const id = toSessionId(created.value.id);
  say(`session ${short(created.value.id)} — /bin/sh at ${COLS}x${ROWS}`);

  // Every command below ends in `\r`, never `\n`. A pty carries Enter as CR; an
  // LF reaches the shell as a literal linefeed it will not act on —
  // `SessionHost.paste` documents exactly this.
  const screen = () => host.screen(id);
  const screenText = () => screen()?.text ?? '';

  // --- 1. the host's screen follows a real pty.
  host.write(id, PRIMARY_CMD);
  await until('the marker on the host screen', () => Promise.resolve(screenText()), (t) =>
    t.includes(PRIMARY_MARKER),
  );
  check(screen()?.altScreen === false, 'the shell is on the primary screen');
  check(
    screen()?.cols === COLS && screen()?.rows === ROWS,
    `the host screen is the size the pane measured (${screen()?.cols}x${screen()?.rows})`,
  );

  // --- 2. into a full-screen program, and a COLD attach must get it.
  //
  // `less` rather than vim: it is on every macOS, it takes the alt screen, and
  // it quits on a single `q` with nothing to save. `-X` is deliberately NOT
  // passed — that flag is precisely "do not use the alt screen".
  host.write(id, ALT_CMD);
  await until(
    'the pty to enter the alt screen with its content drawn',
    () => Promise.resolve({ alt: screen()?.altScreen === true, text: screenText() }),
    (s) => s.alt && s.text.includes(ALT_MARKER),
  );
  check(true, 'the host screen followed the pty into the alt screen');
  // The primary buffer's content is behind it, which is what makes this the
  // alt screen rather than a cleared one.
  check(
    !screenText().includes(PRIMARY_MARKER),
    'the alt screen shows the program, not the shell scrollback behind it',
  );

  // A viewer that has been attached to NOTHING until this moment.
  const cold: Uint8Array[] = [];
  const attached = host.attach(id, (bytes) => cold.push(bytes));
  if (!attached.ok) return die(`cold attach failed: ${attached.error.message}`);

  await until(
    'the cold viewer to receive its replay',
    () => Promise.resolve(cold.length),
    (n) => n > 0,
  );

  const replay = new TextDecoder().decode(concat(cold));
  check(replay.includes(ALT_MARKER), 'the cold viewer was handed the alt screen’s content');

  /**
   * The strong form: repaint what the viewer received into a fresh emulator and
   * require the SAME screen the host has. A byte replay fails this outright — it
   * would re-run `?1049h` against an emulator that never saw what `less` drew.
   *
   * The host screen is read HERE, after the replay has landed, and not before
   * `attach`. `screen()` is "what has been parsed"; `capture()` is "everything
   * queued so far", and the two differ whenever bytes are in flight — which the
   * first run of this comparison discovered by failing. Nothing is written
   * between entering `less` and this point, so the screen is quiescent and the
   * two are the same instant.
   */
  const hostScreen = screenText();
  const repainted = await repaint(replay, COLS, ROWS);
  check(
    repainted.altScreen,
    'repainting the replay lands in the alt screen, not a blank primary one',
  );
  if (repainted.text !== hostScreen) {
    say(`  host:      ${JSON.stringify(hostScreen.slice(0, 300))}`);
    say(`  repainted: ${JSON.stringify(repainted.text.slice(0, 300))}`);
  }
  check(
    repainted.text === hostScreen,
    'the repainted screen is byte-identical to the host’s screen',
  );

  /**
   * --- 3. the p4 defect, through a real pty: bytes arriving DURING an attach.
   *
   * A SECOND cold viewer, with a burst written straight after it attaches. With
   * a capture taken one microtask late the snapshot carries bytes that are also
   * in the live queue, and the alt-screen content — which is in every snapshot —
   * is then delivered twice.
   */
  const second: Uint8Array[] = [];
  const alsoAttached = host.attach(id, (bytes) => second.push(bytes));
  if (!alsoAttached.ok) return die(`second attach failed: ${alsoAttached.error.message}`);
  // `less` is holding the terminal; these are DSR requests it answers, so real
  // bytes flow back through the fanout while the capture is in flight.
  for (let i = 0; i < BURST; i += 1) host.write(id, '\x1b[6n');

  await until(
    'the second viewer to receive its replay',
    () => Promise.resolve(second.length),
    (n) => n > 0,
  );
  const secondStream = new TextDecoder().decode(concat(second));
  const altHits = secondStream.split(ALT_MARKER).length - 1;
  check(
    altHits === 1,
    `a viewer attaching mid-burst got the screen exactly once (got ${altHits}×)`,
  );
  alsoAttached.value.dispose();

  // --- 4. leaving the program returns to the primary buffer.
  attached.value.dispose();
  host.write(id, 'q');
  await until(
    'the pty to leave the alt screen',
    () => Promise.resolve(screen()?.altScreen === true),
    (alt) => !alt,
  );
  check(true, 'quitting the full-screen program returned the screen to the primary buffer');
  check(
    screenText().includes(PRIMARY_MARKER),
    'the shell scrollback is back, which a cleared screen would not be',
  );

  // A detached viewer receives nothing more.
  const afterDetach = cold.length;
  host.write(id, AFTER_CMD);
  await until('the host screen to move on', () => Promise.resolve(screenText()), (t) =>
    t.includes(AFTER_MARKER),
  );
  check(cold.length === afterDetach, 'a disposed viewer received nothing after detaching');

  clearTimeout(deadline);
  say('OK');
  app.quit();
}

/** Feed a replay into a fresh mirror and read the screen it produces. */
function repaint(
  data: string,
  cols: number,
  rows: number,
): Promise<{ text: string; altScreen: boolean }> {
  const mirror = new TerminalMirror({ cols, rows });
  mirror.feed(new TextEncoder().encode(data));
  return new Promise((resolve) => {
    mirror.capture(() => {
      const { text, altScreen } = mirror.screen();
      mirror.dispose();
      resolve({ text, altScreen });
    });
  });
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
