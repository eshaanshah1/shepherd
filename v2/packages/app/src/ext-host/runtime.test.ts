import { beforeEach, describe, expect, it } from 'vitest';
import {
  manualClock,
  nodeId,
  s,
  toDisposable,
  type ActivateFn,
  type ExtensionContext,
  type ExtensionPoint,
  type ManualClock,
  type Shepherd,
} from '@shepherd/sdk';
import {
  EXT_PROTOCOL_VERSION,
  wireErr,
  wireOk,
  type ChildFrame,
  type HostFrame,
} from '../shared/ext-protocol.ts';
import { ExtensionUnreachableError, NotImplementedError, UndeclaredDependencyError } from './api.ts';
import { CHILD_CALL_TIMEOUT_MS, ExtHostRuntime } from './runtime.ts';

/**
 * The child's decisions, with the port replaced by two arrays.
 *
 * What it proves: nothing crosses before the handshake, one bad extension is one
 * bad extension, an extension's own schema still runs before its handler, every
 * refusal is a *named* refusal rather than a silent nothing, and — the M2 half —
 * that two extensions in this process share one point registry and reach each
 * other's APIs only through what their manifests declare.
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

/**
 * @param more further modules this process hosts, by id — what the
 * cross-extension tests need, and also what makes `not-hosted` testable: an id
 * absent from this map is one no module here can serve.
 */
function harness(activate?: ActivateFn, more?: Readonly<Record<string, ActivateFn>>): Harness {
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

  const modules = new Map<string, ActivateFn>([[ID, module]]);
  for (const [id, fn] of Object.entries(more ?? {})) modules.set(id, fn);

  const runtime = new ExtHostRuntime({
    send: (frame) => void sent.push(frame),
    clock,
    childPid: 9191,
    modules,
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
    settings: {},
    dataDir: '/tmp/shepherd-test/ext',
    homeDir: '/tmp/shepherd-test/home',
    userName: 'ada',
    ...overrides,
  } as never,
});

/** An activate ask for some other extension, with the dependencies it declared. */
const askFor = (extension: string, dependencies: readonly string[] = []): HostFrame =>
  activateAsk({
    extension,
    handle: `handle-${extension}`,
    manifest: {
      id: extension,
      name: extension,
      version: '1.0.0',
      api: '^1.0.0',
      activation: ['onStartup'],
      permissions: [],
      dependencies: [...dependencies],
    },
  });

const helloOk: HostFrame = { kind: 'hello-ok', id: 'c-1', protocol: EXT_PROTOCOL_VERSION, apiVersion: '1.0.0' };

const AGENTS = 'shepherd.agents-core';
const CLAUDE = 'shepherd.claude-code';
const KINDS = 'agents-core.kinds';

interface AgentKind {
  readonly id: string;
}

