import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import type { SessionHostLike } from './session-bridge.ts';
import { BRIDGE_SURFACE, COMMANDS, FORBIDDEN_GLOBALS } from '../shared/index.ts';
import {
  captureIfAsked,
  check,
  clickMenu,
  die,
  paneById,
  same,
  say,
  seedHomePane,
  short,
  snapshotOf,
  waiter,
  waitForLoad,
  type PaneDiagnostics,
  type Snapshot,
} from './smoke-support.ts';

/**
 * `pnpm smoke:terminal` — the whole chain, once, in a real Electron.
 *
 * A vitest run can prove every decision in this app and still not tell you
 * whether the app works: xterm cannot measure a cell in jsdom, `contextIsolation`
 * is not a thing a unit test can switch on, and an accelerator is resolved by
 * AppKit. So this drives the REAL app — real preload, real registry, real
 * xterm, real `MenuItem`s — and asserts:
 *
 *   1. a session's bytes reach the renderer, are parsed by xterm, and appear in
 *      its BUFFER (not merely in an IPC listener, which is a weaker claim
 *      wearing the same clothes);
 *   2. `window.shepherd` is exactly `BRIDGE_SURFACE` and `window.require` /
 *      `window.process` do not exist;
 *   3. clicking the real ⌘D / ⌘⇧D menu items splits the layout the way the
 *      layout model says (row / column), and ⌘⌥← moves focus via `neighbor`;
 *   4. a keystroke reaches xterm, xterm writes it to the pty, and the pty echoes
 *      it back into the buffer;
 *   5. ⌘W closes a pane and kills exactly that pane's session — and on the LAST
 *      pane, and only then, closes the window.
 */

const TIMEOUT_MS = 30_000;
const NEEDLE = 'hello-from-pty';
const TYPED = 'a';

