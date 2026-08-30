import { USER } from '@shepherd/sdk';
import { describe, expect, it } from 'vitest';
import { alertDispatcher } from './alert-dispatch.ts';

type FakeRegistry = Parameters<typeof alertDispatcher>[0]['registry'];

describe('alertDispatcher', () => {
  it('raises the window and pushes the destination for a goto', () => {
    const seen: unknown[] = [];
    const dispatch = alertDispatcher({
      registry: { invoke: async () => ({ ok: true, value: null }) } as unknown as FakeRegistry,
      raise: () => seen.push('raised'),
      navigate: (message) => seen.push(message),
      onFailure: () => seen.push('failed'),
    });

    dispatch({ goto: { task: 't1', face: 'diff' } });

    expect(seen).toEqual(['raised', { task: 't1', face: 'diff' }]);
  });

  it('runs a verb as the user, and does not move the window for it', async () => {
    const seen: unknown[] = [];
    const dispatch = alertDispatcher({
      registry: {
        invoke: async (id: string, args: unknown, who: unknown) => {
          seen.push([id, args, who]);
          return { ok: true, value: null };
        },
      } as unknown as FakeRegistry,
      raise: () => seen.push('raised'),
      navigate: () => seen.push('navigated'),
      onFailure: () => seen.push('failed'),
    });

    dispatch({ label: 'Later today', command: 'tasks.snooze', args: { task: 't1', until: 'today' } });
    await Promise.resolve();

    expect(seen).toEqual([['tasks.snooze', { task: 't1', until: 'today' }, USER]]);
  });

  it('passes an empty object for a verb that takes no arguments', async () => {
    const seen: unknown[] = [];
    const dispatch = alertDispatcher({
      registry: {
        invoke: async (id: string, args: unknown) => {
          seen.push([id, args]);
          return { ok: true, value: null };
        },
      } as unknown as FakeRegistry,
      raise: () => {},
      navigate: () => {},
      onFailure: () => {},
    });

    dispatch({ label: 'Do it', command: 'a.verb' });
    await Promise.resolve();

    expect(seen).toEqual([['a.verb', {}]]);
  });

  it('reports a verb that failed rather than dropping it', async () => {
    const failures: string[] = [];
    const dispatch = alertDispatcher({
      registry: {
        invoke: async () => ({ ok: false, error: { code: 'no-such-command', message: 'no tasks.snooze' } }),
      } as unknown as FakeRegistry,
      raise: () => {},
      navigate: () => {},
      onFailure: (command, message) => failures.push(`${command}: ${message}`),
    });

    dispatch({ label: 'Later today', command: 'tasks.snooze' });
    await Promise.resolve();
    await Promise.resolve();

    expect(failures).toEqual(['tasks.snooze: no tasks.snooze']);
  });
});
