import { beforeEach, describe, expect, it } from 'vitest';
import {
  CommandRegistry,
  EventBus,
  ExtensionRegistry,
  PermissionStore,
  SqliteStore,
} from '@shepherd/core';
import {
  createLogger,
  extensionId,
  manualClock,
  s,
  type Caller,
  type Logger,
  type Manifest,
  type ManualClock,
  PERMISSIONS,
} from '@shepherd/sdk';
import {
  EXT_PROTOCOL_VERSION,
  childFrameSchema,
  hostFrameSchema,
  readFrames,
  wireErr,
  wireOk,
  type ChildFrame,
  type HostAsk,
  type HostFrame,
} from '../shared/ext-protocol.ts';
import { ASK_TIMEOUT_MS, EXTENSIONS_LIST_COMMAND, ExtensionHost, MAX_HOST_RESTARTS, storageNamespace } from './ext-host.ts';

/**
 * The host's decisions, driven against the REAL kernel (a real
 * `CommandRegistry`, `EventBus`, `PermissionStore` and `SqliteStore`) and a fake
 * child.
 *
 * The fake is the point: what a unit test can prove here is the logic — caller
 * derivation, the proposed gate, one bounded restart, a deadline that fires — and
 * what it cannot prove is that a `utilityProcess` exists at all. That second half
 * belongs to `smoke:m1`, which invokes `diagnostics.ping` over the control socket
 * and asserts the answer came from another pid. v1's `acceptBridged` bug is the
 * reason both halves are written: every unit was correct there too.
 */

/** A child that records what it was asked and answers when the test says so. */
class FakeChild {
  readonly sent: HostFrame[] = [];
  #onFrame: (raw: unknown) => void = () => {};
  #onExit: (code: number) => void = () => {};
  killed = false;

  post(frame: HostFrame): void {
    // Round-tripped through the schema, so a frame the real child could not read
    // fails here rather than in a smoke.
    const read = readFrames(frame, hostFrameSchema);
    if (read.frames.length !== 1) throw new Error(`unreadable host frame: ${read.skipped.join('; ')}`);
    this.sent.push(frame);
  }

  onFrame(fn: (raw: unknown) => void): void {
    this.#onFrame = fn;
  }

  onExit(fn: (code: number) => void): void {
    this.#onExit = fn;
  }

  kill(): void {
    this.killed = true;
  }

  /** Pretend the child sent this. Validated the same way, in the same direction. */
  send(frame: ChildFrame): void {
    const read = readFrames(frame, childFrameSchema);
    if (read.frames.length !== 1) throw new Error(`unreadable child frame: ${read.skipped.join('; ')}`);
    this.#onFrame(frame);
  }

  /** Anything at all, including things no build has ever sent. */
  sendRaw(raw: unknown): void {
    this.#onFrame(raw);
  }

  die(code: number): void {
    this.#onExit(code);
  }

  hello(pid = 4242, protocol = EXT_PROTOCOL_VERSION): void {
    this.send({ kind: 'hello', id: 'c-hello', protocol, childPid: pid });
  }

  /** The pending `ask` of this kind, newest first. */
  asks(kind: HostAsk['kind']): { id: string; ask: HostAsk }[] {
    return this.sent
      .filter((frame): frame is Extract<HostFrame, { kind: 'ask' }> => frame.kind === 'ask')
      .filter((frame) => frame.ask.kind === kind)
      .map((frame) => ({ id: frame.id, ask: frame.ask }));
  }

  answer(id: string, ok = true, error = 'nope'): void {
    this.send({ kind: 'answer', id, result: ok ? wireOk() : wireErr('handler-failed', error) });
  }
}

const manifestFor = (id: string, permissions: Manifest['permissions'] = ['storage']): Manifest => ({
  id,
  name: id,
  version: '1.0.0',
  api: '^1.0.0',
  activation: ['onStartup'],
  permissions,
});

