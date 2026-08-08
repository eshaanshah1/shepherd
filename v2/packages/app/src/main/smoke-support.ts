import { writeFile } from 'node:fs/promises';
import { app, Menu, type BrowserWindow } from 'electron';
import type { CommandID } from '../shared/index.ts';

/**
 * What the two in-app smokes share: how they talk, how they wait, and how they
 * reach the real menu.
 *
 * Kept deliberately small. The assertions themselves live in each smoke, so a
 * reader can see the whole claim in one file; only the plumbing is here.
 */

export interface PaneDiagnostics {
  readonly paneId: string;
  readonly sessionId: string | null;
  readonly streaming: boolean;
  readonly mounted: boolean;
  readonly exited: boolean;
  readonly cols: number;
  readonly rows: number;
  readonly text: string;
}

export interface Outline {
  readonly kind: 'leaf' | 'split';
  readonly paneId?: string;
  readonly axis?: string;
  readonly first?: Outline;
  readonly second?: Outline;
}

export interface Snapshot {
  readonly ready: boolean;
  readonly paneIds: string[];
  readonly focusedPaneId: string | null;
  readonly outline: Outline | null;
  readonly panes: PaneDiagnostics[];
}

const EMPTY: Snapshot = {
  ready: false,
  paneIds: [],
  focusedPaneId: null,
  outline: null,
  panes: [],
};

export function say(line: string): void {
  process.stdout.write(`smoke: ${line}\n`);
}

export function die(line: string): never {
  process.stdout.write(`smoke: FAIL ${line}\n`);
  app.exit(1);
  throw new Error(line); // unreachable; keeps the type `never`
}

export function check(condition: boolean, description: string): void {
  if (!condition) die(description);
  say(`ok — ${description}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function short(id: string): string {
  return id.slice(0, 8);
}

export function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function snapshotOf(win: BrowserWindow): Promise<Snapshot> {
  return win.webContents
    .executeJavaScript(
      'window.__shepherdTest ? window.__shepherdTest.snapshot() : null',
    )
    .then((value) => (value as Snapshot | null) ?? EMPTY);
}

export function paneById(snapshot: Snapshot, paneId: string): PaneDiagnostics {
  return snapshot.panes.find((pane) => pane.paneId === paneId) ?? die(`no pane ${short(paneId)}`);
}

/**
 * Poll until a condition holds, or say what it last saw. The "last saw" half is
 * the point: a timeout with no value in it turns a five-minute diagnosis into
 * an afternoon.
 */
export function waiter(timeoutMs: number) {
  return async function until<T>(
    describe: string,
    read: () => Promise<T>,
    ok: (value: T) => boolean,
  ): Promise<T> {
    const stop = Date.now() + timeoutMs;
    let last: T | undefined;
    while (Date.now() < stop) {
      last = await read();
      if (ok(last)) return last;
      await sleep(60);
    }
    return die(`timed out waiting for ${describe}; last = ${JSON.stringify(last)}`);
  };
}

/** Clicks the REAL `MenuItem`, which is precisely what AppKit invokes. */
export function clickMenu(id: CommandID): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById(id);
  if (item === null || item === undefined) die(`no menu item with id ${id}`);
  say(`click ${id} (${item.accelerator ?? 'no accelerator'})`);
  item.click();
}

/**
 * Give the home root its first pane, and prove the empty state was real.
 *
 * **The app now boots with NO panes.** The home root is minted `{ empty: true }`
 * (see `index.ts`), because minting a shell nobody asked for is how "you have no
 * tasks" came to be drawn as a terminal sitting in a directory that had usually
 * just been deleted. The empty state is the resting state; a task, or this, is
 * what puts a pane on the stage.
 *
 * So every smoke that is ABOUT a pane — the session, the ring, the terminal, the
 * split — now says so: it asserts the window opened empty, asks for a pane, and
 * gets on with what it was testing. That is one extra assertion and one extra
 * line each, and it is strictly more than they proved before, because "the app
 * opens with one pane" was never the claim any of them existed to make.
 *
 * It goes through **the page's own bridge**, not `layout.open` in main, for the
 * same reason `smoke:m0` writes its bytes that way: the whole boundary —
 * sandboxed renderer, preload, IPC, the registry, the authorization — is the
 * half a unit test cannot reach, and a helper that skipped it would be testing
 * a store this process could have called directly.
 */
export async function seedHomePane(win: BrowserWindow, timeoutMs: number): Promise<Snapshot> {
  const until = waiter(timeoutMs);

  const empty = await until(
    'the window to render, with no panes',
    () => snapshotOf(win),
    (snapshot) => snapshot.ready,
  );
  check(empty.paneIds.length === 0, `the app opens with no panes (${empty.paneIds.length})`);

  const opened = (await win.webContents.executeJavaScript(
    `window.shepherd.commands.invoke('layout.openRoot', { root: 'window-1' })`,
  )) as { ok: boolean; error?: { code: string; message: string } };
  check(opened.ok, `layout.openRoot filled the empty home root${opened.ok ? '' : `: ${opened.error?.message ?? ''}`}`);

  return until(
    'the renderer to report a pane bound to a session',
    () => snapshotOf(win),
    (snapshot) => snapshot.paneIds.length === 1 && (snapshot.panes[0]?.sessionId ?? null) !== null,
  );
}

export async function captureIfAsked(win: BrowserWindow): Promise<void> {
  const path = process.env['SHEPHERD_CAPTURE'];
  if (path === undefined || path === '') return;
  const image = await win.webContents.capturePage();
  await writeFile(path, image.toPNG());
  say(`wrote ${path}`);
}

export function waitForLoad(win: BrowserWindow): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) resolve();
    else win.webContents.once('did-finish-load', () => resolve());
  });
}
