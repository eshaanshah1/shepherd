// The control channel, and mostly the capability boundary.
//
// The interesting assertions are refusals. A device that may invoke anything in
// the registry is remote code execution with a pairing code in front of it; a
// device that may invoke only what it was SHOWN is bounded by the same thing
// that already decides what it sees.

import { describe, expect, it, vi } from 'vitest';
import { FrameDecoder, encodeJsonFrame, type Frame } from '@shepherd/core';
import { createLogger, systemClock } from '@shepherd/sdk';
import { CONTROL, ControlChannel } from './control.ts';

const log = createLogger({ clock: systemClock, level: 'error', sink: () => undefined }).child('session');

function channel(invoke: (device: string, command: string, args: unknown) => Promise<unknown>) {
  const seen: Array<{ device: string; command: string; args: unknown }> = [];
  const control = new ControlChannel({
    host: {
      invoke: async (device, command, args) => {
        seen.push({ device, command, args });
        return invoke(device, command, args);
      },
    },
    log,
  });
  control.open(1, 'phone-1');
  return { control, seen };
}

const ask = (seq: number, command: string, args?: unknown): Frame => ({
  kind: CONTROL.invoke as never,
  json: { seq, command, args },
});

function read(bytes: Uint8Array | undefined): { seq: number; ok: boolean; value?: unknown; error?: { code: string } } {
  if (bytes === undefined) throw new Error('no frame');
  const [frame] = new FrameDecoder().feed(bytes).frames;
  return frame?.json as never;
}

describe('the control channel', () => {
  it('carries an invoke and nothing else — no view vocabulary of its own', async () => {
    const { control, seen } = channel(async () => ({ views: ['tasks.tree'] }));
    const answer = read(await control.handle(1, ask(1, 'views.list')));

    expect(answer).toMatchObject({ seq: 1, ok: true, value: { views: ['tasks.tree'] } });
    // Attributed to the DEVICE by the host, not by the transport.
    expect(seen[0]).toEqual({ device: 'phone-1', command: 'views.list', args: undefined });
  });

  it('ignores frames that are not its business', async () => {
    const { control } = channel(async () => undefined);
    expect(await control.handle(1, { kind: 66 as never, json: {} })).toBeUndefined();
  });

  /**
   * THE boundary. A row's verbs are already declared by the extension that drew
   * the row, so "what this device may run" is exactly "what it was shown" — no
   * new permission vocabulary, and nothing to keep in sync.
   */
  it('refuses a command the device was never offered', async () => {
    const { control, seen } = channel(async () => undefined);
    const answer = read(await control.handle(1, ask(1, 'tasks.archive', { task: 't1' })));

    expect(answer.ok).toBe(false);
    expect(answer.error?.code).toBe('not-offered');
    // Never reached the registry at all, which is the point.
    expect(seen).toHaveLength(0);
  });

  it('offers exactly the commands a row it was sent declared', async () => {
    const rows = [
      {
        id: 't1',
        label: 'A task',
        command: { id: 'tasks.reveal', args: { task: 't1' } },
        actions: [{ id: 'tasks.archive', label: 'Archive' }],
      },
    ];
    const { control } = channel(async (_d, command) => (command === 'views.children' ? rows : { ok: true }));

    // Before: refused. After reading the rows: allowed.
    expect(read(await control.handle(1, ask(1, 'tasks.reveal'))).error?.code).toBe('not-offered');
    await control.handle(1, ask(2, 'views.children', { type: 'tasks.tree' }));

    expect(read(await control.handle(1, ask(3, 'tasks.reveal'))).ok).toBe(true);
    // A row's context menu is as much an offer as its click.
    expect(read(await control.handle(1, ask(4, 'tasks.archive'))).ok).toBe(true);
    // …and a sibling verb it was never shown still is not.
    expect(read(await control.handle(1, ask(5, 'tasks.delete'))).error?.code).toBe('not-offered');
  });

  it('does not let one device inherit another’s offers', async () => {
    const { control } = channel(async (_d, command) =>
      command === 'views.children' ? [{ id: 'r', label: 'r', command: { id: 'tasks.reveal' } }] : { ok: true },
    );
    control.open(2, 'phone-2');
    await control.handle(1, ask(1, 'views.children', { type: 'tasks.tree' }));

    // Connection 2 has been shown nothing.
    expect(read(await control.handle(2, ask(2, 'tasks.reveal'))).error?.code).toBe('not-offered');
  });

  it('reports a failing command as a value rather than throwing', async () => {
    const { control } = channel(async () => {
      throw new Error('no such task');
    });
    const answer = read(await control.handle(1, ask(1, 'views.list')));
    expect(answer.ok).toBe(false);
    expect(answer.error?.code).toBe('handler-failed');
  });

  it('forgets a device’s offers when its connection closes', async () => {
    const { control } = channel(async (_d, command) =>
      command === 'views.children' ? [{ id: 'r', label: 'r', command: { id: 'tasks.reveal' } }] : { ok: true },
    );
    await control.handle(1, ask(1, 'views.children', { type: 'tasks.tree' }));
    expect(read(await control.handle(1, ask(2, 'tasks.reveal'))).ok).toBe(true);

    control.close(1);
    // A reconnect starts from discovery again — offers are per-connection, so a
    // stale capability cannot outlive the rows that granted it.
    expect(await control.handle(1, ask(3, 'tasks.reveal'))).toBeUndefined();
  });

  /**
   * The answer is an extension's, has crossed a port, and `ok` says the call
   * succeeded rather than that the value has a shape. A cast would be the
   * "confident lie" the agent relay was corrected for.
   */
  it('survives an answer that is not shaped like rows at all', async () => {
    const { control } = channel(async () => ({ nested: [{ deep: { command: 42 } }, null, 'text'] }));
    await expect(control.handle(1, ask(1, 'views.children'))).resolves.toBeDefined();
  });
});