interface Harness {
  readonly host: ExtensionHost;
  readonly extensions: ExtensionRegistry;
  readonly registry: CommandRegistry;
  readonly bus: EventBus;
  readonly permissions: PermissionStore;
  readonly store: SqliteStore;
  readonly clock: ManualClock;
  readonly logger: Logger;
  readonly lines: string[];
  /** Every child this host has forked, in order. */
  readonly children: FakeChild[];
  readonly child: () => FakeChild;
}

function harness(options: { isDev?: boolean; spawnThrows?: boolean } = {}): Harness {
  const lines: string[] = [];
  const clock = manualClock(1_000);
  const logger = createLogger({ clock, level: 'debug', sink: (line) => void lines.push(line) });
  const store = new SqliteStore({ location: ':memory:', logger });
  const permissions = new PermissionStore(store.namespace('permissions'), logger);
  const bus = new EventBus({ clock, logger });
  const registry = new CommandRegistry({
    logger,
    // Mirrors `main/index.ts`: extension grants MERGED with the local CLI device,
    // never substituted for it. Getting that merge wrong is how every existing
    // leg of `smoke:m1` starts answering 403.
    grants: () => ({ ...permissions.grantSet(), devices: new Map([['local-cli', PERMISSIONS]]) }),
  });
  const children: FakeChild[] = [];

  let extensions: ExtensionRegistry;
  const host = new ExtensionHost({
    registry,
    extensions: () => extensions,
    permissions,
    bus,
    support: '/tmp/shepherd-test-support',
    homeDir: '/tmp/shepherd-test-home',
    kv: (namespace) => store.namespace(namespace),
    logger,
    clock,
    isDev: options.isDev ?? true,
    // Readable handles, so a failure message names the extension rather than a UUID.
    mintHandle: () => `handle-${children.length}-${Math.random().toString(36).slice(2, 8)}`,
    spawn: () => {
      if (options.spawnThrows === true) throw new Error('no helper binary');
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });
  extensions = new ExtensionRegistry({ permissions, activator: host.activator, logger });

  return {
    host,
    extensions,
    registry,
    bus,
    permissions,
    store,
    clock,
    logger,
    lines,
    children,
    child: () => {
      const last = children.at(-1);
      if (last === undefined) throw new Error('nothing has been forked yet');
      return last;
    },
  };
}

/**
 * Activation, end to end against the fake: kick it off, let the child say hello,
 * answer the `activate` ask, and hand back the registry's verdict.
 */
async function activate(h: Harness, manifest: Manifest, answer: 'ok' | 'throw' | 'silent' = 'ok') {
  const running = h.extensions.activate(extensionId(manifest.id));
  await settle();
  h.child().hello();
  await settle();
  const ask = h.child().asks('activate').at(-1);
  if (ask === undefined) throw new Error('the host never asked the child to activate anything');
  if (answer === 'ok') h.child().answer(ask.id, true);
  if (answer === 'throw') h.child().answer(ask.id, false, `${manifest.id} threw while activating: boom`);
  if (answer === 'silent') h.clock.advance(ASK_TIMEOUT_MS + 1);
  return { result: await running, ask };
}

/** Let queued microtasks run. The host is a chain of awaits over a message port. */
const settle = async (turns = 8): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};

let h: Harness;

