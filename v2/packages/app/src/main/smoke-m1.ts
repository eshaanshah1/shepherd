import { request } from 'node:http';
import { app, type BrowserWindow } from 'electron';
import type { EventBus, SessionHost } from '@shepherd/core';
import { LAYOUT_COMMANDS } from '@shepherd/core/layout';
import type { Envelope } from '@shepherd/sdk';
import { check, die, say, snapshotOf, waiter, waitForLoad } from './smoke-support.ts';

/**
 * The M1 smoke: the kernel, driven from OUTSIDE the process.
 *
 * Everything here could be asserted in a unit test except the one thing that
 * matters — that these paths exist in the real app, bound to real sockets, wired
 * to the real registry. v1's LAN bug is the cautionary tale: every unit was
 * correct and `onBridgedFD`'s `self?.remoteServer?.acceptBridged(…)` was a silent
 * no-op on an optional chain, so a phone completed its handshake and was answered
 * by nobody. Nothing but an end-to-end run finds that.
 *
 * Three legs, and note what the first one deliberately does NOT assert:
 *
 *   1. `hooks.sock` accepts an envelope and it reaches the bus **with its own
 *      sequence number**. It does NOT assert a badge — nothing maps ingress
 *      events to attention until `agents-core` (M2), so a "curl → badge" check
 *      would be a test of a wire that has not been run yet.
 *   2. `control.sock` invokes a real layout command and the WINDOW changes.
 *   3. attention aggregates to a count, through the same registry.
 */

export interface M1SmokeOptions {
  readonly bus: EventBus;
  readonly controlSocket: string;
  readonly hookSocket: string;
  readonly attentionCount: () => number;
}

export async function runM1Smoke(
  win: BrowserWindow,
  _host: SessionHost,
  options: M1SmokeOptions,
): Promise<void> {
  const { bus, controlSocket, hookSocket, attentionCount } = options;

  // ---------------------------------------------------------------- leg 1: hooks
  const seen: { payload: unknown; envelope: Envelope }[] = [];
  const subscription = bus.on('claude.hook', (payload, envelope) => {
    seen.push({ payload, envelope });
  });

  const ack = await post(hookSocket, '/events', {
    topic: 'claude.hook',
    session_id: 'smoke-session',
    seq: 7,
    // A payload with a newline and a quote in it: v1's hand-rolled bash JSON
    // escaper missed newlines, which made the event invalid JSON and therefore
    // silently dropped.
    payload: { event: 'Stop', detail: 'line one\nline "two"' },
  });
  check(ack.status === 202, `hooks.sock acked the envelope (got ${ack.status})`);
  check(seen.length === 1, `the envelope reached the bus (${seen.length} event(s))`);

  const envelope = seen[0]?.envelope;
  check(envelope?.seq === 7, `the client's own seq survived (got ${String(envelope?.seq)})`);
  check(
    envelope?.source.kind === 'agent',
    `the source is the agent session (got ${String(envelope?.source.kind)})`,
  );
  check(
    (seen[0]?.payload as { detail?: string } | undefined)?.detail === 'line one\nline "two"',
    'a payload with a newline and a quote arrived intact',
  );
  subscription.dispose();

  // A malformed envelope must be REFUSED, not accepted-and-ignored. This is the
  // negative control for the whole leg: without it, a 202 above proves only that
  // something answered.
  const bad = await post(hookSocket, '/events', { topic: 'claude.hook' });
  check(bad.status === 400, `a session-less envelope is refused (got ${bad.status})`);

  // -------------------------------------------------------------- leg 2: control
  // Leg 1 needed no window; this one does. Reading the layout before the page has
  // rendered answers zero panes, which reads as "the app opened empty" — a
  // misleading failure that says nothing about the socket under test.
  await waitForLoad(win);
  const until = waiter(5_000);
  const before = await until(
    'the window to render its first pane',
    () => snapshotOf(win),
    (snapshot) => snapshot.ready && snapshot.paneIds.length === 1,
  );
  check(before.paneIds.length === 1, `one pane to start (${before.paneIds.length})`);

  const split = await post(controlSocket, '/invoke', {
    command: LAYOUT_COMMANDS.split,
    args: { axis: 'row' },
    caller: { kind: 'device', deviceId: 'local-cli' },
  });
  check(split.status === 200, `control.sock invoked ${LAYOUT_COMMANDS.split} (got ${split.status})`);

  // The window has to actually change. A 200 from the socket only proves the
  // handler ran; this proves the layout it mutated is the one on screen.
  const after = await until(
    'the split to reach the window',
    () => snapshotOf(win),
    (snapshot) => snapshot.paneIds.length === 2,
  );
  check(after.paneIds.length === 2, 'the split reached the WINDOW — two panes');

  // An unknown command is a 404 carrying its reason, never a silent success.
  const missing = await post(controlSocket, '/invoke', {
    command: 'no.such.command',
    caller: { kind: 'device', deviceId: 'local-cli' },
  });
  check(missing.status === 404, `an unknown command is 404 (got ${missing.status})`);

  // A caller nobody has granted anything is denied — the authorizer running in
  // the dispatcher, over a real socket.
  const stranger = await post(controlSocket, '/invoke', {
    command: LAYOUT_COMMANDS.split,
    args: { axis: 'row' },
    caller: { kind: 'device', deviceId: 'not-paired' },
  });
  check(stranger.status === 403, `an unknown device is denied (got ${stranger.status})`);

  // …and it must not have taken effect anyway.
  const unchanged = await snapshotOf(win);
  check(unchanged.paneIds.length === 2, 'the denied command changed nothing');

  // ------------------------------------------------------------ leg 3: attention
  const pane = after.paneIds[0];
  if (pane === undefined) return die('no pane to set attention on');

  check(attentionCount() === 0, `nothing wants attention yet (${attentionCount()})`);
  const set = await post(controlSocket, '/invoke', {
    command: 'attention.set',
    args: { target: pane, level: 'attention', reason: 'the smoke says so' },
    caller: { kind: 'device', deviceId: 'local-cli' },
  });
  check(set.status === 200, `attention.set over the socket (got ${set.status})`);
  check(attentionCount() === 1, `it aggregated to the badge count (${attentionCount()})`);

  const cleared = await post(controlSocket, '/invoke', {
    command: 'attention.clear',
    args: { target: pane },
    caller: { kind: 'device', deviceId: 'local-cli' },
  });
  check(cleared.status === 200, `attention.clear over the socket (got ${cleared.status})`);
  check(attentionCount() === 0, `and the count went back down (${attentionCount()})`);

  say('the kernel answered on both sockets');
  // `say('OK')` and an explicit exit, as the other smokes do: the runner treats a
  // process that merely ends as a failure, because an Electron main can exit ZERO
  // for reasons nobody wrote down and a run that never reached the assertions
  // would otherwise report success.
  say('OK');
  app.exit(0);
}

/** One POST over a unix socket. `curl`'s job, without depending on `curl`. */
function post(socketPath: string, route: string, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        socketPath,
        path: route,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}
