import { writeFile } from 'node:fs/promises';
import { app, Menu, type BrowserWindow } from 'electron';
import type { SessionHost } from '@shepherd/core';
import { BRIDGE_SURFACE, COMMANDS, FORBIDDEN_GLOBALS, type CommandID } from '../shared/index.ts';

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

interface PaneDiagnostics {
  readonly paneId: string;
  readonly sessionId: string | null;
  readonly streaming: boolean;
  readonly mounted: boolean;
  readonly exited: boolean;
  readonly cols: number;
  readonly rows: number;
  readonly text: string;
}

interface Outline {
  readonly kind: 'leaf' | 'split';
  readonly paneId?: string;
  readonly axis?: string;
  readonly first?: Outline;
  readonly second?: Outline;
}

interface Snapshot {
  readonly ready: boolean;
  readonly paneIds: string[];
  readonly focusedPaneId: string | null;
  readonly outline: Outline | null;
  readonly panes: PaneDiagnostics[];
}

function say(line: string): void {
  process.stdout.write(`smoke: ${line}\n`);
}

function die(line: string): never {
  process.stdout.write(`smoke: FAIL ${line}\n`);
  app.exit(1);
  throw new Error(line); // unreachable; keeps the type `never`
}

function check(condition: boolean, description: string): void {
  if (!condition) die(description);
  say(`ok — ${description}`);
}

export async function runTerminalSmoke(win: BrowserWindow, host: SessionHost): Promise<void> {
  const deadline = setTimeout(() => die(`did not finish within ${TIMEOUT_MS}ms`), TIMEOUT_MS);

  const snapshot = async (): Promise<Snapshot> =>
    (await win.webContents.executeJavaScript(
      'window.__shepherdTest ? window.__shepherdTest.snapshot() : { ready: false, paneIds: [], focusedPaneId: null, outline: null, panes: [] }',
    )) as Snapshot;

  const until = async <T>(
    describe: string,
    read: () => Promise<T>,
    ok: (value: T) => boolean,
  ): Promise<T> => {
    const stop = Date.now() + TIMEOUT_MS;
    let last: T | undefined;
    while (Date.now() < stop) {
      last = await read();
      if (ok(last)) return last;
      await sleep(60);
    }
    return die(`timed out waiting for ${describe}; last = ${JSON.stringify(last)}`);
  };

  await new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) resolve();
    else win.webContents.once('did-finish-load', () => resolve());
  });
  win.show();
  win.focus();

  // --- 1. bytes → IPC → xterm's parser → the buffer.
  const first = await until(
    'the pty needle in the xterm buffer',
    snapshot,
    (s) => s.ready && (s.panes[0]?.text.includes(NEEDLE) ?? false),
  );
  const pane0 = first.panes[0] as PaneDiagnostics;
  check(first.paneIds.length === 1, 'the app opens with one pane');
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

  const closed = new Promise<void>((resolve) => win.once('closed', () => resolve()));
  clickMenu(COMMANDS.closePane);
  await closed;
  check(win.isDestroyed(), '⌘W on the LAST pane fell through and closed the window');

  clearTimeout(deadline);
  say('OK');
  app.exit(0);
}

async function captureIfAsked(win: BrowserWindow): Promise<void> {
  const path = process.env['SHEPHERD_CAPTURE'];
  if (path === undefined || path === '') return;
  const image = await win.webContents.capturePage();
  await writeFile(path, image.toPNG());
  say(`wrote ${path}`);
}

function clickMenu(id: CommandID): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById(id);
  if (item === null || item === undefined) die(`no menu item with id ${id}`);
  say(`click ${id} (${item.accelerator ?? 'no accelerator'})`);
  item.click();
}

function paneById(snapshot: Snapshot, paneId: string): PaneDiagnostics {
  const found = snapshot.panes.find((pane) => pane.paneId === paneId);
  return found ?? die(`no diagnostics for pane ${short(paneId)}`);
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function short(id: string): string {
  return id.slice(0, 8);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