describe('the extension host', () => {
  beforeEach(() => {
    h = harness();
  });

  describe('the handshake', () => {
    it('accepts a matching protocol and answers hello-ok with its api version', async () => {
      h.extensions.add(manifestFor('shepherd.one'), 'builtin');
      await activate(h, manifestFor('shepherd.one'));

      const helloOk = h.child().sent.find((frame) => frame.kind === 'hello-ok');
      expect(helloOk).toMatchObject({ kind: 'hello-ok', protocol: EXT_PROTOCOL_VERSION });
      expect(h.host.state).toBe('ready');
      expect(h.host.childPid).toBe(4242);
    });

    it('refuses a protocol it does not speak, kills the child, and never retries', async () => {
      h.extensions.add(manifestFor('shepherd.one'), 'builtin');
      const running = h.extensions.activate(extensionId('shepherd.one'));
      await settle();
      h.child().hello(4242, 99);
      const result = await running;

      expect(result.ok).toBe(false);
      expect(h.child().sent.some((frame) => frame.kind === 'hello-refused')).toBe(true);
      // A refused child is killed rather than left holding memory and answering
      // nobody — and a second fork of the same binary would say 99 again.
      expect(h.child().killed).toBe(true);
      expect(h.host.state).toBe('refused');

      const again = await h.extensions.activate(extensionId('shepherd.one'));
      expect(again.ok).toBe(false);
      expect(h.children).toHaveLength(1);
    });

    it('fails with a reason when the child never says hello', async () => {
      h.extensions.add(manifestFor('shepherd.one'), 'builtin');
      const running = h.extensions.activate(extensionId('shepherd.one'));
      await settle();
      h.clock.advance(ASK_TIMEOUT_MS + 1);
      const result = await running;

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('no hello from the extension host');
      // Marked `failed`, with the reason on the record — not silently absent.
      expect(h.extensions.state(extensionId('shepherd.one'))).toBe('failed');
      expect(h.child().killed).toBe(true);
    });

    it('reports a fork that throws instead of hanging on it', async () => {
      const broken = harness({ spawnThrows: true });
      broken.extensions.add(manifestFor('shepherd.one'), 'builtin');
      const result = await broken.extensions.activate(extensionId('shepherd.one'));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('could not fork the extension host');
    });
  });

  describe('the proposed gate', () => {
    it('gives a builtin api.proposed in a production build', async () => {
      const production = harness({ isDev: false });
      production.extensions.add(manifestFor('shepherd.one'), 'builtin');
      const { result, ask } = await activate(production, manifestFor('shepherd.one'));

      expect(result.ok).toBe(true);
      expect(ask.ask).toMatchObject({ kind: 'activate', proposed: true, source: 'builtin' });
    });

    it('refuses a user extension in a production build, with the reason', async () => {
      const production = harness({ isDev: false });
      production.extensions.add(manifestFor('third.party', []), 'user');
      // A `user` extension is not pre-granted, so grant what it declared (nothing)
      // to isolate the API gate from the permission gate.
      production.permissions.grant(extensionId('third.party'), []);

      const result = await production.extensions.activate(extensionId('third.party'));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('every M1 API is proposed');
      expect(result.error).toContain('dev build');
      // Nothing was forked: the refusal is decided before the process is needed.
      expect(production.children).toHaveLength(0);
      expect(production.lines.some((line) => line.includes('every M1 API is proposed'))).toBe(true);
    });

    it('gives a user extension api.proposed in a dev build', async () => {
      h.extensions.add(manifestFor('third.party', []), 'user');
      h.permissions.grant(extensionId('third.party'), []);
      const { result, ask } = await activate(h, manifestFor('third.party', []));
      expect(result.ok).toBe(true);
      expect(ask.ask).toMatchObject({ proposed: true, source: 'user' });
    });
  });

  describe('who is asking', () => {
    it('derives the caller from the handle it minted, never from the frame', async () => {
      h.extensions.add(manifestFor('shepherd.one'), 'builtin');
      h.extensions.add(manifestFor('shepherd.two'), 'builtin');
      await activate(h, manifestFor('shepherd.one'));
      const { ask: two } = await activate(h, manifestFor('shepherd.two'));

      // A command that records who invoked it.
      const callers: Caller[] = [];
      h.registry.register('spy.who', {
        schema: s.nothing(),
        handler: (_args, caller) => void callers.push(caller),
      });

      const handleOfTwo = (two.ask as Extract<HostAsk, { kind: 'activate' }>).handle;
      h.child().send({
        kind: 'call',
        id: 'c-1',
        handle: handleOfTwo,
        call: { kind: 'command.invoke', commandId: 'spy.who' },
      });
      await settle();

      // `shepherd.two`, because that is whose handle it was — the frame carried
      // no id at all, and the union has nowhere to put one.
      expect(callers).toEqual([{ kind: 'extension', id: 'shepherd.two' }]);
    });

    it('dispatches nothing for a handle it never minted', async () => {
      h.extensions.add(manifestFor('shepherd.one'), 'builtin');
      await activate(h, manifestFor('shepherd.one'));

      let ran = 0;
      h.registry.register('spy.count', { schema: s.nothing(), handler: () => void (ran += 1) });

      h.child().send({
        kind: 'call',
        id: 'c-2',
        handle: 'a-handle-nobody-minted',
        call: { kind: 'command.invoke', commandId: 'spy.count' },
      });
      await settle();

      expect(ran).toBe(0);
      const result = h.child().sent.find((frame) => frame.kind === 'result');
      expect(result).toMatchObject({ kind: 'result', result: { ok: false, error: { code: 'unknown-handle' } } });
      expect(h.lines.some((line) => line.includes('names no live extension'))).toBe(true);
    });

    it('stops honouring a handle once its extension is gone', async () => {
      h.extensions.add(manifestFor('shepherd.one'), 'builtin');
      const { ask } = await activate(h, manifestFor('shepherd.one'));
      const handle = (ask.ask as Extract<HostAsk, { kind: 'activate' }>).handle;

      h.host.dispose();
      h.child().sendRaw({ kind: 'call', id: 'c-3', handle, call: { kind: 'command.list' } });
      await settle();
      // Nothing dispatched, and the reply could not even be posted — but the host
      // is still standing, which is the assertion that matters.
      expect(h.host.state).toBe('stopped');
    });
  });

  describe('serving a call', () => {
    beforeEach(async () => {
      h.extensions.add(manifestFor('shepherd.one'), 'builtin');
      await activate(h, manifestFor('shepherd.one'));
    });

    const handleOfOne = (): string => {
      const ask = h.child().asks('activate').at(-1)?.ask as Extract<HostAsk, { kind: 'activate' }>;
      return ask.handle;
    };

    const call = async (body: Record<string, unknown>, id = `c-${Math.random()}`) => {
      h.child().send({ kind: 'call', id, handle: handleOfOne(), call: body as never });
      await settle();
      return h.child().sent.filter((frame) => frame.kind === 'result').at(-1);
    };

    it('registers a proxy in the real registry and forwards an invocation to the child', async () => {
      await call({ kind: 'command.register', commandId: 'one.hello', title: 'Hello' });
      expect(h.registry.has('one.hello')).toBe(true);
      expect(h.registry.list()).toContainEqual({ id: 'one.hello', title: 'Hello' });

      // Invoked as a DEVICE, the way the CLI would.
      const invoking = h.registry.invoke('one.hello', { name: 'world' }, { kind: 'device', deviceId: 'local-cli' });
      await settle();
      const ask = h.child().asks('command').at(-1);
      expect(ask?.ask).toMatchObject({
        kind: 'command',
        extension: 'shepherd.one',
        commandId: 'one.hello',
        args: { name: 'world' },
        // The REAL caller, not the host's own: an extension handler is promised
        // the attributed principal.
        caller: { kind: 'device', deviceId: 'local-cli' },
      });

      h.child().send({ kind: 'answer', id: ask?.id ?? '', result: wireOk({ said: 'hi' }) });
      const result = await invoking;
      expect(result).toEqual({ ok: true, value: { said: 'hi' } });
    });

    it('refuses a command id something else already owns, rather than throwing in main', async () => {
      h.registry.register('layout.split', { schema: s.nothing(), handler: () => undefined });
      const result = await call({ kind: 'command.register', commandId: 'layout.split' });
      expect(result).toMatchObject({ result: { ok: false, error: { code: 'duplicate-command' } } });
    });

    it('refuses a command declaring a permission the host does not know', async () => {
      const result = await call({ kind: 'command.register', commandId: 'one.bad', permission: 'omnipotence' });
      // Registering it with the permission dropped would produce an UNPROTECTED
      // command, which is the opposite of what its author wrote.
      expect(result).toMatchObject({ result: { ok: false, error: { code: 'invalid-args' } } });
      expect(h.registry.has('one.bad')).toBe(false);
    });

    it('authorizes a command invocation with the one authorizer in the dispatcher', async () => {
      // `attention.set` needs the `attention` permission; this extension has only
      // `storage`. No second check anywhere — the registry's dispatcher decides.
      h.registry.register('needs.attention', {
        schema: s.nothing(),
        permission: 'attention',
        handler: () => 'should not run',
      });
      const result = await call({ kind: 'command.invoke', commandId: 'needs.attention' });
      expect(result).toMatchObject({ result: { ok: false, error: { code: 'denied' } } });
    });

    it('writes storage only for an extension that declared it', async () => {
      const ok = await call({ kind: 'storage.set', key: 'pings', value: 3 });
      expect(ok).toMatchObject({ result: { ok: true } });
      expect(h.store.namespace(storageNamespace(extensionId('shepherd.one'))).get('pings', s.number())).toBe(3);

      // The negative control: an extension declaring nothing is denied by the same
      // pure `authorize` the dispatcher uses.
      h.extensions.add(manifestFor('shepherd.bare', []), 'builtin');
      const { ask } = await activate(h, manifestFor('shepherd.bare', []));
      h.child().send({
        kind: 'call',
        id: 'c-bare',
        handle: (ask.ask as Extract<HostAsk, { kind: 'activate' }>).handle,
        call: { kind: 'storage.set', key: 'nope', value: 1 },
      });
      await settle();
      const denied = h.child().sent.filter((frame) => frame.kind === 'result').at(-1);
      expect(denied).toMatchObject({ result: { ok: false, error: { code: 'denied' } } });
    });

    it('seeds the child with the whole namespace, because ctx.storage reads are synchronous', async () => {
      h.store.namespace(storageNamespace(extensionId('shepherd.seeded'))).set('pings', 12);
      h.extensions.add(manifestFor('shepherd.seeded'), 'builtin');
      const { ask } = await activate(h, manifestFor('shepherd.seeded'));
      expect((ask.ask as Extract<HostAsk, { kind: 'activate' }>).storage).toEqual({ pings: 12 });
    });

    it('emits onto the real bus and delivers a subscription back with its envelope', async () => {
      const seen: { payload: unknown; seq: number }[] = [];
      h.bus.on('one.thing', (payload, envelope) => void seen.push({ payload, seq: envelope.seq }));

      await call({ kind: 'event.emit', topic: 'one.thing', payload: { n: 1 } });
      expect(seen).toEqual([{ payload: { n: 1 }, seq: 1 }]);

      await call({ kind: 'event.on', topic: 'other.thing', subscription: 'sub-1' });
      h.bus.emit('other.thing', { n: 2 }, { kind: 'kernel' });
      const pushed = h.child().sent.find((frame) => frame.kind === 'event');
      expect(pushed).toMatchObject({
        kind: 'event',
        subscription: 'sub-1',
        topic: 'other.thing',
        payload: { n: 2 },
        source: { kind: 'kernel' },
      });

      await call({ kind: 'event.off', subscription: 'sub-1' });
      const before = h.child().sent.filter((frame) => frame.kind === 'event').length;
      h.bus.emit('other.thing', { n: 3 }, { kind: 'kernel' });
      expect(h.child().sent.filter((frame) => frame.kind === 'event')).toHaveLength(before);
    });

    it('forwards a log line to the host logger', async () => {
      await call({ kind: 'log', level: 'warn', message: 'something the extension wants on the record' });
      expect(h.lines.some((line) => line.includes('something the extension wants on the record'))).toBe(true);
    });

    it('skips an unreadable frame without losing the ones beside it', async () => {
      h.registry.register('spy.batch', { schema: s.nothing(), handler: () => 'ran' });
      h.child().sendRaw([
        { kind: 'from-a-newer-build' },
        { kind: 'call', id: 'c-b', handle: handleOfOne(), call: { kind: 'command.invoke', commandId: 'spy.batch' } },
      ]);
      await settle();

      expect(h.child().sent.some((frame) => frame.kind === 'result')).toBe(true);
      expect(h.lines.some((line) => line.includes('skipped an unreadable frame'))).toBe(true);
    });

    it('logs an answer nobody is waiting for rather than throwing', async () => {
      expect(() => h.child().send({ kind: 'answer', id: 'never-asked', result: wireOk() })).not.toThrow();
      await settle();
      expect(h.lines.some((line) => line.includes('nothing is waiting for'))).toBe(true);
    });
  });

  describe('liveness', () => {
    it('logs the exit code and puts the extension back through the registry', async () => {
      h.extensions.add(manifestFor('shepherd.one'), 'builtin');
      await activate(h, manifestFor('shepherd.one'));
      await call_register(h);
      expect(h.registry.has('one.hello')).toBe(true);

      const first = h.child();
      first.die(9);
      await settle();

      expect(h.lines.some((line) => line.includes('extension host exited with code 9'))).toBe(true);
      // The proxy is gone: a registered command forwarding into a corpse is the
      // `acceptBridged` silent no-op reborn.
      expect(h.registry.has('one.hello')).toBe(false);
      // And it restarted exactly once.
      expect(h.children).toHaveLength(2);
      expect(h.lines.some((line) => line.includes('restarting the extension host (attempt 1 of 1)'))).toBe(true);

      // The new child completes its handshake and the extension comes back.
      h.child().hello(5150);
      await settle();
      const ask = h.child().asks('activate').at(-1);
      h.child().answer(ask?.id ?? '', true);
      await settle();
      expect(h.extensions.state(extensionId('shepherd.one'))).toBe('active');
      expect(h.host.childPid).toBe(5150);
    });

    it('marks extensions failed rather than absent once the one restart is spent', async () => {
      h.extensions.add(manifestFor('shepherd.one'), 'builtin');
      await activate(h, manifestFor('shepherd.one'));

      h.child().die(1);
      await settle();
      // Second child comes up and re-activates.
      h.child().hello();
      await settle();
      h.child().answer(h.child().asks('activate').at(-1)?.id ?? '', true);
      await settle();
      expect(h.extensions.state(extensionId('shepherd.one'))).toBe('active');

      // …and dies again. That is the end of it.
      h.child().die(1);
      await settle();

      expect(h.children).toHaveLength(2);
      expect(h.host.state).toBe('exhausted');
      expect(h.extensions.state(extensionId('shepherd.one'))).toBe('failed');
      const record = h.extensions.list().find((entry) => entry.manifest.id === 'shepherd.one');
      expect(record?.reason).toContain('restart is spent');
      expect(h.lines.some((line) => line.includes('marking shepherd.one failed'))).toBe(true);
      expect(MAX_HOST_RESTARTS).toBe(1);
    });

    it('does not fork a replacement when the child exits 0 unasked', async () => {
      h.extensions.add(manifestFor('shepherd.one'), 'builtin');
      await activate(h, manifestFor('shepherd.one'));
      await call_register(h);

      // `app.exit()` emits neither `before-quit` nor `will-quit`, so no teardown
      // hook can run before the child's exit arrives. Without this branch the app
      // forks a replacement extension host on its way out the door.
      h.child().die(0);
      await settle();

      expect(h.children).toHaveLength(1);
      expect(h.registry.has('one.hello')).toBe(false);
      // Not silent, and not a lie: `installed` is exactly what it is now.
      expect(h.extensions.state(extensionId('shepherd.one'))).toBe('installed');
      expect(h.lines.some((line) => line.includes('exited cleanly (code 0) without being asked'))).toBe(true);
      expect(h.lines.some((line) => line.includes('restarting the extension host'))).toBe(false);
    });

    it('treats a deliberate shutdown as a shutdown, not a crash', async () => {
      h.extensions.add(manifestFor('shepherd.one'), 'builtin');
      await activate(h, manifestFor('shepherd.one'));

      h.host.dispose();
      // `dispose` kills the child, and the real one answers with an exit event.
      h.child().die(0);
      await settle();

      // No error, no restart, and nothing marked failed on the way out the door.
      expect(h.children).toHaveLength(1);
      expect(h.lines.some((line) => line.includes('during shutdown'))).toBe(true);
      expect(h.lines.some((line) => line.includes('restarting the extension host'))).toBe(false);
    });

    it('fails an in-flight activation when the child dies under it', async () => {
      h.extensions.add(manifestFor('shepherd.one'), 'builtin');
      const running = h.extensions.activate(extensionId('shepherd.one'));
      await settle();
      h.child().hello();
      await settle();
      h.child().die(7);

      const result = await running;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('exited with code 7');
    });

    it('times out a wedged activate instead of hanging forever', async () => {
      h.extensions.add(manifestFor('shepherd.one'), 'builtin');
      const { result } = await activate(h, manifestFor('shepherd.one'), 'silent');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain(`did not answer activate within ${ASK_TIMEOUT_MS}ms`);
      expect(h.extensions.state(extensionId('shepherd.one'))).toBe('failed');

      // The late answer, arriving after the deadline: logged, never thrown, and it
      // must not settle anything a second time.
      const ask = h.child().asks('activate').at(-1);
      expect(() => h.child().answer(ask?.id ?? '', true)).not.toThrow();
      await settle();
      expect(h.lines.some((line) => line.includes('nothing is waiting for'))).toBe(true);
    });

    it('reports an extension that threw in activate, with the message intact', async () => {
      h.extensions.add(manifestFor('shepherd.one'), 'builtin');
      const { result } = await activate(h, manifestFor('shepherd.one'), 'throw');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('threw while activating: boom');
      expect(h.extensions.state(extensionId('shepherd.one'))).toBe('failed');
      // The host itself is untouched: one bad extension is one bad extension.
      expect(h.host.state).toBe('ready');
    });
  });

  describe('extensions.list', () => {
    it('reports the child pid, so a caller can tell which process answered', async () => {
      h.host.registerCommands();
      h.extensions.add(manifestFor('shepherd.one'), 'builtin');
      await activate(h, manifestFor('shepherd.one'));

      const answer = await h.registry.invoke<{
        extensions: number;
        commands: number;
        childPid: number;
        records: { id: string; state: string }[];
      }>(EXTENSIONS_LIST_COMMAND, undefined, { kind: 'user' });

      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      expect(answer.value.childPid).toBe(4242);
      expect(answer.value.extensions).toBe(1);
      expect(answer.value.commands).toBeGreaterThan(0);
      expect(answer.value.records).toEqual([
        expect.objectContaining({ id: 'shepherd.one', state: 'active', source: 'builtin' }),
      ]);
    });
  });
});

/** Registers `one.hello` through the child, for the liveness tests. */
async function call_register(harnessed: Harness): Promise<void> {
  const ask = harnessed.child().asks('activate').at(-1)?.ask as Extract<HostAsk, { kind: 'activate' }>;
  harnessed.child().send({
    kind: 'call',
    id: 'c-reg',
    handle: ask.handle,
    call: { kind: 'command.register', commandId: 'one.hello' },
  });
  await settle();
}
