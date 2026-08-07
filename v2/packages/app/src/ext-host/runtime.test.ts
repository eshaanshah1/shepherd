import { beforeEach, describe, expect, it } from 'vitest';
import { manualClock, nodeId, s, toDisposable, type ActivateFn, type ExtensionContext, type ManualClock, type Shepherd } from '@shepherd/sdk';
import {
  EXT_PROTOCOL_VERSION,
  wireErr,
  wireOk,
  type ChildFrame,
  type HostFrame,
} from '../shared/ext-protocol.ts';
import { NotImplementedError } from './api.ts';
import { CHILD_CALL_TIMEOUT_MS, ExtHostRuntime } from './runtime.ts';

/**
 * The child's decisions, with the port replaced by two arrays.
 *
 * What it proves: nothing crosses before the handshake, one bad extension is one
 * bad extension, an extension's own schema still runs before its handler, and
 * every M1 refusal is a *named* refusal rather than a silent nothing.
 */

const HANDLE = 'handle-for-one';
const ID = 'shepherd.one';

interface Harness {
  readonly runtime: ExtHostRuntime;
  readonly sent: ChildFrame[];
  readonly lines: string[];
  readonly clock: ManualClock;
  readonly seen: { ctx?: ExtensionContext; api?: Shepherd };
  receive(frame: HostFrame | unknown): Promise<void>;
  /** Answer the newest outstanding call, as the host would. */
  answer(result: ReturnType<typeof wireOk>): Promise<void>;
  calls(): Extract<ChildFrame, { kind: 'call' }>[];
  answers(): Extract<ChildFrame, { kind: 'answer' }>[];
}

function harness(activate?: ActivateFn): Harness {
  const sent: ChildFrame[] = [];
  const lines: string[] = [];
  const clock = manualClock(1_000);
  const seen: { ctx?: ExtensionContext; api?: Shepherd } = {};
  const module: ActivateFn =
    activate ??
    ((ctx, api) => {
      seen.ctx = ctx;
      seen.api = api;
    });

  const runtime = new ExtHostRuntime({
    send: (frame) => void sent.push(frame),
    clock,
    childPid: 9191,
    modules: new Map([[ID, module]]),
    log: (line) => void lines.push(line),
  });

  const calls = (): Extract<ChildFrame, { kind: 'call' }>[] =>
    sent.filter((frame): frame is Extract<ChildFrame, { kind: 'call' }> => frame.kind === 'call');

  return {
    runtime,
    sent,
    lines,
    clock,
    seen,
    receive: async (frame) => {
      runtime.receive(frame);
      await settle();
    },
    answer: async (result) => {
      const last = calls().at(-1);
      if (last === undefined) throw new Error('nothing has been called');
      runtime.receive({ kind: 'result', id: last.id, result });
      await settle();
    },
    calls,
    answers: () =>
      sent.filter((frame): frame is Extract<ChildFrame, { kind: 'answer' }> => frame.kind === 'answer'),
  };
}

const settle = async (turns = 8): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};

const activateAsk = (overrides: Record<string, unknown> = {}): HostFrame => ({
  kind: 'ask',
  id: 'h-activate',
  ask: {
    kind: 'activate',
    extension: ID,
    handle: HANDLE,
    manifest: {
      id: ID,
      name: 'One',
      version: '1.0.0',
      api: '^1.0.0',
      activation: ['onStartup'],
      permissions: ['storage'],
    },
    source: 'builtin',
    proposed: true,
    apiVersion: '1.0.0',
    permissions: ['storage'],
    storage: {},
    ...overrides,
  } as never,
});

const helloOk: HostFrame = { kind: 'hello-ok', id: 'c-1', protocol: EXT_PROTOCOL_VERSION, apiVersion: '1.0.0' };

let h: Harness;

