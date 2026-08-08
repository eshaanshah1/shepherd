import { app, type BrowserWindow } from 'electron';
import type { SessionHost } from '@shepherd/core';
import { sessionId } from '@shepherd/sdk';
import { COMMANDS } from '../shared/index.ts';
import {
  captureIfAsked,
  check,
  clickMenu,
  die,
  paneById,
  say,
  short,
  seedHomePane,
  snapshotOf,
  waiter,
  waitForLoad,
  type Snapshot,
} from './smoke-support.ts';

/**
 * `pnpm smoke` — the M0 gate. One run of the real app that either proves the
 * whole milestone claim or fails.
 *
 * The claim, in the order it is checked:
 *
 *   boot → a session exists → write `echo <needle>` through the bridge → those
 *   bytes are in the session's REPLAY RING → split the pane with the layout
 *   command → two leaves and two live sessions → quit cleanly.
 *
 * Two choices worth defending:
 *
 *   - The write goes through `window.shepherd.session.write` in the page, not
 *     through `host.write` in main. That is the whole boundary — sandboxed
 *     renderer, CJS preload, contextBridge, IPC, validation, bridge, host — and
 *     it is the half a unit test cannot reach.
 *   - The assertion is on `host.snapshot(id)`, the ring, not on the xterm
 *     buffer. The ring is what a reattaching view replays, so it is the thing
 *     M0 actually promises; `smoke:terminal` separately proves the bytes reach
 *     xterm's parser.
 *
 * It quits with `app.quit()` rather than `app.exit()` so `will-quit` runs and
 * the PTYs are killed. The runner then checks their pids are really gone —
 * "and no stray process" is a claim, so it gets an assertion.
 */

const TIMEOUT_MS = 40_000;
const NEEDLE = 'm0-ring-ok';

export async function runM0Smoke(win: BrowserWindow, host: SessionHost): Promise<void> {
  const deadline = setTimeout(() => die(`did not finish within ${TIMEOUT_MS}ms`), TIMEOUT_MS);
  const until = waiter(TIMEOUT_MS);
  const snapshot = (): Promise<Snapshot> => snapshotOf(win);

  // --- 1. boot.
  await waitForLoad(win);
  win.show();
  win.focus();

  // The app opens EMPTY — see `seedHomePane`. It asserts that, then asks for a
  // pane through the page's own bridge and waits for it to be bound.
  const booted = await seedHomePane(win, TIMEOUT_MS);
  const pane = booted.paneIds[0] as string;
  const session = paneById(booted, pane).sessionId as string;
  check(true, `booted: one pane ${short(pane)} bound to session ${short(session)}`);

  // --- 2. the session exists in main's registry, and it is that one.
  check(host.list().length === 1, 'main holds exactly one live session');
  check(host.list()[0]?.id === session, 'the session the renderer names is the one main has');

  // --- 3. write, through the page's own bridge.
  const wrote = (await win.webContents.executeJavaScript(
    `window.shepherd.session.write(${JSON.stringify(session)}, ${JSON.stringify(`echo ${NEEDLE}\r`)})`,
  )) as { ok: boolean; error?: { code: string; message: string } };
  check(
    wrote.ok,
    `the page wrote 'echo ${NEEDLE}' over the bridge (${wrote.ok ? 'ok' : `${wrote.error?.code}: ${wrote.error?.message}`})`,
  );

  // --- 4. the bytes are in the ring.
  const ring = await until(
    `'${NEEDLE}' to appear twice in the replay ring`,
    () => Promise.resolve(ringText(host, session)),
    (text) => occurrences(text, NEEDLE) >= 2,
  );
  // Twice, not once: the first is the shell echoing what was typed, the second
  // is `echo` actually running. One occurrence would pass even if the pty were
  // a dumb loopback that never started a shell.
  check(
    occurrences(ring, NEEDLE) >= 2,
    `the ring carries '${NEEDLE}' ${occurrences(ring, NEEDLE)}× — the shell echoed it AND ran it`,
  );
  check(
    ring.length > 0 && host.snapshot(sessionId(session)) instanceof Uint8Array,
    'the ring is bytes, not a decoded string',
  );

  // --- 5. split, via the layout command (the real menu item).
  clickMenu(COMMANDS.splitRight);

  const split = await until('the layout to become a split', snapshot, (s) => s.paneIds.length === 2);
  check(split.outline?.kind === 'split', 'the root is a split');
  check(
    split.outline?.first?.kind === 'leaf' && split.outline?.second?.kind === 'leaf',
    'it has exactly two leaves',
  );
  check(split.paneIds.length === 2, `two panes: ${split.paneIds.map(short).join(', ')}`);

  await until(
    'a second live session',
    () => Promise.resolve(host.list().length),
    (n) => n === 2,
  );
  const live = host.list().map((s) => s.id as string);
  check(live.length === 2, `two live sessions: ${live.map(short).join(', ')}`);
  check(live.includes(session), 'the original session survived the split');
  const bound = split.panes.map((p) => p.sessionId).filter((id): id is string => id !== null);
  check(bound.length === 2 && bound.every((id) => live.includes(id)), 'each pane owns one of them');

  await captureIfAsked(win);

  // --- 6. quit. The pids go to the runner, which checks they really died.
  const pids = host.list().map((s) => s.pid);
  clearTimeout(deadline);
  say(`pids=${pids.join(',')}`);
  say('OK');
  // `quit`, not `exit`: `will-quit` is where the host is disposed, and "the app
  // leaves no stray shells behind" is part of what this gate asserts.
  app.quit();
}

function ringText(host: SessionHost, id: string): string {
  const bytes = host.snapshot(sessionId(id));
  return bytes === undefined ? '' : new TextDecoder().decode(bytes);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