export async function runTerminalSmoke(win: BrowserWindow, host: SessionHostLike): Promise<void> {
  const deadline = setTimeout(() => die(`did not finish within ${TIMEOUT_MS}ms`), TIMEOUT_MS);

  const until = waiter(TIMEOUT_MS);
  const snapshot = (): Promise<Snapshot> => snapshotOf(win);

  await waitForLoad(win);
  win.show();
  win.focus();

  // The app opens EMPTY (`seedHomePane` asserts it and says why). This smoke is
  // about what happens to BYTES once a pane exists, which was never the same
  // claim as "the app opens with one pane".
  await seedHomePane(win, TIMEOUT_MS);

  // --- 1. bytes → IPC → xterm's parser → the buffer.
  const first = await until(
    'the pty needle in the xterm buffer',
    snapshot,
    (s) => s.ready && (s.panes[0]?.text.includes(NEEDLE) ?? false),
  );
  const pane0 = first.panes[0] as PaneDiagnostics;
  check(first.paneIds.length === 1, 'the seeded pane is the only one');
  check(pane0.sessionId !== null, `pane ${short(pane0.paneId)} is bound to a session`);
  check(pane0.streaming, 'the pane is streaming');
  check(pane0.mounted, 'the pane’s terminal is parented into the view');
  // Not just "> 0": xterm's default is 80x24 and it keeps it when the fit addon
  // measures a zero-height element — which looks perfectly fine for a shell
  // prompt and is wrong the moment anything full-screen runs, because the pty
  // was told the window is 24 rows tall. The window here is 1180x760.
  check(
    pane0.cols > 80 && pane0.rows > 24,
    `xterm measured the pane rather than keeping its 80x24 default (${pane0.cols}x${pane0.rows})`,
  );
  /*
   * The grid is on the GPU.
   *
   * Nothing a vitest run can see: the fall back to xterm's DOM renderer is
   * silent and correct, so the only symptom is cost — the renderer's main
   * thread doing style, layout and paint for every cell of every streaming
   * pane. This is the one place a real WebGL context exists to be asked.
   */
  check(pane0.accelerated, 'the grid is drawn by the WebGL renderer, not xterm’s DOM one');
  check(host.list().length === 1, 'main holds exactly one live session');
  check(
    host.list()[0]?.id === pane0.sessionId,
    'the session the renderer names is the one main has',
  );

  // --- 2. the bridge surface, in the only place it can be checked.
  const surface = (await win.webContents.executeJavaScript(`({
    namespaces: Object.keys(window.shepherd),
    members: Object.fromEntries(Object.keys(window.shepherd).map((k) => [k, Object.keys(window.shepherd[k])])),
    forbidden: Object.fromEntries(${JSON.stringify(FORBIDDEN_GLOBALS)}.map((n) => [n, typeof window[n]])),
  })`)) as {
    namespaces: string[];
    members: Record<string, string[]>;
    forbidden: Record<string, string>;
  };

  const expectedNamespaces = Object.keys(BRIDGE_SURFACE);
  check(
    same(surface.namespaces, expectedNamespaces),
    `window.shepherd has exactly [${expectedNamespaces.join(', ')}] (got [${surface.namespaces.join(', ')}])`,
  );
  for (const [namespace, members] of Object.entries(BRIDGE_SURFACE)) {
    check(
      same(surface.members[namespace] ?? [], [...members]),
      `window.shepherd.${namespace} exposes exactly [${members.join(', ')}]`,
    );
  }
  for (const name of FORBIDDEN_GLOBALS) {
    check(surface.forbidden[name] === 'undefined', `window.${name} is undefined in the page`);
  }

  // --- 3. the real menu items, driving the real command handlers.
  clickMenu(COMMANDS.splitRight);
  const afterRight = await until('a row split', snapshot, (s) => s.paneIds.length === 2);
  check(afterRight.outline?.kind === 'split', 'the root became a split');
  check(afterRight.outline?.axis === 'row', "⌘D produced axis 'row' (panes side by side)");
  check(
    afterRight.focusedPaneId === afterRight.paneIds[1],
    'focus followed the new pane',
  );
  await until('a session for the new pane', () => Promise.resolve(host.list().length), (n) => n === 2);
  check(true, 'the new pane created its own session (2 live)');

  clickMenu(COMMANDS.splitDown);
  const afterDown = await until('a column split', snapshot, (s) => s.paneIds.length === 3);
  check(
    afterDown.outline?.second?.axis === 'column',
    "⌘⇧D produced axis 'column' (panes stacked) inside the right half",
  );

  // Focus is on the bottom-right pane; ⌘⌥← is the left half by `neighbor`.
  const before = afterDown.focusedPaneId;
  clickMenu(COMMANDS.focusLeft);
  const afterFocus = await until(
    'focus to move left',
    snapshot,
    (s) => s.focusedPaneId !== before,
  );
  check(
    afterFocus.focusedPaneId === afterFocus.paneIds[0],
    '⌘⌥← moved focus to the geometric neighbour (the left pane)',
  );

  // The state every assertion above is about, as a picture, for a reviewer who
  // cannot look at the screen. Off unless asked; also the first thing worth
  // having when one of these assertions starts failing.
  await captureIfAsked(win);

  // --- 4. a plain keystroke, with the menu installed.
  const focusedId = afterFocus.focusedPaneId as string;
  const textBefore = paneById(afterFocus, focusedId).text;
  check(!textBefore.includes(TYPED), `the focused pane's buffer has no '${TYPED}' yet`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: TYPED });
  win.webContents.sendInputEvent({ type: 'char', keyCode: TYPED });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: TYPED });
  await until(
    `'${TYPED}' to reach xterm, the pty, and echo back`,
    snapshot,
    (s) => paneById(s, focusedId).text.includes(TYPED),
  );
  check(true, `a plain '${TYPED}' reached xterm and the pty echoed it back`);

  // --- 5. ⌘W: the focused pane, then the window, and only on the last one.
  const killed = paneById(afterFocus, focusedId).sessionId;
  clickMenu(COMMANDS.closePane);
  await until('the pane to go', snapshot, (s) => s.paneIds.length === 2);
  await until(
    'its session to be killed',
    () => Promise.resolve(host.list().map((s) => s.id as string)),
    (ids) => !ids.includes(killed as string),
  );
  check(host.list().length === 2, '⌘W killed exactly the closed pane’s session (2 left)');
  check(!win.isDestroyed(), '⌘W did NOT close the window while panes remained');

  clickMenu(COMMANDS.closePane);
  await until('the second-to-last pane to go', snapshot, (s) => s.paneIds.length === 1);
  check(!win.isDestroyed(), 'still one pane, still a window');

  /*
   * ⌘W on the LAST pane leaves an EMPTY WINDOW. It does not quit.
   *
   * This assertion used to be the opposite — it waited for `win.once('closed')`
   * and checked `win.isDestroyed()`. That behaviour was v1's, and v1 only had it
   * because it had no empty state to fall back to; an app that vanishes when you
   * close a pane punishes you for tidying up. The empty state is a real
   * destination now: the app is running, nothing is in flight, ⌘T is right
   * there. Quitting is ⌘Q or the window's own close button, which this smoke
   * exercises immediately below by asking the window to close.
   *
   * The negative half is what makes this worth asserting: a window that closed
   * anyway would show up here as a destroyed window, not as a missing feature.
   */
  const lastSession = host.list()[0]?.id;
  clickMenu(COMMANDS.closePane);
  await until('the last pane to go', snapshot, (s) => s.paneIds.length === 0);
  check(!win.isDestroyed(), '⌘W on the LAST pane left an EMPTY WINDOW rather than quitting');
  check(
    lastSession !== undefined && !host.list().some((s) => s.id === lastSession),
    'the last pane still took its session with it',
  );
  const emptied = await snapshot();
  check(emptied.ready && emptied.outline === null, 'the projection carries a root with no tree');
  const drewEmpty = (await win.webContents.executeJavaScript(
    `document.querySelectorAll('[data-testid="empty-state"]').length`,
  )) as number;
  check(drewEmpty === 1, `the stage drew the empty state (${drewEmpty})`);

  // And the window still closes when the window is asked to close — this removed
  // a fall-through, it did not add a guard.
  const closed = new Promise<void>((resolve) => win.once('closed', () => resolve()));
  win.close();
  await closed;
  check(win.isDestroyed(), 'the window still closes when asked directly');

  clearTimeout(deadline);
  say('OK');
  app.exit(0);
}
