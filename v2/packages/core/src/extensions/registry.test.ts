import { beforeEach, describe, expect, it } from 'vitest';
import {
  createLogger,
  extensionId,
  manualClock,
  ok,
  err,
  type LogRecord,
  type Logger,
  type Manifest,
  type Result,
} from '@shepherd/sdk';
import { SqliteStore } from '../storage/store.ts';
import { PermissionStore } from './permissions.ts';
import { ExtensionRegistry, shouldActivate, type ActivationTrigger } from './registry.ts';

let records: LogRecord[];
let logger: Logger;

beforeEach(() => {
  records = [];
  logger = createLogger({ clock: manualClock(0), level: 'debug', sink: (_l, r) => records.push(r) });
});

const messages = () => records.map((r) => r.message);

/** A raw manifest blob, as it would sit in a package.json. */
function raw(id: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    version: '1.0.0',
    api: '^1.0.0',
    activation: ['onStartup'],
    permissions: [],
    ...patch,
  };
}

function manifest(id: string, patch: Partial<Manifest> = {}): Manifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    api: '^1.0.0',
    activation: ['onStartup'],
    permissions: [],
    ...patch,
  };
}

interface Harness {
  readonly registry: ExtensionRegistry;
  readonly permissions: PermissionStore;
  /** Ids the activator was called with, in call order. */
  readonly activated: string[];
  /** Ids whose activator should report a failure. */
  readonly failing: Set<string>;
  /** Ids whose activator should throw instead of returning a Result. */
  readonly throwing: Set<string>;
}

function harness(): Harness {
  const permissions = new PermissionStore(
    new SqliteStore({ location: ':memory:', logger }).namespace('extensions.permissions'),
    logger,
  );
  const activated: string[] = [];
  const failing = new Set<string>();
  const throwing = new Set<string>();
  const registry = new ExtensionRegistry({
    permissions,
    logger,
    activator: async (m): Promise<Result<void, string>> => {
      activated.push(m.id);
      if (throwing.has(m.id)) throw new Error(`${m.id} blew up`);
      return failing.has(m.id) ? err(`${m.id} refused to start`) : ok(undefined);
    },
  });
  return { registry, permissions, activated, failing, throwing };
}

describe('add', () => {
  it('validates, records `installed`, and hands back the typed manifest', () => {
    const { registry } = harness();
    const result = registry.add(raw('shepherd.tasks'), 'builtin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('shepherd.tasks');
    expect(registry.state(extensionId('shepherd.tasks'))).toBe('installed');
  });

  it('a malformed manifest is a typed error and records NOTHING', () => {
    // Half-registering an extension whose manifest we could not read is worse than
    // not registering it: something later reads a record it cannot trust.
    const { registry } = harness();
    const result = registry.add(raw('tasks'), 'user');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.field).toBe('id');
    expect(registry.list()).toEqual([]);
    expect(messages().some((m) => m.includes('reverse-dotted'))).toBe(true);
  });

  it('pre-grants a built-in at add time — the one seam where source matters', () => {
    // `add` is *when*; `PermissionStore.review` is the policy. Keeping the decision
    // in one file means there is one answer to "why does this extension hold that".
    const { registry, permissions } = harness();
    registry.add(raw('shepherd.tasks', { permissions: ['sessions'] }), 'builtin');
    expect(permissions.isGranted(extensionId('shepherd.tasks'), 'sessions')).toBe(true);
  });

  it('leaves a user extension ungranted, and says a review is pending', () => {
    const { registry, permissions } = harness();
    registry.add(raw('shepherd.tasks', { permissions: ['sessions'] }), 'user');
    expect(permissions.granted(extensionId('shepherd.tasks'))).toEqual([]);
    expect(messages().some((m) => m.includes('review'))).toBe(true);
  });

  it('re-adding an installed extension replaces the record — that is an update', () => {
    const { registry } = harness();
    registry.add(raw('shepherd.tasks', { version: '1.0.0' }), 'user');
    const result = registry.add(raw('shepherd.tasks', { version: '2.0.0' }), 'user');
    expect(result.ok).toBe(true);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.manifest.version).toBe('2.0.0');
  });

  it('refuses to replace an ACTIVE extension, naming it', async () => {
    // Its `activate` already ran against the old manifest — its commands, points and
    // permissions belong to that version. Swapping the record underneath would make
    // `list()` describe something that is not what is running.
    const { registry } = harness();
    registry.add(raw('shepherd.tasks'), 'builtin');
    await registry.activate(extensionId('shepherd.tasks'));
    const result = registry.add(raw('shepherd.tasks', { version: '2.0.0' }), 'builtin');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.message).toContain('active');
    expect(registry.list()[0]?.manifest.version).toBe('1.0.0');
  });

  it('list reports id, source and state', () => {
    const { registry } = harness();
    registry.add(raw('shepherd.tasks'), 'builtin');
    registry.add(raw('acme.thing'), 'user');
    expect(registry.list().map((r) => [r.manifest.id, r.source, r.state])).toEqual([
      ['shepherd.tasks', 'builtin', 'installed'],
      ['acme.thing', 'user', 'installed'],
    ]);
  });
});