describe('the extension host runtime', () => {
  beforeEach(() => {
    h = harness();
  });

  describe('the handshake', () => {
    it('announces its protocol and its pid', () => {
      h.runtime.start();
      expect(h.sent).toEqual([
        { kind: 'hello', id: 'ext-1', protocol: EXT_PROTOCOL_VERSION, childPid: 9191 },
      ]);
    });

    it('runs nothing before the host has accepted it', async () => {
      h.runtime.start();
      await h.receive(activateAsk());

      expect(h.answers().at(-1)?.result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
      expect(h.runtime.active).toEqual([]);
    });

    it('says on its own stderr when the host refuses it', async () => {
      h.runtime.start();
      await h.receive({ kind: 'hello-refused', id: 'c-1', reason: 'speaks protocol 99' });
      expect(h.runtime.state).toBe('refused');
      // Both halves have to be able to account for the refusal; the port is the one
      // channel it cannot use for that.
      expect(h.lines.some((line) => line.includes('refused by the main process'))).toBe(true);
    });
  });

  describe('activation', () => {
    beforeEach(async () => {
      h.runtime.start();
      await h.receive(helloOk);
    });

    it('runs the module and hands it a context and an api', async () => {
      await h.receive(activateAsk());
      expect(h.answers().at(-1)?.result).toEqual({ ok: true });
      expect(h.runtime.active).toEqual([ID]);
      expect(h.seen.ctx?.id).toBe(ID);
      expect(h.seen.ctx?.source).toBe('builtin');
      expect(h.seen.ctx?.permissions).toEqual(['storage']);
      expect(h.seen.api?.version).toBe('1.0.0');
    });

    it('drops a permission this build does not know rather than passing it on', async () => {
      await h.receive(activateAsk({ permissions: ['storage', 'omnipotence'] }));
      // `ctx.permissions` is typed `Permission[]`; a string that is not one would be
      // a claim wearing that type.
      expect(h.seen.ctx?.permissions).toEqual(['storage']);
    });

    it('reports a module it does not have, naming both facts', async () => {
      await h.receive(activateAsk({ extension: 'shepherd.absent' }));
      const result = h.answers().at(-1)?.result;
      expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
      if (result?.ok === false) expect(result.error.message).toContain('no built-in module for shepherd.absent');
    });

    it('catches a throw in activate and keeps the message', async () => {
      const boom = harness(() => {
        throw new Error('the extension is broken');
      });
      boom.runtime.start();
      await boom.receive(helloOk);
      await boom.receive(activateAsk());

      const result = boom.answers().at(-1)?.result;
      expect(result).toMatchObject({ ok: false, error: { code: 'handler-failed' } });
      if (result?.ok === false) expect(result.error.message).toContain('the extension is broken');
      // Rolled back, so a retry starts clean rather than double-registering.
      expect(boom.runtime.active).toEqual([]);
    });

    it('is idempotent, because a restart re-asks', async () => {
      let runs = 0;
      const counted = harness(() => void (runs += 1));
      counted.runtime.start();
      await counted.receive(helloOk);
      await counted.receive(activateAsk());
      await counted.receive(activateAsk());
      expect(runs).toBe(1);
    });

    it('disposes ctx.subscriptions on deactivate', async () => {
      let disposed = 0;
      const subscribing = harness((ctx) => {
        ctx.subscriptions.push(toDisposable(() => void (disposed += 1)));
      });
      subscribing.runtime.start();
      await subscribing.receive(helloOk);
      await subscribing.receive(activateAsk());
      expect(disposed).toBe(0);

      await subscribing.receive({ kind: 'ask', id: 'h-off', ask: { kind: 'deactivate', extension: ID } });
      expect(disposed).toBe(1);
      expect(subscribing.runtime.active).toEqual([]);
    });
  });

  describe('commands', () => {
    it('validates with the extension its own schema, before its handler', async () => {
      const handled: unknown[] = [];
      const registering = harness((ctx, api) => {
        ctx.subscriptions.push(
          api.proposed.commands.register('one.greet', {
            schema: s.object({ name: s.string() }),
            handler: (args) => {
              handled.push(args);
              return `hello ${args.name}`;
            },
          }),
        );
      });
      registering.runtime.start();
      await registering.receive(helloOk);
      await registering.receive(activateAsk());

      // The registration went to the host as a call, on this extension's handle.
      expect(registering.calls().some((call) => call.call.kind === 'command.register' && call.handle === HANDLE)).toBe(
        true,
      );

      await registering.receive({
        kind: 'ask',
        id: 'h-run',
        ask: { kind: 'command', extension: ID, commandId: 'one.greet', args: { name: 'world' }, caller: { kind: 'user' } },
      });
      expect(registering.answers().at(-1)?.result).toEqual({ ok: true, value: 'hello world' });

      // …and the schema refuses bad arguments as a typed `invalid-args`, with the
      // handler never reached. That is the registry's guarantee, executed here
      // because here is where the schema lives.
      await registering.receive({
        kind: 'ask',
        id: 'h-bad',
        ask: { kind: 'command', extension: ID, commandId: 'one.greet', args: { name: 7 }, caller: { kind: 'user' } },
      });
      expect(registering.answers().at(-1)?.result).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
      expect(handled).toEqual([{ name: 'world' }]);
    });

    it('answers unknown-command for a handler it does not have', async () => {
      h.runtime.start();
      await h.receive(helloOk);
      await h.receive(activateAsk());
      await h.receive({
        kind: 'ask',
        id: 'h-none',
        ask: { kind: 'command', extension: ID, commandId: 'one.nope', caller: { kind: 'user' } },
      });
      expect(h.answers().at(-1)?.result).toMatchObject({ ok: false, error: { code: 'unknown-command' } });
    });

    it('answers unavailable for an extension that is not active here', async () => {
      h.runtime.start();
      await h.receive(helloOk);
      await h.receive({
        kind: 'ask',
        id: 'h-cold',
        ask: { kind: 'command', extension: ID, commandId: 'one.greet', caller: { kind: 'user' } },
      });
      expect(h.answers().at(-1)?.result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    });

    it('maps a wire failure onto a CommandError an extension can branch on', async () => {
      let pending: Promise<unknown> | undefined;
      const invoking = harness((_ctx, api) => {
        // Deliberately not awaited into the activation result: the point is the
        // mapping, asserted below once the host answers.
        pending = api.proposed.commands.invoke('attention.set', {});
      });
      invoking.runtime.start();
      await invoking.receive(helloOk);
      await invoking.receive(activateAsk());
      await invoking.answer(wireErr('denied', 'lacks permission "attention"'));

      expect(await pending).toEqual({
        ok: false,
        error: { code: 'denied', message: 'lacks permission "attention"', commandId: 'attention.set' },
      });
    });
  });

  describe('ctx.storage', () => {
    it('reads the seeded namespace and writes through to the host', async () => {
      const storing = harness();
      storing.runtime.start();
      await storing.receive(helloOk);
      await storing.receive(activateAsk({ storage: { pings: 4, note: 'hi' } }));

      const storage = storing.seen.ctx?.storage;
      expect(storage?.get('pings', s.number())).toBe(4);
      // Sorted, matching the store's own `ORDER BY key` so the two cannot disagree.
      expect(storage?.keys()).toEqual(['note', 'pings']);

      storage?.set('pings', 5);
      expect(storage?.get('pings', s.number())).toBe(5);
      expect(storing.calls().at(-1)?.call).toEqual({ kind: 'storage.set', key: 'pings', value: 5 });

      storage?.delete('note');
      expect(storage?.keys()).toEqual(['pings']);
      expect(storing.calls().at(-1)?.call).toEqual({ kind: 'storage.delete', key: 'note' });
    });

    it('treats a value that no longer matches its schema as absent, and says so', async () => {
      const storing = harness();
      storing.runtime.start();
      await storing.receive(helloOk);
      await storing.receive(activateAsk({ storage: { pings: 'four' } }));

      // Never a throw: a blob written by an older build must not be able to stop
      // an extension from starting.
      expect(storing.seen.ctx?.storage.get('pings', s.number())).toBeUndefined();
      await settle();
      expect(storing.calls().some((call) => call.call.kind === 'log')).toBe(true);
    });
  });

  describe('the refusals', () => {
    beforeEach(async () => {
      h.runtime.start();
      await h.receive(helloOk);
      await h.receive(activateAsk());
    });

    it('rejects secrets with a named error rather than resolving undefined', async () => {
      await expect(h.seen.ctx?.secrets.get('token')).rejects.toThrow(NotImplementedError);
      await expect(h.seen.ctx?.secrets.get('token')).rejects.toThrow(/secrets\.get/);
    });

    it('names every synchronous read it cannot serve across a port', () => {
      const proposed = h.seen.api?.proposed;
      for (const attempt of [
        () => proposed?.commands.list(),
        () => proposed?.attention.count(),
        () => proposed?.attention.get(nodeId('pane-1')),
        () => proposed?.layout.roots(),
        () => proposed?.layout.isViewing(nodeId('node-1')),
        () => proposed?.extensions.isActive('shepherd.two'),
        () => proposed?.points.define('some.point'),
        () => proposed?.views.registerStatusItem({ id: 'a', text: 'b' }),
        () => proposed?.sessions.list(),
      ]) {
        expect(attempt).toThrow(NotImplementedError);
      }
    });

    it('points layout.open at the command that actually mutates the tree', async () => {
      await expect(
        h.seen.api?.proposed.layout.open({ kind: 'view', type: 'x' }, { kind: 'region', region: 'main' }),
      ).rejects.toThrow(/layout\.split/);
    });

    it('refuses every group when the host withheld proposed', async () => {
      const withheld = harness();
      withheld.runtime.start();
      await withheld.receive(helloOk);
      await withheld.receive(activateAsk({ proposed: false }));
      // A `user` extension in a production build is refused before this point; this
      // is the second line of defence, and it must not be a silent one.
      expect(() => withheld.seen.api?.proposed.commands.invoke('anything')).toThrow(NotImplementedError);
      expect(() => withheld.seen.api?.proposed.events.emit('t', 1)).toThrow(/dev build/);
    });
  });

  describe('the port', () => {
    beforeEach(async () => {
      h.runtime.start();
      await h.receive(helloOk);
    });

    it('skips an unreadable frame without losing the ones beside it', async () => {
      await h.receive([{ kind: 'not-a-frame-any-build-has-sent' }, activateAsk()]);
      expect(h.runtime.active).toEqual([ID]);
      expect(h.lines.some((line) => line.includes('skipped an unreadable frame'))).toBe(true);
    });

    it('logs an answer for an id nothing is waiting for', async () => {
      await h.receive({ kind: 'result', id: 'never-asked', result: wireOk() });
      expect(h.lines.some((line) => line.includes('nothing is waiting for'))).toBe(true);
    });

    it('logs an event for a subscription it does not hold', async () => {
      await h.receive({
        kind: 'event',
        subscription: 'sub-nobody',
        topic: 'some.topic',
        seq: 1,
        ts: 2,
        source: { kind: 'kernel' },
      });
      expect(h.lines.some((line) => line.includes('unknown subscription sub-nobody'))).toBe(true);
    });

    it('delivers a subscribed event with its whole envelope', async () => {
      const seen: { payload: unknown; seq: number; source: unknown }[] = [];
      const subscribing = harness((ctx, api) => {
        ctx.subscriptions.push(
          api.proposed.events.on('some.topic', (payload, envelope) =>
            seen.push({ payload, seq: envelope.seq, source: envelope.source }),
          ),
        );
      });
      subscribing.runtime.start();
      await subscribing.receive(helloOk);
      await subscribing.receive(activateAsk());

      const subscription = subscribing
        .calls()
        .map((call) => call.call)
        .find((call): call is { kind: 'event.on'; topic: string; subscription: string } => call.kind === 'event.on');
      expect(subscription).toBeDefined();

      await subscribing.receive({
        kind: 'event',
        subscription: subscription?.subscription ?? '',
        topic: 'some.topic',
        payload: { n: 1 },
        seq: 12,
        ts: 34,
        source: { kind: 'agent', sessionId: 'sess-1' },
      });
      expect(seen).toEqual([{ payload: { n: 1 }, seq: 12, source: { kind: 'agent', sessionId: 'sess-1' } }]);
    });

    it('times out a call the host never answers', async () => {
      let pending: Promise<unknown> | undefined;
      const waiting = harness((_ctx, api) => {
        pending = api.proposed.commands.invoke('never.answered');
      });
      waiting.runtime.start();
      await waiting.receive(helloOk);
      await waiting.receive(activateAsk());

      waiting.clock.advance(CHILD_CALL_TIMEOUT_MS + 1);
      // `timeout` has no `CommandErrorCode` of its own, so it lands as
      // `unavailable` — but the message must still say which of the two it was, or
      // a wedged host and a missing command read identically.
      const result = await pending;
      expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
      expect(JSON.stringify(result)).toContain(`no answer in ${CHILD_CALL_TIMEOUT_MS}ms`);
    });
  });
});
