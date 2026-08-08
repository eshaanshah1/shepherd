import { request as httpRequest } from 'node:http';
import { app, type BrowserWindow } from 'electron';
import type { SessionHost } from '@shepherd/core';
import type { LayoutStore } from '@shepherd/core/layout';
import type { RootID } from '@shepherd/sdk';
import { check, die, say, snapshotOf, waiter } from './smoke-support.ts';
import type { M1SmokeOptions } from './smoke-m1.ts';

/**
 * The M2 smoke: a stub agent's hooks drive a real state indicator.
 *
 * This is the milestone's exit criterion, and it is a smoke rather than a unit
 * test for one reason — **every piece of this chain is already unit-tested, and
 * that proves nothing about whether the chain exists.** v1's LAN bug was every
 * unit correct with one silent no-op on an optional chain between them, and a
 * phone that completed its handshake was answered by nobody.
 *
 * The chain, five async hops, none of which a unit test spans:
 *
 *   curl → hooks.sock → EventBus → the extension host's port → claude-code's
 *   reducer → agents-core's registry → attention + `agents.stateChanged` → main's
 *   relay → the renderer's DOM.
 *
 * The agent is a stub — a POST shaped exactly like `report.sh`'s — because the
 * wire is what is under test, not Claude. Its payload carries a Claude
 * `session_id` so the real ownership lock is exercised on the real wire, and the
 * nested-session leg posts a DIFFERENT one, which is the only way to know that
 * guard is wired rather than merely written.
 */

export interface M2SmokeOptions extends M1SmokeOptions {
  readonly layout: LayoutStore;
  readonly root: RootID;
  /** Alerts the relay raised. Recorded rather than shown — see `index.ts`. */
  readonly alerts: () => readonly { readonly sessionId: string }[];
  readonly agentStates: () => readonly { readonly sessionId: string; readonly state: string }[];
}

const CLAUDE_SESSION = 'claude-smoke-1';

export async function runM2Smoke(
  win: BrowserWindow,
  host: SessionHost,
  options: M2SmokeOptions,
): Promise<void> {
  const { hookSocket, layout, agentStates, alerts, attentionCount } = options;
  const until = waiter(20_000);

  // Two panes, so "focused" and "unfocused" are real rather than simulated. The
  // presence handlers in `index.ts` are registered AFTER a smoke returns, so
  // `appActive` is frozen true here — which means front-ness is decided purely
  // by `layout.focused(root)`, and that is what these legs vary.
  //
  // TWO calls, because the home root now opens EMPTY (`index.ts` mints it
  // `{ empty: true }`, so "no tasks" is not drawn as a shell in a directory that
  // has just been deleted). The first `split` SEEDS the empty root with its
  // first pane — the store's own note says why that is one verb rather than two
  // — and the second one actually splits it.
  const seed = layout.split(options.root, 'row');
  if (!seed.ok) return die(`could not seed the empty home root: ${seed.error}`);
  const split = layout.split(options.root, 'row');
  if (!split.ok) return die(`could not split: ${split.error}`);

  await until('the window to show two panes', async () => (await snapshotOf(win)).paneIds.length, (n) => n === 2);

  const sessions = host.list();
  check(sessions.length === 2, `two sessions exist (saw ${sessions.length})`);

  const focusedPane = layout.focused(options.root);
  const focusedSession = sessions.find((s) => s.paneId === focusedPane);
  const otherSession = sessions.find((s) => s.paneId !== focusedPane);
  if (focusedSession === undefined || otherSession === undefined) {
    return die('could not resolve a focused and an unfocused session');
  }
  say(`focused=${focusedSession.id} unfocused=${otherSession.id}`);

  // --------------------------------------------------------- leg 1: adoption
  await post(hookSocket, otherSession.id, 'SessionStart', { session_id: CLAUDE_SESSION });
  await until('the unfocused pane to be adopted as an agent',
    () => Promise.resolve(stateOf(agentStates(), otherSession.id)), (state) => state === 'idle');
  check(true, 'a SessionStart over hooks.sock adopts the session');

  // --------------------------------------------------------- leg 2: working
  await post(hookSocket, otherSession.id, 'UserPromptSubmit', { session_id: CLAUDE_SESSION });
  await until('the pane to read working',
    () => Promise.resolve(stateOf(agentStates(), otherSession.id)), (state) => state === 'working');

  // The DOM, not just the relay's map. Asserting main's state would pass even if
  // the renderer never received a thing — the same reason the terminal smoke
  // reads xterm's buffer rather than the IPC listener's bytes.
  await until('the DOM to say working', () => labelFor(win, otherSession.paneId ?? ''), (label) => label === 'working');
  check(true, 'the indicator reaches the DOM');

  // ------------------------------------------- leg 3: the nested-claude guard
  const before = stateOf(agentStates(), otherSession.id);
  await post(hookSocket, otherSession.id, 'Stop', { session_id: 'a-nested-claude-p' });
  // Nothing to wait FOR, so give the chain the same budget a real change gets
  // and assert it did not move. A pass here with no delay would prove nothing.
  await settle();
  check(
    stateOf(agentStates(), otherSession.id) === before,
    `a nested claude's Stop does not finish the parent's turn (still ${before})`,
  );

  // ------------------------------------------ leg 4: an unwatched turn alerts
  const alertsBefore = alerts().length;
  await post(hookSocket, otherSession.id, 'Stop', { session_id: CLAUDE_SESSION });
  await until('an unwatched finished turn to land needsCheck',
    () => Promise.resolve(stateOf(agentStates(), otherSession.id)), (state) => state === 'needsCheck');
  await until('attention to count the finished turn',
    () => Promise.resolve(attentionCount()), (n) => n >= 1);
  check(app.getBadgeCount() >= 1, `the dock badge shows ${app.getBadgeCount()}`);
  check(alerts().length > alertsBefore, 'an unwatched finished turn raises a banner');

  // -------------------------------- leg 5: a WATCHED turn lands idle, silently
  // ADR 0020, and the reason this milestone has a smoke at all: the same event
  // on the pane the user is looking at must land `idle` and alert nobody.
  await post(hookSocket, focusedSession.id, 'SessionStart', { session_id: CLAUDE_SESSION });
  await post(hookSocket, focusedSession.id, 'UserPromptSubmit', { session_id: CLAUDE_SESSION });
  await until('the focused pane to work',
    () => Promise.resolve(stateOf(agentStates(), focusedSession.id)), (state) => state === 'working');

  const quietBefore = alerts().length;
  await post(hookSocket, focusedSession.id, 'Stop', { session_id: CLAUDE_SESSION });
  await until('a turn finishing under the user’s eyes to land idle, not needsCheck',
    () => Promise.resolve(stateOf(agentStates(), focusedSession.id)), (state) => state === 'idle');
  await settle();
  check(alerts().length === quietBefore, 'a watched turn raises NO banner');

  say('smoke: OK m2');
  // Explicit, like every other smoke: the app's own exit path would otherwise
  // decide the status, and a run that printed OK then exited non-zero reports a
  // failure nobody can locate. (Measured — this smoke did exactly that.)
  app.exit(0);
}