describe('shouldActivate — pure', () => {
  const startup: ActivationTrigger = { kind: 'startup' };

  it('matches onStartup only for a startup trigger', () => {
    expect(shouldActivate(manifest('a.b', { activation: ['onStartup'] }), startup)).toBe(true);
    expect(shouldActivate(manifest('a.b', { activation: ['onCommand:x.y'] }), startup)).toBe(false);
  });

  it('matches a command by exact id, never by prefix', () => {
    // `onCommand:tasks.create` must not fire for `tasks.createBranch`. Prefix
    // matching here would activate extensions on commands they never declared.
    const m = manifest('a.b', { activation: ['onCommand:tasks.create'] });
    expect(shouldActivate(m, { kind: 'command', id: 'tasks.create' })).toBe(true);
    expect(shouldActivate(m, { kind: 'command', id: 'tasks.createBranch' })).toBe(false);
    expect(shouldActivate(m, { kind: 'command', id: 'tasks' })).toBe(false);
  });

  it('matches a view by type', () => {
    const m = manifest('a.b', { activation: ['onView:tasks.sidebar'] });
    expect(shouldActivate(m, { kind: 'view', type: 'tasks.sidebar' })).toBe(true);
    expect(shouldActivate(m, { kind: 'view', type: 'other' })).toBe(false);
  });

  it('does not cross the event kinds', () => {
    const m = manifest('a.b', { activation: ['onCommand:tasks.create'] });
    expect(shouldActivate(m, { kind: 'view', type: 'tasks.create' })).toBe(false);
    expect(shouldActivate(manifest('a.b', { activation: ['onView:x'] }), { kind: 'command', id: 'x' })).toBe(false);
  });

  it('matches any one of several declared events', () => {
    const m = manifest('a.b', { activation: ['onCommand:one', 'onCommand:two', 'onView:v'] });
    expect(shouldActivate(m, { kind: 'command', id: 'two' })).toBe(true);
    expect(shouldActivate(m, { kind: 'view', type: 'v' })).toBe(true);
  });

  it('an extension declaring nothing never activates', () => {
    const m = manifest('a.b', { activation: [] });
    expect(shouldActivate(m, startup)).toBe(false);
    expect(shouldActivate(m, { kind: 'command', id: 'x' })).toBe(false);
  });
});

