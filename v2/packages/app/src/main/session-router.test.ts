// Sessions from more than one machine behind one `SessionHostLike`.
//
// The member's half here is a REAL `SessionServer` over a REAL `SessionHost`, wired
// to the router by a pair of in-memory sockets — so what is exercised is the actual
// protocol conversation, minus TLS (which `@shepherd/remote`'s own tests cover
// against a real certificate). A stubbed client would prove nothing about attach
// semantics, which is where every remote-terminal bug in v1 lived.

import { afterEach, describe, expect, it } from 'vitest';
import { SessionHost, SessionServer } from '@shepherd/core';
import type { SessionExit, SessionInfo } from '@shepherd/core';
import { createLogger, sessionId, systemClock, type SessionID } from '@shepherd/sdk';
import { SessionRouter } from './session-router.ts';
import type { ClientSocket } from './session-client.ts';

const logger = createLogger({ clock: systemClock, level: 'error', sink: () => undefined });
const nullLogger = logger.child('session');

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Mac B: its own pty host, its own session server, reachable over a pipe. */
function memberSide() {
  const host = new SessionHost();
  const server = new SessionServer({ host, log: logger });
  let deliver: ((bytes: Uint8Array) => void) | undefined;
  let closed: (() => void) | undefined;
  const id = server.accept({
    write: (bytes) => deliver?.(bytes),
    close: () => closed?.(),
  });
  const socket: ClientSocket = {
    write: (bytes) => server.feed(id, bytes),
    destroy: () => server.disconnect(id),
    onData: (fn) => {
      deliver = fn;
    },
    onClose: (fn) => {
      closed = fn;
    },
    onError: () => undefined,
  };
  cleanups.push(() => {
    server.dispose();
    host.dispose();
  });
  return { host, server, socket };
}

function router(connect: (memberId: string) => Promise<ClientSocket>) {
  const local = new SessionHost();
  const routed = new SessionRouter({ local, connect, log: nullLogger, retryMs: 10 });
  cleanups.push(() => routed.dispose());
  return { local, routed };
}