/**
 * Exactly the envelope `report.sh` builds, over exactly the transport it uses.
 *
 * `socketPath` rather than `fetch`: this has to be HTTP over the unix socket,
 * because that is what the plugin does. A second transport that happened to work
 * would say nothing about the first.
 */
function post(socket: string, sessionId: string, event: string, hook: unknown): Promise<void> {
  const body = JSON.stringify({ topic: 'claude.hook', session_id: sessionId, payload: { event, hook } });
  return new Promise((resolve) => {
    const request = httpRequest(
      {
        socketPath: socket,
        path: '/events',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (response) => {
        response.resume();
        if (response.statusCode !== 202) die(`hook POST for ${event} answered ${String(response.statusCode)}`);
        response.on('end', resolve);
      },
    );
    request.on('error', (error) => die(`hook POST for ${event} failed: ${error.message}`));
    request.end(body);
  });
}

function stateOf(
  states: readonly { readonly sessionId: string; readonly state: string }[],
  sessionId: string,
): string | undefined {
  return states.find((s) => s.sessionId === sessionId)?.state;
}

/** The rendered label, read out of the real DOM. */
async function labelFor(win: BrowserWindow, paneId: string): Promise<string> {
  return (await win.webContents.executeJavaScript(
    `(() => {
       const pane = document.querySelector('.sh-pane[data-pane-id=${JSON.stringify(paneId)}]');
       const badge = pane?.querySelector('[data-testid="agent-badge"]');
       return badge?.getAttribute('data-agent-state') ?? '';
     })()`,
  )) as string;
}

/** Long enough for the whole chain, for the legs that assert nothing happened. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 750));
}

/**
 * Whether the kernel handles include M2's.
 *
 * The registry passes one options bag to every smoke, so this is what keeps
 * "the m2 smoke was run without the handles it needs" a named failure rather
 * than a `TypeError` three frames in.
 */
export function isM2Options(options: Partial<M2SmokeOptions> & M1SmokeOptions): options is M2SmokeOptions {
  return (
    typeof options.agentStates === 'function' &&
    typeof options.alerts === 'function' &&
    options.layout !== undefined &&
    options.root !== undefined
  );
}