describe('activate', () => {
  it('calls the activator and marks it active', async () => {
    const { registry, activated } = harness();
    registry.add(raw('shepherd.tasks'), 'builtin');
    const result = await registry.activate(extensionId('shepherd.tasks'));
    expect(result).toEqual({ ok: true, value: undefined });
    expect(activated).toEqual(['shepherd.tasks']);
    expect(registry.state(extensionId('shepherd.tasks'))).toBe('active');
  });

  it('is idempotent — a second activate is ok and does not re-run the activator', async () => {
    // An `onCommand` trigger fires every time the command is invoked.
    const { registry, activated } = harness();
    registry.add(raw('shepherd.tasks'), 'builtin');
    await registry.activate(extensionId('shepherd.tasks'));
    expect(await registry.activate(extensionId('shepherd.tasks'))).toEqual({ ok: true, value: undefined });
    expect(activated).toEqual(['shepherd.tasks']);
  });

  it('two overlapping activations share one in-flight run', async () => {
    // Two transports can invoke the same `onCommand` in the same tick. Activating
    // twice would register every command twice, and the second registration THROWS
    // (DuplicateCommandError) — so this is not a tidiness point.
    const { registry, activated } = harness();
    registry.add(raw('shepherd.tasks'), 'builtin');
    const id = extensionId('shepherd.tasks');
    const [first, second] = await Promise.all([registry.activate(id), registry.activate(id)]);
    expect(first.ok && second.ok).toBe(true);
    expect(activated).toEqual(['shepherd.tasks']);
  });

  it('an unknown extension is a typed error naming it', async () => {
    const { registry } = harness();
    const result = await registry.activate(extensionId('acme.ghost'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('acme.ghost');
    expect(registry.state(extensionId('acme.ghost'))).toBeUndefined();
  });

  it('refuses an ungranted extension, names the missing permission, and never calls the activator', async () => {
    // The gate is the store, not the source: there is one authorization path.
    const { registry, activated } = harness();
    registry.add(raw('acme.thing', { permissions: ['process.exec', 'network'] }), 'user');
    const result = await registry.activate(extensionId('acme.thing'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('process.exec');
    expect(result.error).toContain('network');
    expect(activated).toEqual([]);
    expect(registry.state(extensionId('acme.thing'))).toBe('failed');
    expect(registry.list()[0]?.reason).toContain('process.exec');
  });

  it('a failure is retryable — granting the permission and activating again works', async () => {
    // `failed` is not sticky, deliberately: the realistic causes (a permission not
    // yet reviewed, a host that just crashed) are all recoverable, and the next
    // `onCommand` trigger is the natural retry.
    const { registry, permissions, activated } = harness();
    registry.add(raw('acme.thing', { permissions: ['network'] }), 'user');
    const id = extensionId('acme.thing');
    await registry.activate(id);
    permissions.grant(id, ['network']);
    expect(await registry.activate(id)).toEqual({ ok: true, value: undefined });
    expect(activated).toEqual(['acme.thing']);
    expect(registry.state(id)).toBe('active');
  });

  it('an activator failure marks it failed, keeps the reason, and LOGS it', async () => {
    // An extension that silently did not load is v1's `acceptBridged` no-op reborn:
    // a phone completed its handshake and was answered by nobody, with no line
    // anywhere. Cost a session of tcpdump to find.
    const { registry, failing } = harness();
    registry.add(raw('acme.thing'), 'user');
    failing.add('acme.thing');
    const result = await registry.activate(extensionId('acme.thing'));
    expect(result).toEqual({ ok: false, error: 'acme.thing refused to start' });
    expect(registry.state(extensionId('acme.thing'))).toBe('failed');
    expect(records.some((r) => r.level === 'error' && r.message.includes('refused to start'))).toBe(true);
  });

  it('an activator that THROWS is a failure, not a crash', async () => {
    // The activator is the process boundary in the next phase. A throw crossing it
    // must not take the registry (or the app) down.
    const { registry, throwing } = harness();
    registry.add(raw('acme.thing'), 'user');
    throwing.add('acme.thing');
    const result = await registry.activate(extensionId('acme.thing'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('blew up');
    expect(registry.state(extensionId('acme.thing'))).toBe('failed');
  });

  it('reports `activating` while the activator is in flight', async () => {
    let observed: string | undefined;
    const permissions = new PermissionStore(
      new SqliteStore({ location: ':memory:', logger }).namespace('p'),
      logger,
    );
    const registry: ExtensionRegistry = new ExtensionRegistry({
      permissions,
      logger,
      activator: async (m) => {
        observed = registry.state(extensionId(m.id));
        return ok(undefined);
      },
    });
    registry.add(raw('shepherd.tasks'), 'builtin');
    await registry.activate(extensionId('shepherd.tasks'));
    expect(observed).toBe('activating');
  });
});

describe('dependencies', () => {
  it('activates a dependency first, depth-first', async () => {
    // §7c: cross-extension calls are declared, not discovered, and the host checks
    // the dependency is active BEFORE activating the dependent — instead of failing
    // later with an undefined.
    const { registry, activated } = harness();
    registry.add(raw('shepherd.agents-core'), 'builtin');
    registry.add(raw('shepherd.claude-code', { dependencies: ['shepherd.agents-core'] }), 'builtin');
    await registry.activate(extensionId('shepherd.claude-code'));
    expect(activated).toEqual(['shepherd.agents-core', 'shepherd.claude-code']);
    expect(registry.state(extensionId('shepherd.agents-core'))).toBe('active');
  });

  it('activates a transitive chain in order', async () => {
    const { registry, activated } = harness();
    registry.add(raw('a.one'), 'builtin');
    registry.add(raw('a.two', { dependencies: ['a.one'] }), 'builtin');
    registry.add(raw('a.three', { dependencies: ['a.two'] }), 'builtin');
    await registry.activate(extensionId('a.three'));
    expect(activated).toEqual(['a.one', 'a.two', 'a.three']);
  });

  it('does not re-activate a dependency that is already active', async () => {
    const { registry, activated } = harness();
    registry.add(raw('a.one'), 'builtin');
    registry.add(raw('a.two', { dependencies: ['a.one'] }), 'builtin');
    await registry.activate(extensionId('a.one'));
    await registry.activate(extensionId('a.two'));
    expect(activated).toEqual(['a.one', 'a.two']);
  });

  it('a missing dependency fails the dependent, naming it, without activating anything', async () => {
    const { registry, activated } = harness();
    registry.add(raw('shepherd.claude-code', { dependencies: ['shepherd.agents-core'] }), 'builtin');
    const result = await registry.activate(extensionId('shepherd.claude-code'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('shepherd.agents-core');
    expect(result.error).toContain('not installed');
    expect(activated).toEqual([]);
    expect(registry.state(extensionId('shepherd.claude-code'))).toBe('failed');
  });

  it('a dependency that fails to activate fails the dependent with the reason', async () => {
    const { registry, failing, activated } = harness();
    registry.add(raw('a.one'), 'builtin');
    registry.add(raw('a.two', { dependencies: ['a.one'] }), 'builtin');
    failing.add('a.one');
    const result = await registry.activate(extensionId('a.two'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('a.one');
    expect(activated).toEqual(['a.one']);
    expect(registry.state(extensionId('a.two'))).toBe('failed');
    expect(registry.state(extensionId('a.one'))).toBe('failed');
  });

  it('a cycle fails BOTH extensions with a reason naming the cycle', async () => {
    // Left undetected this is an unbounded recursion, or — with in-flight sharing —
    // a deadlock: two promises each awaiting the other. Either way the app would
    // hang at startup with nothing to read.
    const { registry, activated } = harness();
    registry.add(raw('a.one', { dependencies: ['a.two'] }), 'builtin');
    registry.add(raw('a.two', { dependencies: ['a.one'] }), 'builtin');
    const result = await registry.activate(extensionId('a.one'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('cycle');
    expect(result.error).toContain('a.one -> a.two -> a.one');
    expect(registry.state(extensionId('a.one'))).toBe('failed');
    expect(registry.state(extensionId('a.two'))).toBe('failed');
    expect(registry.list().every((r) => (r.reason ?? '').includes('cycle'))).toBe(true);
    expect(activated).toEqual([]);
  });

  it('detects a three-link cycle and names the whole path', async () => {
    const { registry } = harness();
    registry.add(raw('a.one', { dependencies: ['a.two'] }), 'builtin');
    registry.add(raw('a.two', { dependencies: ['a.three'] }), 'builtin');
    registry.add(raw('a.three', { dependencies: ['a.one'] }), 'builtin');
    const result = await registry.activate(extensionId('a.one'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('a.one -> a.two -> a.three -> a.one');
  });

  it('a diamond activates the shared dependency once', async () => {
    // Two dependents on one dependency is not a cycle, and a path-based check must
    // not mistake it for one.
    const { registry, activated } = harness();
    registry.add(raw('a.base'), 'builtin');
    registry.add(raw('a.left', { dependencies: ['a.base'] }), 'builtin');
    registry.add(raw('a.right', { dependencies: ['a.base'] }), 'builtin');
    registry.add(raw('a.top', { dependencies: ['a.left', 'a.right'] }), 'builtin');
    const result = await registry.activate(extensionId('a.top'));
    expect(result.ok).toBe(true);
    expect(activated).toEqual(['a.base', 'a.left', 'a.right', 'a.top']);
  });
});

describe('deactivate', () => {
  it('returns an active extension to `installed`', async () => {
    const { registry } = harness();
    registry.add(raw('shepherd.tasks'), 'builtin');
    const id = extensionId('shepherd.tasks');
    await registry.activate(id);
    registry.deactivate(id);
    expect(registry.state(id)).toBe('installed');
  });

  it('lets it activate again afterwards', async () => {
    const { registry, activated } = harness();
    registry.add(raw('shepherd.tasks'), 'builtin');
    const id = extensionId('shepherd.tasks');
    await registry.activate(id);
    registry.deactivate(id);
    await registry.activate(id);
    expect(activated).toEqual(['shepherd.tasks', 'shepherd.tasks']);
  });

  it('clears a failure, so a deactivate is also a reset', async () => {
    const { registry, failing } = harness();
    registry.add(raw('acme.thing'), 'user');
    failing.add('acme.thing');
    const id = extensionId('acme.thing');
    await registry.activate(id);
    registry.deactivate(id);
    expect(registry.state(id)).toBe('installed');
    expect(registry.list()[0]?.reason).toBeUndefined();
  });

  it('deactivating something that is not active is a no-op, and unknown is not a throw', () => {
    const { registry } = harness();
    registry.add(raw('shepherd.tasks'), 'builtin');
    expect(() => registry.deactivate(extensionId('shepherd.tasks'))).not.toThrow();
    expect(() => registry.deactivate(extensionId('acme.ghost'))).not.toThrow();
    expect(registry.state(extensionId('shepherd.tasks'))).toBe('installed');
  });

  it('refuses while the extension is still activating', async () => {
    // Otherwise the in-flight `#run` still holds the entry and marks it `active`
    // when the activator resolves — a deactivated extension that resurrects itself
    // — and clearing `pending` mid-flight lets the next trigger start a SECOND
    // concurrent run, which is the double-registration the in-flight share exists
    // to prevent (`DuplicateCommandError` throws on the second one). Real
    // cancellation needs the process host; refusing is the honest answer here.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const permissions = new PermissionStore(
      new SqliteStore({ location: ':memory:', logger }).namespace('p'),
      logger,
    );
    const registry = new ExtensionRegistry({
      permissions,
      logger,
      activator: async () => {
        await held;
        return ok(undefined);
      },
    });
    registry.add(raw('shepherd.tasks'), 'builtin');
    const id = extensionId('shepherd.tasks');
    const activation = registry.activate(id);
    expect(registry.state(id)).toBe('activating');
    registry.deactivate(id);
    expect(registry.state(id)).toBe('activating');
    expect(messages().some((m) => m.includes('shepherd.tasks') && m.includes('still activating'))).toBe(true);
    release();
    expect(await activation).toEqual({ ok: true, value: undefined });
    expect(registry.state(id)).toBe('active');
  });

  it('warns, naming the active dependents it just left holding a dead API', async () => {
    // It does NOT cascade: shutdown would otherwise depend on the order the host
    // tears extensions down in. But a dependent whose dependency vanished with no
    // line anywhere is the silent-failure class, so it is said out loud.
    const { registry } = harness();
    registry.add(raw('shepherd.agents-core'), 'builtin');
    registry.add(raw('shepherd.claude-code', { dependencies: ['shepherd.agents-core'] }), 'builtin');
    await registry.activate(extensionId('shepherd.claude-code'));
    registry.deactivate(extensionId('shepherd.agents-core'));
    expect(messages().some((m) => m.includes('shepherd.claude-code') && m.includes('shepherd.agents-core'))).toBe(true);
    expect(registry.state(extensionId('shepherd.claude-code'))).toBe('active');
  });
});

describe('apiFor — what `extensions.get` may resolve', () => {
  it('is exactly the declared dependencies', async () => {
    const { registry } = harness();
    registry.add(raw('shepherd.agents-core'), 'builtin');
    registry.add(raw('shepherd.worktrees'), 'builtin');
    registry.add(raw('shepherd.claude-code', { dependencies: ['shepherd.agents-core'] }), 'builtin');
    await registry.activate(extensionId('shepherd.worktrees'));
    // `worktrees` is active and installed and STILL unreachable: reaching another
    // extension's API is a reviewable fact in the manifest, not a string a caller
    // invents at runtime (§7c).
    expect(registry.apiFor(extensionId('shepherd.claude-code'))).toEqual(['shepherd.agents-core']);
  });

  it('is empty for an extension that declared none', () => {
    const { registry } = harness();
    registry.add(raw('shepherd.tasks'), 'builtin');
    registry.add(raw('acme.thing'), 'user');
    expect(registry.apiFor(extensionId('acme.thing'))).toEqual([]);
  });

  it('is empty for an unknown extension', () => {
    expect(harness().registry.apiFor(extensionId('acme.ghost'))).toEqual([]);
  });

  it('lists a declared dependency even before it is active', () => {
    // Declared is declared. Whether the id RESOLVES to a live API is
    // `extensions.get`'s call at the moment of the call, and folding liveness in
    // here would give two places an answer to the same question.
    const { registry } = harness();
    registry.add(raw('shepherd.agents-core'), 'builtin');
    registry.add(raw('shepherd.claude-code', { dependencies: ['shepherd.agents-core'] }), 'builtin');
    expect(registry.apiFor(extensionId('shepherd.claude-code'))).toEqual(['shepherd.agents-core']);
  });
});

describe('activateFor — a trigger fanned out', () => {
  it('activates every extension that declared onStartup, and nothing else', async () => {
    const { registry, activated } = harness();
    registry.add(raw('a.startup'), 'builtin');
    registry.add(raw('a.lazy', { activation: ['onCommand:a.lazy.do'] }), 'builtin');
    await registry.activateFor({ kind: 'startup' });
    expect(activated).toEqual(['a.startup']);
  });

  it('activates the extension a command belongs to', async () => {
    const { registry, activated } = harness();
    registry.add(raw('a.lazy', { activation: ['onCommand:a.lazy.do'] }), 'builtin');
    await registry.activateFor({ kind: 'command', id: 'a.lazy.do' });
    expect(activated).toEqual(['a.lazy']);
  });

  it('reports each result, so one failure does not hide the others', async () => {
    const { registry, failing } = harness();
    registry.add(raw('a.one'), 'builtin');
    registry.add(raw('a.two'), 'builtin');
    failing.add('a.one');
    const results = await registry.activateFor({ kind: 'startup' });
    expect(results.map((r) => [r.id, r.result.ok])).toEqual([
      ['a.one', false],
      ['a.two', true],
    ]);
  });

  it('skips an extension that is already active', async () => {
    const { registry, activated } = harness();
    registry.add(raw('a.one'), 'builtin');
    await registry.activate(extensionId('a.one'));
    await registry.activateFor({ kind: 'startup' });
    expect(activated).toEqual(['a.one']);
  });
});
