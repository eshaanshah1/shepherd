import { describe, expect, it } from 'vitest';
import { createSystemAlerts, type NotificationHandle } from './system-alerts.ts';

/**
 * These exist because a real notification failure was INVISIBLE.
 *
 * Measured on 2026-08-07 against a real Claude session: the router decided
 * `banner=true chime=true badge=true` and macOS then refused delivery with
 * `UNErrorDomain error 1` (not authorized — `pnpm dev` runs the unsigned
 * `Electron.app` out of node_modules). Nothing in the log said so, so the only
 * way to tell "we never tried" from "the OS said no" was a standalone probe.
 * That is exactly the silent branch the logging rule exists to forbid.
 */

function fakeNotification(): {
  handle: NotificationHandle;
  fire: (event: string, arg?: Error | number) => void;
} {
  const handlers = new Map<string, (event: unknown, arg?: Error | number) => void>();
  return {
    handle: {
      on: (event, handler) => {
        handlers.set(event, handler as (event: unknown, arg?: Error | number) => void);
      },
      show: () => {},
    },
    fire: (event, arg) => handlers.get(event)?.({}, arg),
  };
}

function recorder(): { lines: string[]; log: Parameters<typeof createSystemAlerts>[0]['logger'] } {
  const lines: string[] = [];
  const child = {
    debug: (m: string) => lines.push(`debug ${m}`),
    info: (m: string) => lines.push(`info ${m}`),
    warn: (m: string) => lines.push(`warn ${m}`),
    error: (m: string) => lines.push(`error ${m}`),
  };
  return { lines, log: { child: () => child } as unknown as Parameters<typeof createSystemAlerts>[0]['logger'] };
}

const ALERT = { title: 'agent', body: 'needs you', sessionId: 's1' };

describe('createSystemAlerts', () => {
  it('says so when the platform supports no notifications at all', () => {
    const { lines, log } = recorder();
    const alerts = createSystemAlerts({
      logger: log,
      isSupported: () => false,
      create: () => fakeNotification().handle,
    });

    alerts.notify(ALERT);

    expect(lines.join('\n')).toMatch(/warn .*not supported/i);
  });

  it('reports the OS refusing a notification it accepted the request for', () => {
    const { lines, log } = recorder();
    const fake = fakeNotification();
    const alerts = createSystemAlerts({
      logger: log,
      isSupported: () => true,
      create: () => fake.handle,
    });

    alerts.notify(ALERT);
    // What macOS actually returns for an unauthorized bundle.
    fake.fire('failed', new Error('The operation couldn’t be completed. (UNErrorDomain error 1.)'));

    expect(lines.join('\n')).toMatch(/warn .*UNErrorDomain error 1/);
  });

  it('stays quiet at info level when delivery works', () => {
    const { lines, log } = recorder();
    const fake = fakeNotification();
    const alerts = createSystemAlerts({
      logger: log,
      isSupported: () => true,
      create: () => fake.handle,
    });

    alerts.notify(ALERT);

    expect(lines.filter((line) => !line.startsWith('debug'))).toEqual([]);
  });
});

/**
 * The half that was missing until 2026-08-30: a banner that names its task,
 * says something the state word cannot, and can be pressed.
 */
describe('a banner that carries a spec', () => {
  it('hands the subtitle and the action labels to the OS', () => {
    const { log } = recorder();
    let seen: Parameters<NonNullable<Parameters<typeof createSystemAlerts>[0]['create']>>[0] | undefined;
    const alerts = createSystemAlerts({
      logger: log,
      isSupported: () => true,
      dispatch: () => {},
      create: (options) => {
        seen = options;
        return fakeNotification().handle;
      },
    });

    alerts.notify({
      sessionId: 's1',
      title: 'Notification revamp',
      subtitle: 'Turn finished',
      body: '3 files \u00b7 +42 \u22127',
      actions: [{ label: 'Diff', goto: { task: 't1', face: 'diff' } }],
    });

    expect(seen?.title).toBe('Notification revamp');
    expect(seen?.subtitle).toBe('Turn finished');
    expect(seen?.actions).toEqual([{ type: 'button', text: 'Diff' }]);
  });

  it('dispatches the click and the buttons, and nothing for an index that is not there', () => {
    const { log } = recorder();
    const fake = fakeNotification();
    const dispatched: unknown[] = [];
    const alerts = createSystemAlerts({
      logger: log,
      isSupported: () => true,
      create: () => fake.handle,
      dispatch: (action) => dispatched.push(action),
    });

    alerts.notify({
      sessionId: 's1',
      title: 'Notification revamp',
      body: 'approve Bash',
      click: { task: 't1' },
      actions: [{ label: 'Later today', command: 'tasks.snooze', args: { task: 't1', until: 'today' } }],
    });

    fake.fire('click');
    fake.fire('action', 0);
    fake.fire('action', 9);

    expect(dispatched).toEqual([
      { goto: { task: 't1' } },
      { label: 'Later today', command: 'tasks.snooze', args: { task: 't1', until: 'today' } },
    ]);
  });

  it('draws no buttons at all when nothing can dispatch them', () => {
    const { log } = recorder();
    let seen: { actions?: readonly unknown[] } | undefined;
    const alerts = createSystemAlerts({
      logger: log,
      isSupported: () => true,
      create: (options) => {
        seen = options;
        return fakeNotification().handle;
      },
    });

    alerts.notify({
      sessionId: 's1',
      title: 'Notification revamp',
      body: 'approve Bash',
      actions: [{ label: 'Diff', goto: { task: 't1' } }],
    });

    expect(seen?.actions).toBeUndefined();
  });
});