async function until(predicate: () => boolean, label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A shell over there, as a member's own pane would have started it. */
function shellOn(host: SessionHost): SessionInfo {
  const created = host.create({ cwd: '/tmp', command: '/bin/sh', args: [] });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe('a member’s sessions, qualified', () => {
  it('lists and streams another member’s pty through the same API as a local one', async () => {
    const b = memberSide();
    const remote = shellOn(b.host);
    const { routed } = router(async () => b.socket);

    const reached = await routed.reach('mac-b');
    expect(reached.ok && reached.value.map((info) => info.id)).toContain(`mac-b∷${remote.id}`);

    const seen: string[] = [];
    const attached = routed.attach(sessionId(`mac-b∷${remote.id}`), (bytes) => {
      seen.push(new TextDecoder().decode(bytes));
    });
    expect(attached.ok).toBe(true);

    routed.write(sessionId(`mac-b∷${remote.id}`), 'echo from-mac-b\n');
    await until(() => seen.join('').includes('from-mac-b'), 'the member’s output');
  });

  it('attaches to a session bound before the member was ever dialled', async () => {
    // The restore path: a pane is bound from disk, so the attach arrives before
    // anything has been reached. It must wait for the inventory, not refuse.
    const b = memberSide();
    const remote = shellOn(b.host);
    const { routed } = router(async () => b.socket);

    const seen: string[] = [];
    const attached = routed.attach(sessionId(`mac-b∷${remote.id}`), (bytes) => {
      seen.push(new TextDecoder().decode(bytes));
    });
    expect(attached.ok).toBe(true);

    await until(() => routed.has(sessionId(`mac-b∷${remote.id}`)), 'the inventory');
    routed.write(sessionId(`mac-b∷${remote.id}`), 'echo late-attach\n');
    await until(() => seen.join('').includes('late-attach'), 'the member’s output');
  });

  it('announces an exit for a remote session that turns out not to exist', async () => {
    // Nothing polls for a session's absence — a pane learns it from `onExit` and
    // nowhere else — so a binding that cannot be satisfied must say so there.
    const b = memberSide();
    const { routed } = router(async () => b.socket);
    const exits: SessionExit[] = [];
    routed.onExit((exit) => void exits.push(exit));

    const ghost = sessionId('mac-b∷never-existed');
    routed.attach(ghost, () => undefined);
    await until(() => exits.length > 0, 'the announced absence');
    expect(exits[0]?.sessionId).toBe(ghost);
  });

  it('re-emits a member’s exit with the qualified id the pane knows', async () => {
    const b = memberSide();
    const remote = shellOn(b.host);
    const { routed } = router(async () => b.socket);
    await routed.reach('mac-b');

    const exits: SessionExit[] = [];
    routed.onExit((exit) => void exits.push(exit));
    routed.attach(sessionId(`mac-b∷${remote.id}`), () => undefined);
    // Ended over there, by its owner — which is the only place it can be ended.
    b.host.kill(remote.id);

    await until(() => exits.length > 0, 'the exit');
    expect(exits[0]?.sessionId).toBe(`mac-b∷${remote.id}`);
  });

  it('routes a viewport to the member, where it is arbitrated with its own viewers', async () => {
    const b = memberSide();
    const remote = shellOn(b.host);
    const { routed } = router(async () => b.socket);
    await routed.reach('mac-b');

    // B's own pane is watching at 100x40; this Mac can only show 60x20.
    b.host.setViewport(remote.id, 'mac-b-pane', { cols: 100, rows: 40 });
    routed.setViewport(sessionId(`mac-b∷${remote.id}`), 'mac-a-pane', { cols: 60, rows: 20 });

    await until(() => b.host.get(remote.id)?.cols === 60, 'the arbitrated size');
    // Smallest of each dimension: the big screen letterboxes, the small one does
    // not clip. Withdrawing hands the pty back to the viewer that remains.
    expect(b.host.get(remote.id)?.rows).toBe(20);
    routed.setViewport(sessionId(`mac-b∷${remote.id}`), 'mac-a-pane', undefined);
    await until(() => b.host.get(remote.id)?.cols === 100, 'the size after withdrawal');
  });
});

describe('closing a viewer of a member’s session', () => {
  it('does NOT kill it — the pty belongs to the member', async () => {
    const b = memberSide();
    const remote = shellOn(b.host);
    const { routed } = router(async () => b.socket);
    await routed.reach('mac-b');

    const killed = routed.kill(sessionId(`mac-b∷${remote.id}`));
    expect(killed.ok).toBe(true);

    // Give a forwarded kill every chance to land before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(b.host.list().map((info) => info.id)).toContain(remote.id);
  });

  /**
   * The negative control, kept pointing the other way round.
   *
   * Without it the assertion above passes just as happily against a router that
   * kills nothing at all — including this Mac's own sessions, which `layout.close`
   * genuinely must end (ADR 0022).
   */
  it('still kills a LOCAL session, which is what layout.close is for', async () => {
    const b = memberSide();
    const { local, routed } = router(async () => b.socket);
    const mine = shellOn(local);

    expect(routed.kill(mine.id).ok).toBe(true);
    await until(() => !local.has(mine.id), 'the local session to end');
  });
});

describe('an unreachable member', () => {
  it('answers "I could not look" for foreground, never "nothing is there"', async () => {
    // `false` is the reconciliation sweep's demote signal, so a member that is
    // merely asleep must not be reported as a session with no process.
    const { routed } = router(() => Promise.reject(new Error('asleep')));
    const reading = await routed.foreground(sessionId('mac-b∷anything'));
    expect(reading.hasForegroundProcess).toBeUndefined();
  });

  it('tells the pane what it is waiting for, in the pane', async () => {
    // The pane is a screen for bytes, so that is where "I cannot reach this
    // machine yet" belongs — and R0's snapshot repaints over it when the member
    // answers, so there is nothing to clear.
    const { routed } = router(() => Promise.reject(new Error('asleep')));
    const seen: string[] = [];
    routed.attach(sessionId('mac-b∷anything'), (bytes) => {
      seen.push(new TextDecoder().decode(bytes));
    });
    await until(() => seen.join('').includes('waiting for mac-b'), 'the notice');
  });

  it('reports rather than throws when a write cannot be routed', async () => {
    const { routed } = router(() => Promise.reject(new Error('asleep')));
    const written = routed.write(sessionId('mac-c∷anything'), 'x');
    expect(written.ok).toBe(false);
  });
});

/** A local id must reach the local host untouched — the ordinary case, unchanged. */
describe('this Mac’s own sessions', () => {
  it('are routed locally and are unaffected by the qualification', async () => {
    const b = memberSide();
    const { local, routed } = router(async () => b.socket);
    const mine = shellOn(local);

    const seen: string[] = [];
    const attached = routed.attach(mine.id, (bytes) => {
      seen.push(new TextDecoder().decode(bytes));
    });
    expect(attached.ok).toBe(true);
    routed.write(mine.id, 'echo local-still-works\n');
    await until(() => seen.join('').includes('local-still-works'), 'local output');

    const ids: SessionID[] = routed.list().map((info) => info.id);
    expect(ids).toContain(mine.id);
  });
});
