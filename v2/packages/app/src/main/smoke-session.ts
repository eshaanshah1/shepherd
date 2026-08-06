import { app } from 'electron';
import { SessionHost } from '@shepherd/core';
import { systemClock, type SessionID } from '@shepherd/sdk';
import { EMIT, type SessionDataMessage, type SessionExitMessage } from '../shared/index.ts';
import { SessionBridge, type RendererTarget } from './session-bridge.ts';

/**
 * `pnpm smoke:session` — an Electron main-only entry that proves the things a
 * headless vitest run cannot:
 *
 *   1. node-pty's prebuild loads under Electron's ABI, not just node's.
 *   2. `SessionHost` + `SessionBridge` + `OutputCoalescer` all import and run
 *      inside the main process (an ESM/CJS or type-stripping problem shows up
 *      here and nowhere else).
 *   3. `app.setPath('userData', …)` happens BEFORE
 *      `app.requestSingleInstanceLock()`, and the lock really lands under the
 *      redirected path. Locked first, dev and prod share one lock and the dev
 *      build refuses to launch beside the daily one — the exact isolation the
 *      redirect exists to provide.
 *
 * No BrowserWindow: this runs on a machine with no display. The renderer is a
 * `RendererTarget` that collects what would have been sent over IPC.
 */

const TIMEOUT_MS = 15_000;
const NEEDLE = 'hello-from-pty';

function argValue(flag: string): string | undefined {
  const prefix = `${flag}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function say(line: string): void {
  process.stdout.write(`smoke: ${line}\n`);
}

function die(line: string): never {
  process.stdout.write(`smoke: FAIL ${line}\n`);
  app.exit(1);
  throw new Error(line); // unreachable; keeps the type `never`
}

// --- 1. userData BEFORE the lock. Order is the assertion.
const userData = argValue('--shepherd-user-data');
if (!userData) die('missing --shepherd-user-data=<dir>');
app.setPath('userData', userData);
if (app.getPath('userData') !== userData) die(`userData did not redirect: ${app.getPath('userData')}`);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) die('single-instance lock refused — a stray Electron holds this userData dir');
say(`userData=${app.getPath('userData')} lock=true`);

// --- 2. a session, through the same bridge the renderer talks to.
const collected: Uint8Array[] = [];
let exitMessage: SessionExitMessage | undefined;
let sendCount = 0;

const target: RendererTarget = {
  id: 1,
  isDestroyed: () => false,
  send: (channel, payload) => {
    sendCount += 1;
    if (channel === EMIT.sessionData) collected.push((payload as SessionDataMessage).bytes);
    if (channel === EMIT.sessionExit) exitMessage = payload as SessionExitMessage;
  },
};

const timeout = setTimeout(() => die(`no exit within ${TIMEOUT_MS}ms`), TIMEOUT_MS);

async function run(): Promise<void> {
  await app.whenReady();

  const host = new SessionHost({ onError: (e, ctx) => say(`host error in ${ctx}: ${String(e)}`) });
  const bridge = new SessionBridge(host, { clock: systemClock });

  const created = bridge.create({
    cwd: '/tmp',
    command: '/bin/sh',
    args: ['-c', `echo ${NEEDLE}`],
    env: { PATH: '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
  });
  if (!created.ok) die(`create: ${created.error.code} ${created.error.message}`);
  const id: SessionID = created.value.id;
  say(`created session ${id} pid=${created.value.pid}`);

  const attached = bridge.attach(target, id);
  if (!attached.ok) die(`attach: ${attached.error.code} ${attached.error.message}`);

  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (exitMessage) {
        clearInterval(poll);
        resolve();
      }
    }, 10);
  });

  clearTimeout(timeout);

  const text = new TextDecoder().decode(Buffer.concat(collected.map((c) => Buffer.from(c))));
  const exit = exitMessage as SessionExitMessage | undefined;
  say(`sends=${sendCount} exitCode=${exit?.exitCode} bytes=${JSON.stringify(text)}`);

  if (!text.includes(NEEDLE)) die(`output did not contain ${NEEDLE}`);
  if (exit?.exitCode !== 0) die(`exitCode was ${String(exit?.exitCode)}, expected 0`);
  if (host.list().length !== 0) die('a dead session is still in the registry');
  for (const chunk of collected) {
    if (!(chunk instanceof Uint8Array)) die('a payload was not a Uint8Array');
  }

  bridge.dispose();
  host.dispose();
  say('OK');
  app.exit(0);
}

void run().catch((error: unknown) => die(String(error)));