/** The failure message of the last answer, or '' — every cross-extension refusal lands here. */
const lastFailure = (h: Harness): string => {
  const result = h.answers().at(-1)?.result;
  return result?.ok === false ? result.error.message : '';
};

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

    it('hands over the home directory and the user name, neither of which the child can compute', async () => {
      await h.receive(activateAsk());
      expect(h.seen.ctx?.homeDir).toBe('/tmp/shepherd-test/home');
      // `userName` is here for a sharper reason than `homeDir`: a program an
      // extension runs gets the environment the extension BUILDS, because
      // `ProcessAPI.exec` replaces rather than merges — and a child handed only
      // `HOME` cannot reach the credentials a keychain lookup needs.
      expect(h.seen.ctx?.userName).toBe('ada');
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

  describe('api.proposed.settings', () => {
    /**
     * The seeded mirror, and the thing that makes it different from
     * `ctx.storage`: a setting has more than one writer, so the mirror is
     * corrected by the bus rather than trusted.
     */
    const seeded = async (settings: Record<string, unknown>) => {
      const h = harness();
      h.runtime.start();
      await h.receive(helloOk);
      await h.receive(activateAsk({ settings }));
      return h;
    };

    /** The subscription id the CHILD minted for the change topic. */
    const changeSubscription = (h: Harness): string => {
      const call = h
        .calls()
        .map((frame) => frame.call)
        .find((call) => call.kind === 'event.on' && call.topic === 'settings.changed');
      if (call === undefined || call.kind !== 'event.on') throw new Error('nothing subscribed to settings.changed');
      return call.subscription;
    };

    it('reads a seeded value synchronously', async () => {
      const h = await seeded({ 'one.model': 'sonnet' });
      expect(h.seen.api?.proposed.settings.get('one.model', s.string())).toBe('sonnet');
    });

    it('throws for a key it was never seeded, rather than answering undefined', async () => {
      const h = await seeded({});
      // `get` PROMISES a value — the declared default backs it. So a missing key
      // is never "the user has not chosen"; it is an undeclared key or another
      // extension's, and both are caller bugs that have to be loud.
      expect(() => h.seen.api?.proposed.settings.get('other.key', s.string())).toThrow(/other\.key/);
    });

    it('sets through the settings.set COMMAND, so the one authorizer sees it', async () => {
      const h = await seeded({ 'one.model': 'sonnet' });
      const pending = h.seen.api?.proposed.settings.set('one.model', 'opus');
      await settle();
      expect(h.calls().at(-1)?.call).toEqual({
        kind: 'command.invoke',
        commandId: 'settings.set',
        args: { key: 'one.model', value: 'opus' },
      });
      await h.answer(wireOk({ key: 'one.model', value: 'opus' }));
      expect(await pending).toEqual({ ok: true, value: undefined });
    });

    it('reports a denied write as denied, not as an invalid value', async () => {
      const h = await seeded({ 'one.model': 'sonnet' });
      const pending = h.seen.api?.proposed.settings.set('one.model', 'opus');
      await settle();
      await h.answer(wireErr('denied', 'lacks permission "settings"'));
      expect(await pending).toEqual({
        ok: false,
        error: { code: 'denied', message: 'lacks permission "settings"' },
      });
    });

    it('updates the mirror from the bus, because the SCREEN is a second writer', async () => {
      const h = await seeded({ 'one.model': 'sonnet' });
      const seenChanges: [string, unknown][] = [];
      h.seen.api?.proposed.settings.onDidChange((key, value) => seenChanges.push([key, value]));
      await h.receive({
        kind: 'event',
        subscription: changeSubscription(h),
        topic: 'settings.changed',
        payload: { key: 'one.model', value: 'opus' },
        seq: 1,
        ts: 0,
        source: { kind: 'user' },
      });
      expect(h.seen.api?.proposed.settings.get('one.model', s.string())).toBe('opus');
      expect(seenChanges).toEqual([['one.model', 'opus']]);
    });

    it('drops a change to a key it cannot see, rather than widening its own seed', async () => {
      const h = await seeded({ 'one.model': 'sonnet' });
      await h.receive({
        kind: 'event',
        subscription: changeSubscription(h),
        topic: 'settings.changed',
        payload: { key: 'other.secret', value: 'nope' },
        seq: 1,
        ts: 0,
        source: { kind: 'user' },
      });
      expect(() => h.seen.api?.proposed.settings.get('other.secret', s.string())).toThrow();
    });

    it('ignores a malformed change event rather than poisoning the mirror', async () => {
      const h = await seeded({ 'one.model': 'sonnet' });
      await h.receive({
        kind: 'event',
        subscription: changeSubscription(h),
        topic: 'settings.changed',
        payload: { nope: true },
        seq: 1,
        ts: 0,
        source: { kind: 'user' },
      });
      expect(h.seen.api?.proposed.settings.get('one.model', s.string())).toBe('sonnet');
      expect(h.calls().some((frame) => frame.call.kind === 'log')).toBe(true);
    });
  });

  describe('the refusals', () => {
    beforeEach(async () => {
      h.runtime.start();
      await h.receive(helloOk);
      await h.receive(activateAsk());
    });


    it('names every synchronous read it cannot serve across a port', () => {
      const proposed = h.seen.api?.proposed;
      for (const attempt of [
        () => proposed?.commands.list(),
        () => proposed?.attention.count(),
        () => proposed?.attention.get(nodeId('pane-1')),
        () => proposed?.layout.roots(),
        () => proposed?.layout.isViewing(nodeId('node-1')),
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

  /**
   * D4: the point registry runs HERE, shared, because a provider is a function
   * and a function cannot cross a port. These tests are the proof that the two
   * extensions reach the same object rather than one each.
   */
  describe('points — one registry for the whole process', () => {
    it('one extension defines a seam and another registers into it', async () => {
      let point: ExtensionPoint<AgentKind> | undefined;
      const two = harness(undefined, {
        [AGENTS]: (_ctx, api) => void (point = api.proposed.points.define<AgentKind>(KINDS)),
        [CLAUDE]: (_ctx, api) => void api.proposed.points.get<AgentKind>(KINDS)?.register({ id: 'claude-code' }),
      });
      two.runtime.start();
      await two.receive(helloOk);
      await two.receive(askFor(AGENTS));

      // The control: the seam is real and empty until the second extension runs,
      // so the assertion below cannot pass with the provider already there.
      expect(point?.all()).toEqual([]);

      await two.receive(askFor(CLAUDE, [AGENTS]));
      expect(two.answers().at(-1)?.result).toEqual({ ok: true });
      expect(point?.all()).toEqual([{ id: 'claude-code' }]);
    });

    it('refuses a second define of the same id and leaves the first owner intact', async () => {
      let point: ExtensionPoint<AgentKind> | undefined;
      const two = harness(undefined, {
        [AGENTS]: (_ctx, api) => {
          point = api.proposed.points.define<AgentKind>(KINDS);
          point.register({ id: 'built-in' });
        },
        [CLAUDE]: (_ctx, api) => void api.proposed.points.define<AgentKind>(KINDS),
      });
      two.runtime.start();
      await two.receive(helloOk);
      await two.receive(askFor(AGENTS));
      await two.receive(askFor(CLAUDE, [AGENTS]));

      expect(two.answers().at(-1)?.result).toMatchObject({ ok: false, error: { code: 'handler-failed' } });
      expect(lastFailure(two)).toContain(KINDS);
      // Naming the first owner is the whole value of the refusal: without it the
      // author of the second extension has a collision and no way to find the first.
      expect(lastFailure(two)).toContain(AGENTS);
      // The control: a silent second registry would satisfy every assertion above
      // and quietly orphan the providers already on the first point.
      expect(point?.all()).toEqual([{ id: 'built-in' }]);
    });

    it('refuses points.get for an owner the caller never declared', async () => {
      let thrown: unknown;
      const two = harness(undefined, {
        [AGENTS]: (_ctx, api) => void api.proposed.points.define<AgentKind>(KINDS),
        [CLAUDE]: (_ctx, api) => {
          try {
            api.proposed.points.get<AgentKind>(KINDS);
          } catch (error) {
            thrown = error;
          }
        },
      });
      two.runtime.start();
      await two.receive(helloOk);
      await two.receive(askFor(AGENTS));
      // Declared is the only key. The point exists, its owner is active, and it is
      // still unreachable — §7c: declared, not discovered.
      await two.receive(askFor(CLAUDE));

      expect(thrown).toBeInstanceOf(UndeclaredDependencyError);
      expect((thrown as UndeclaredDependencyError).requested).toBe(AGENTS);
      expect((thrown as Error).message).toContain('dependencies');
    });

    it('resolves its own point without declaring itself a dependency', async () => {
      let resolved: string | undefined;
      const two = harness(undefined, {
        [AGENTS]: (_ctx, api) => {
          api.proposed.points.define<AgentKind>(KINDS);
          resolved = api.proposed.points.get<AgentKind>(KINDS)?.id;
        },
      });
      two.runtime.start();
      await two.receive(helloOk);
      await two.receive(askFor(AGENTS));
      expect(resolved).toBe(KINDS);
    });

    it('answers undefined for a seam nobody defines, rather than refusing', async () => {
      // The one place `undefined` is the honest answer here: "no such seam" and
      // "its owner is gone" are the same fact, because disposing a point frees
      // its id and its owner together.
      let answer: unknown = 'untouched';
      const two = harness(undefined, {
        [CLAUDE]: (_ctx, api) => void (answer = api.proposed.points.get('nobody.defines.this')),
      });
      two.runtime.start();
      await two.receive(helloOk);
      await two.receive(askFor(CLAUDE));
      expect(two.answers().at(-1)?.result).toEqual({ ok: true });
      expect(answer).toBeUndefined();
    });

    it('frees an extension’s point ids when it is torn down', async () => {
      let runs = 0;
      const two = harness(undefined, {
        [AGENTS]: (_ctx, api) => {
          runs += 1;
          api.proposed.points.define<AgentKind>(KINDS);
        },
      });
      two.runtime.start();
      await two.receive(helloOk);
      await two.receive(askFor(AGENTS));
      await two.receive({ kind: 'ask', id: 'h-off', ask: { kind: 'deactivate', extension: AGENTS } });
      await two.receive(askFor(AGENTS));

      expect(runs).toBe(2);
      expect(two.answers().at(-1)?.result).toEqual({ ok: true });
    });

    it('frees the point id of an activate that defined one and then threw', async () => {
      // The rollback is only clean if the points go too: `activate` never reached
      // the line that would have put this in `ctx.subscriptions`, so the retry
      // would otherwise die on a duplicate-point error that blames the wrong thing.
      let attempt = 0;
      const two = harness(undefined, {
        [AGENTS]: (_ctx, api) => {
          attempt += 1;
          api.proposed.points.define<AgentKind>(KINDS);
          if (attempt === 1) throw new Error('half-built');
        },
      });
      two.runtime.start();
      await two.receive(helloOk);
      await two.receive(askFor(AGENTS));
      expect(two.answers().at(-1)?.result).toMatchObject({ ok: false, error: { code: 'handler-failed' } });

      await two.receive(askFor(AGENTS));
      expect(two.answers().at(-1)?.result).toEqual({ ok: true });
      expect(two.runtime.active).toEqual([AGENTS]);
    });
  });

  /**
   * D5: an extension may export an API, and the gate on reaching it is the
   * caller's declared `dependencies` — the judgement that used to have a second,
   * unused implementation in core's `ExtensionRegistry.apiFor`.
   */
  describe('extensions — the declared-dependency gate', () => {
    interface AgentsApi {
      readonly greet: () => string;
    }

    const exporting: ActivateFn = () => ({ greet: () => 'hello from agents-core' }) satisfies AgentsApi;

    it('resolves the API a declared dependency returned from activate', async () => {
      let reached: AgentsApi | undefined;
      const two = harness(undefined, {
        [AGENTS]: exporting,
        [CLAUDE]: (_ctx, api) => void (reached = api.proposed.extensions.get<AgentsApi>(AGENTS)),
      });
      two.runtime.start();
      await two.receive(helloOk);
      await two.receive(askFor(AGENTS));
      await two.receive(askFor(CLAUDE, [AGENTS]));

      expect(reached?.greet()).toBe('hello from agents-core');
    });

    it('refuses an id the caller did not declare, even when it is active', async () => {
      let thrown: unknown;
      const two = harness(undefined, {
        [AGENTS]: exporting,
        [CLAUDE]: (_ctx, api) => {
          try {
            api.proposed.extensions.get<AgentsApi>(AGENTS);
          } catch (error) {
            thrown = error;
          }
        },
      });
      two.runtime.start();
      await two.receive(helloOk);
      await two.receive(askFor(AGENTS));
      // Active, installed, exporting — and still unreachable, because reaching it
      // is a reviewable fact in the manifest rather than a string invented here.
      await two.receive(askFor(CLAUDE, ['shepherd.worktrees']));

      expect(thrown).toBeInstanceOf(UndeclaredDependencyError);
      expect((thrown as UndeclaredDependencyError).caller).toBe(CLAUDE);
    });

    it('answers undefined for a declared dependency hosted here and not active', async () => {
      // The single meaning `undefined` keeps. Every other miss below is a refusal
      // precisely so it cannot be confused with this one.
      let answer: unknown = 'untouched';
      const two = harness(undefined, {
        [AGENTS]: exporting,
        [CLAUDE]: (_ctx, api) => void (answer = api.proposed.extensions.get<AgentsApi>(AGENTS)),
      });
      two.runtime.start();
      await two.receive(helloOk);
      await two.receive(askFor(CLAUDE, [AGENTS]));

      expect(two.answers().at(-1)?.result).toEqual({ ok: true });
      expect(answer).toBeUndefined();
    });

    it('refuses an id no module here hosts, naming both ways that happens', async () => {
      let thrown: unknown;
      const two = harness(undefined, {
        [CLAUDE]: (_ctx, api) => {
          try {
            api.proposed.extensions.get('shepherd.remote-core');
          } catch (error) {
            thrown = error;
          }
        },
      });
      two.runtime.start();
      await two.receive(helloOk);
      await two.receive(askFor(CLAUDE, ['shepherd.remote-core']));

      expect(thrown).toBeInstanceOf(ExtensionUnreachableError);
      expect((thrown as ExtensionUnreachableError).reason).toBe('not-hosted');
      // Nothing runs in a second process today; the day it does, this must be a
      // message and not a mystery. The child cannot tell "absent" from "elsewhere",
      // so it says both rather than picking one confidently.
      expect((thrown as Error).message).toContain('another process');
      expect((thrown as Error).message).toContain('absent from this build');
    });

    it('refuses when a declared dependency activated and exported nothing', async () => {
      let thrown: unknown;
      const two = harness(undefined, {
        [AGENTS]: () => {},
        [CLAUDE]: (_ctx, api) => {
          try {
            api.proposed.extensions.get<AgentsApi>(AGENTS);
          } catch (error) {
            thrown = error;
          }
        },
      });
      two.runtime.start();
      await two.receive(helloOk);
      await two.receive(askFor(AGENTS));
      await two.receive(askFor(CLAUDE, [AGENTS]));

      // `undefined` here would read as "not active", and the caller's
      // `if (!api) return` would be a silent no-op with a live dependency.
      expect(thrown).toBeInstanceOf(ExtensionUnreachableError);
      expect((thrown as ExtensionUnreachableError).reason).toBe('no-export');
    });

    it('isActive answers from the same table', async () => {
      const seen: boolean[] = [];
      const build = (): Readonly<Record<string, ActivateFn>> => ({
        [AGENTS]: exporting,
        [CLAUDE]: (_ctx, api) => void seen.push(api.proposed.extensions.isActive(AGENTS)),
      });

      const cold = harness(undefined, build());
      cold.runtime.start();
      await cold.receive(helloOk);
      await cold.receive(askFor(CLAUDE, [AGENTS]));

      const warm = harness(undefined, build());
      warm.runtime.start();
      await warm.receive(helloOk);
      await warm.receive(askFor(AGENTS));
      await warm.receive(askFor(CLAUDE, [AGENTS]));

      expect(seen).toEqual([false, true]);
    });

    it('refuses isActive for an id the caller did not declare', async () => {
      // Otherwise `false` is the answer to two different questions, and the one it
      // is not the answer to is a manifest bug.
      let thrown: unknown;
      const two = harness(undefined, {
        [AGENTS]: exporting,
        [CLAUDE]: (_ctx, api) => {
          try {
            api.proposed.extensions.isActive(AGENTS);
          } catch (error) {
            thrown = error;
          }
        },
      });
      two.runtime.start();
      await two.receive(helloOk);
      await two.receive(askFor(AGENTS));
      await two.receive(askFor(CLAUDE));

      expect(thrown).toBeInstanceOf(UndeclaredDependencyError);
    });

    it('forgets an extension’s export when it is torn down', async () => {
      const seen: unknown[] = [];
      const two = harness(undefined, {
        [AGENTS]: exporting,
        [CLAUDE]: (_ctx, api) => void seen.push(api.proposed.extensions.get<AgentsApi>(AGENTS)),
      });
      two.runtime.start();
      await two.receive(helloOk);
      await two.receive(askFor(AGENTS));
      await two.receive(askFor(CLAUDE, [AGENTS]));
      expect(seen).toHaveLength(1);

      await two.receive({ kind: 'ask', id: 'h-off', ask: { kind: 'deactivate', extension: AGENTS } });
      await two.receive({ kind: 'ask', id: 'h-off2', ask: { kind: 'deactivate', extension: CLAUDE } });
      await two.receive(askFor(CLAUDE, [AGENTS]));

      // Back to the one honest `undefined`: hosted here, not active.
      expect(seen).toEqual([{ greet: expect.any(Function) }, undefined]);
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
        // Named by TOPIC, not "the first `event.on`": the API object subscribes
        // to `settings.changed` on its own behalf, so "the first one" is not this
        // extension's.
        .find(
          (call): call is { kind: 'event.on'; topic: string; subscription: string } =>
            call.kind === 'event.on' && call.topic === 'some.topic',
        );
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

    /**
     * D1. The flat 15s deadline is shorter than things M3 legitimately runs — a
     * cold `git fetch` above all — so a call may name its own. Two properties,
     * and the second is why the first is safe.
     */
    it('honours a longer deadline a call asks for, instead of failing work that is fine', async () => {
      let pending: Promise<unknown> | undefined;
      const waiting = harness((_ctx, api) => {
        pending = api.proposed.process.exec(['git', 'fetch'], { cwd: '/r', timeoutMs: 600_000 });
      });
      waiting.runtime.start();
      await waiting.receive(helloOk);
      await waiting.receive(activateAsk());

      // A settled FLAG, not `Promise.race` against a resolved sentinel: the
      // sentinel wins that race by one microtask whether or not the call timed
      // out, so the test passed with the deadline change reverted. Caught by
      // mutation-testing it, which is what mutation-testing is for.
      let settled = false;
      void pending?.then(() => {
        settled = true;
      });

      // Well past the flat default, and this call is still legitimately running.
      waiting.clock.advance(CHILD_CALL_TIMEOUT_MS * 4);
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);

      // And it does still time out — at its OWN deadline, not the flat one.
      waiting.clock.advance(600_000);
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(true);
    });

    it('honours a deadline a command invocation states, because the host forwards it again', async () => {
      // One extension asking another for slow work: `tasks` → `agents.complete`,
      // which is a model call. The invocation crosses this port, then crosses back
      // into the child that owns the command, so the outer leg has to outlast the
      // inner one — hence two slacks rather than one.
      let pending: Promise<unknown> | undefined;
      const waiting = harness((_ctx, api) => {
        pending = api.proposed.commands.invoke('agents.complete', { prompt: 'name this' }, { timeoutMs: 30_000 });
      });
      waiting.runtime.start();
      await waiting.receive(helloOk);
      await waiting.receive(activateAsk());

      let settled = false;
      void pending?.then(() => {
        settled = true;
      });

      waiting.clock.advance(CHILD_CALL_TIMEOUT_MS + 1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);

      waiting.clock.advance(30_000);
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(true);
    });

    it('still times out a call that names NO deadline at the flat default', async () => {
      // The property the constant protects, kept: a wedged host produces a
      // timeout rather than a promise nobody settles.
      let pending: Promise<unknown> | undefined;
      const waiting = harness((_ctx, api) => {
        pending = api.proposed.commands.invoke('never.answered');
      });
      waiting.runtime.start();
      await waiting.receive(helloOk);
      await waiting.receive(activateAsk());

      waiting.clock.advance(CHILD_CALL_TIMEOUT_MS + 1);
      expect(await pending).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    });

    /**
     * The half that makes the above safe. Main settles its outstanding calls on
     * disconnect (`ext-host.ts`'s `#failPending`); the child had no equivalent,
     * so its only escape was that timer — and with a ten-minute deadline in play
     * a dead main process would mean a ten-minute hang.
     */
    it('settles every pending call when the channel closes, without waiting for a deadline', async () => {
      let pending: Promise<unknown> | undefined;
      const waiting = harness((_ctx, api) => {
        pending = api.proposed.process.exec(['git', 'fetch'], { cwd: '/r', timeoutMs: 600_000 });
      });
      waiting.runtime.start();
      await waiting.receive(helloOk);
      await waiting.receive(activateAsk());

      waiting.runtime.channelClosed('the host closed the frame channel');

      // No clock advance at all — the answer comes from the disconnect.
      // It lands as an `ExecErr`, not a wire error: `ProcessAPI` returns
      // `ExecOk | ExecErr`, so a transport failure is a VALUE here. A caller
      // that had to catch as well as branch would do one of the two badly.
      // `code: -1` is the marker for "never ran".
      const result = await pending;
      expect(result).toMatchObject({ ok: false, code: -1, stdout: '' });
      expect(JSON.stringify(result)).toContain('closed');
    });

    it('is safe to report a closed channel twice', async () => {
      const waiting = harness(() => {});
      waiting.runtime.start();
      await waiting.receive(helloOk);
      waiting.runtime.channelClosed('once');
      expect(() => waiting.runtime.channelClosed('twice')).not.toThrow();
    });
  });
});

describe('secrets, once the keychain exists', () => {
  /**
   * The child asks by invoking a command and NEVER names an owner.
   *
   * That is the whole security model on this side: the owner is taken from the
   * caller on main's side, so there is no shape of request in which one
   * extension reads another's. A test that only checked the answer would pass
   * for an implementation that passed a namespace — this checks the ARGS.
   */
  let s2: Harness;

  beforeEach(async () => {
    s2 = harness();
    s2.runtime.start();
    await s2.receive(helloOk);
    await s2.receive(activateAsk());
  });

  const lastCall = (): unknown => s2.calls().at(-1)?.call;

  it('asks for a key and nothing else', async () => {
    const asked = s2.seen.ctx?.secrets.get('token');
    await settle();
    expect(lastCall()).toMatchObject({ kind: 'command.invoke', commandId: 'secrets.get', args: { key: 'token' } });
    // No owner, no namespace: the child cannot name one, so it cannot name
    // somebody else's.
    expect(JSON.stringify(lastCall())).not.toContain('extension');
    await s2.answer(wireOk({ key: 'token', value: 'gho_secret' }));
    await expect(asked).resolves.toBe('gho_secret');
  });

  it('reads an unset secret as undefined rather than as a failure', async () => {
    // "Not set", "never declared" and "cannot decrypt" are three causes with one
    // correct response, and a caller telling them apart would write three
    // branches that do the same thing.
    const asked = s2.seen.ctx?.secrets.get('token');
    await settle();
    await s2.answer(wireOk({ key: 'token', value: null }));
    await expect(asked).resolves.toBeUndefined();
  });

  it('THROWS for a denial, because that is a manifest bug no retry fixes', async () => {
    // Attached BEFORE the answer: a rejection with no handler yet is an
    // unhandled rejection, which vitest turns into a hang rather than a failure.
    const asked = expect(s2.seen.ctx?.secrets.get('token')).rejects.toThrow(/secrets/);
    await settle();
    await s2.answer(wireErr('denied', 'lacks permission "secrets"'));
    await asked;
  });

  it('throws when a write fails, rather than letting the caller believe it stored one', async () => {
    const written = expect(s2.seen.ctx?.secrets.set('token', 'gho_secret')).rejects.toThrow(/keychain/);
    await settle();
    expect(lastCall()).toMatchObject({
      kind: 'command.invoke',
      commandId: 'secrets.set',
      args: { key: 'token', value: 'gho_secret' },
    });
    await s2.answer(wireErr('handler-failed', 'the system keychain is not available'));
    await written;
  });
});
