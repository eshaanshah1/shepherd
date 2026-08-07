import { describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  extensionId,
  manualClock,
  s,
  type Caller,
  type LogRecord,
} from '@shepherd/sdk';
import { CommandRegistry, DuplicateCommandError } from './registry.ts';
import { emptyGrants, type GrantSet } from './authorize.ts';

const TASKS = extensionId('shepherd.tasks');
const USER: Caller = { kind: 'user' };

function build(grants: GrantSet = emptyGrants()) {
  const records: LogRecord[] = [];
  const logger = createLogger({
    clock: manualClock(0),
    level: 'debug',
    sink: (_line, record) => records.push(record),
  });
  const registry = new CommandRegistry({ logger, grants: () => grants });
  return { registry, records, messages: () => records.map((r) => r.message) };
}

describe('register / invoke', () => {
  it('runs the handler with parsed args and the caller', async () => {
    const { registry } = build();
    const seen: unknown[] = [];
    registry.register('pane.split', {
      schema: s.object({ axis: s.enumOf(['row', 'column'] as const) }),
      handler: (args, caller) => {
        seen.push([args, caller]);
        return 'node-2';
      },
    });

    const result = await registry.invoke('pane.split', { axis: 'row' }, USER);
    expect(result).toEqual({ ok: true, value: 'node-2' });
    expect(seen).toEqual([[{ axis: 'row' }, USER]]);
  });

  it('awaits an async handler', async () => {
    const { registry } = build();
    registry.register('slow', { schema: s.nothing(), handler: async () => 'done' });
    await expect(registry.invoke('slow', undefined, USER)).resolves.toEqual({ ok: true, value: 'done' });
  });

  it('disposing a registration unregisters it', async () => {
    const { registry } = build();
    const sub = registry.register('gone', { schema: s.nothing(), handler: () => 1 });
    expect(registry.has('gone')).toBe(true);
    sub.dispose();
    expect(registry.has('gone')).toBe(false);
    const result = await registry.invoke('gone', undefined, USER);
    expect(result.ok).toBe(false);
  });

  it('lists user-facing commands with their titles', () => {
    const { registry } = build();
    registry.register('a.titled', { schema: s.nothing(), title: 'Do A', handler: () => 0 });
    registry.register('b.internal', { schema: s.nothing(), handler: () => 0 });
    expect(registry.list()).toEqual([
      { id: 'a.titled', title: 'Do A' },
      { id: 'b.internal' },
    ]);
  });
});

describe('failures are values, and each one is logged', () => {
  it('an unknown command is a typed error, never a silent no-op', async () => {
    // The rule this registry exists for. v1 had routes that fell through to
    // nothing and reported success, which is indistinguishable from a feature
    // that has quietly stopped working.
    const { registry, messages } = build();
    const result = await registry.invoke('nope.missing', undefined, USER);
    expect(result).toEqual({
      ok: false,
      error: { code: 'unknown-command', message: 'no command "nope.missing"', commandId: 'nope.missing' },
    });
    expect(messages().some((m) => m.includes('nope.missing'))).toBe(true);
  });

  it('bad arguments carry the schema issues so a CLI can point at the field', async () => {
    const { registry } = build();
    registry.register('pane.resize', {
      schema: s.object({ cols: s.int(), rows: s.int() }),
      handler: () => 0,
    });

    const result = await registry.invoke('pane.resize', { cols: 'eighty', rows: 24 }, USER);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-args');
      expect(result.error.issues).toEqual([{ path: 'cols', message: 'expected integer, got string' }]);
      expect(result.error.message).toContain('cols');
    }
  });

  it('a denied caller never reaches the handler', async () => {
    const handler = vi.fn(() => 0);
    const { registry } = build(); // no grants at all
    registry.register('danger', { schema: s.nothing(), permission: 'process.exec', handler });

    const result = await registry.invoke('danger', undefined, { kind: 'extension', id: TASKS });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('denied');
    expect(handler).not.toHaveBeenCalled();
  });

  it('authorization is checked BEFORE the schema, so a denial never leaks shape', async () => {
    // A caller who may not invoke a command should not be able to probe its
    // argument shape by sending garbage and reading the validation error.
    const { registry } = build();
    registry.register('secret', {
      schema: s.object({ token: s.string() }),
      permission: 'secrets',
      handler: () => 0,
    });
    const result = await registry.invoke('secret', { wrong: 1 }, { kind: 'device', deviceId: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('denied');
  });

  it('a throwing handler becomes handler-failed, with the message kept', async () => {
    const { registry } = build();
    registry.register('boom', {
      schema: s.nothing(),
      handler: () => {
        throw new Error('git exited 128');
      },
    });
    const result = await registry.invoke('boom', undefined, USER);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('handler-failed');
      expect(result.error.message).toContain('git exited 128');
    }
  });

  it('a rejecting async handler is the same case', async () => {
    const { registry } = build();
    registry.register('boom.async', { schema: s.nothing(), handler: async () => Promise.reject(new Error('nope')) });
    const result = await registry.invoke('boom.async', undefined, USER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('handler-failed');
  });

  it('logs every invocation with its attributed caller', async () => {
    const { registry, messages } = build();
    registry.register('ok.cmd', { schema: s.nothing(), handler: () => 0 });
    await registry.invoke('ok.cmd', undefined, { kind: 'agent', sessionId: 's-1' as never });
    expect(messages().some((m) => m.includes('agent:s-1'))).toBe(true);
  });
});

describe('duplicate registration', () => {
  it('throws rather than overwriting the existing handler', () => {
    // The one thing here that throws instead of returning a value, on purpose:
    // this is an activation-time programming error, the extension host catches
    // it and marks the extension failed. Silently replacing a command is how it
    // stops doing what its author believes it does — with no error anywhere.
    const { registry } = build();
    registry.register('dupe', { schema: s.nothing(), handler: () => 1 });
    expect(() => registry.register('dupe', { schema: s.nothing(), handler: () => 2 })).toThrow(
      DuplicateCommandError,
    );
  });

  it('a disposed id may be registered again', () => {
    const { registry } = build();
    registry.register('cycle', { schema: s.nothing(), handler: () => 1 }).dispose();
    expect(() => registry.register('cycle', { schema: s.nothing(), handler: () => 2 })).not.toThrow();
  });
});

describe('grants are read at invoke time', () => {
  it('a permission granted after registration takes effect without re-registering', async () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ clock: manualClock(0), level: 'debug', sink: (_l, r) => records.push(r) });
    let grants: GrantSet = emptyGrants();
    const registry = new CommandRegistry({ logger, grants: () => grants });
    registry.register('needs', { schema: s.nothing(), permission: 'storage', handler: () => 'yes' });
    const caller: Caller = { kind: 'extension', id: TASKS };

    expect((await registry.invoke('needs', undefined, caller)).ok).toBe(false);
    grants = { ...emptyGrants(), extensions: new Map([[TASKS, ['storage'] as const]]) };
    expect(await registry.invoke('needs', undefined, caller)).toEqual({ ok: true, value: 'yes' });
  });
});
