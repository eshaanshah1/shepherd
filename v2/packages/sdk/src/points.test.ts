import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger, type LogRecord, type Logger } from './log.ts';
import { manualClock } from './clock.ts';
import type { ExtensionPoint, PointsAPI } from './api-kernel.ts';
import { DuplicatePointError, PointRegistry } from './points.ts';

/** What M2's first real consumer looks like: a vendor agent kind (spec §7c). */
interface AgentKind {
  readonly id: string;
}

const codex: AgentKind = { id: 'codex' };
const claude: AgentKind = { id: 'claude-code' };
const opencode: AgentKind = { id: 'opencode' };

const POINT = 'agents-core.kinds';

let records: LogRecord[];
let logger: Logger;
let points: PointRegistry;

beforeEach(() => {
  records = [];
  logger = createLogger({ clock: manualClock(0), level: 'debug', sink: (_l, r) => records.push(r) });
  points = new PointRegistry({ logger });
});

const messages = () => records.map((r) => r.message);
const ids = (point: ExtensionPoint<AgentKind>) => point.all().map((kind) => kind.id);

describe('define and get', () => {
  it('a point starts empty', () => {
    const point = points.define<AgentKind>(POINT);
    expect(point.id).toBe(POINT);
    expect(point.all()).toEqual([]);
    expect(point.first()).toBeUndefined();
  });

  it('another extension resolves it by id', () => {
    // The seam that makes extensions platforms too: `agents-core` defines the
    // point, `codex` registers into it, and neither the kernel nor `agents-core`
    // needed a change for the second vendor to exist (spec §7c).
    const owner = points.define<AgentKind>(POINT);
    const seen = points.get<AgentKind>(POINT);
    expect(seen).toBe(owner);
    seen?.register(codex);
    expect(ids(owner)).toEqual(['codex']);
  });

  it('an undefined point is undefined, not an empty point', () => {
    // Handing back an empty point would make "nobody defines this seam" and
    // "nobody has registered into it" the same answer, and the first is a typo.
    expect(points.get('nobody.defines.this')).toBeUndefined();
  });

  it('defining the same id twice throws, naming it', () => {
    // Same reasoning as DuplicateCommandError: a seam is public API, and silently
    // replacing one takes every provider its author registered with it.
    points.define(POINT);
    expect(() => points.define(POINT)).toThrow(DuplicatePointError);
    expect(() => points.define(POINT)).toThrow(POINT);
  });

  it('the id is free again once the point is disposed', () => {
    // An extension reloaded in a dev build re-defines its points, and refusing
    // that would make a reload a restart.
    points.define(POINT).dispose();
    expect(() => points.define(POINT)).not.toThrow();
  });

  it('satisfies the SDK PointsAPI', () => {
    const api: PointsAPI = points;
    api.define<AgentKind>(POINT);
    expect(api.get<AgentKind>(POINT)?.id).toBe(POINT);
  });
});

describe('owners', () => {
  it('records who defined a point, and answers for nobody otherwise', () => {
    points.define(POINT, { owner: 'shepherd.agents-core' });
    expect(points.ownerOf(POINT)).toBe('shepherd.agents-core');
    expect(points.ownerOf('nobody.defines.this')).toBeUndefined();
  });

  it('names the first owner when a second extension defines over it', () => {
    // The refusal has to say who already holds the id, or the author of the
    // second extension has a collision with no way to find the first.
    points.define(POINT, { owner: 'shepherd.agents-core' });
    let caught: unknown;
    try {
      points.define(POINT, { owner: 'acme.impostor' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DuplicatePointError);
    expect((caught as DuplicatePointError).owner).toBe('shepherd.agents-core');
    expect((caught as Error).message).toContain('shepherd.agents-core');
  });

  it('forgets the owner once the point is disposed', () => {
    // `ownerOf` is what the host's dependency gate reads, so a stale owner would
    // gate access to a seam that no longer exists.
    points.define(POINT, { owner: 'shepherd.agents-core' }).dispose();
    expect(points.ownerOf(POINT)).toBeUndefined();
  });

  it('an owner-less point is defined and reachable, just unattributed', () => {
    // The kernel and a test define points without being an extension; ownership is
    // for the host's gate, not a precondition of the primitive.
    points.define(POINT);
    expect(points.get(POINT)?.id).toBe(POINT);
    expect(points.ownerOf(POINT)).toBeUndefined();
  });
});

describe('disposeOwnedBy', () => {
  it('drops every point an extension defined, and nothing else', () => {
    points.define('agents-core.kinds', { owner: 'shepherd.agents-core' });
    points.define('agents-core.transports', { owner: 'shepherd.agents-core' });
    points.define('tasks.repoSuggestions', { owner: 'shepherd.tasks' });

    points.disposeOwnedBy('shepherd.agents-core');

    expect(points.get('agents-core.kinds')).toBeUndefined();
    expect(points.get('agents-core.transports')).toBeUndefined();
    // The negative control: a sweep that took everything would pass every
    // assertion above and be wrong.
    expect(points.get('tasks.repoSuggestions')?.id).toBe('tasks.repoSuggestions');
  });

  it('frees the ids, so the same extension can activate again', () => {
    // An `activate` that defines a point and then throws is rolled back by the
    // host; without this the retry dies on DuplicatePointError instead.
    points.define(POINT, { owner: 'shepherd.agents-core' });
    points.disposeOwnedBy('shepherd.agents-core');
    expect(() => points.define(POINT, { owner: 'shepherd.agents-core' })).not.toThrow();
  });

  it('is a no-op for an extension that defined none', () => {
    points.define(POINT, { owner: 'shepherd.agents-core' });
    expect(() => points.disposeOwnedBy('acme.nothing')).not.toThrow();
    expect(points.get(POINT)?.id).toBe(POINT);
  });
});

describe('register and all', () => {
  it('keeps registration order when no priority is given', () => {
    const point = points.define<AgentKind>(POINT);
    point.register(claude);
    point.register(codex);
    expect(ids(point)).toEqual(['claude-code', 'codex']);
    expect(point.first()).toBe(claude);
  });

  it('is highest priority first', () => {
    const point = points.define<AgentKind>(POINT);
    point.register(claude, { priority: 1 });
    point.register(codex, { priority: 10 });
    point.register(opencode, { priority: 5 });
    expect(ids(point)).toEqual(['codex', 'opencode', 'claude-code']);
    expect(point.first()).toBe(codex);
  });

  it('breaks a tie by registration order, stably', () => {
    // Two providers at the same priority must not swap between calls: `first()` is
    // a behavioural choice (which agent kind runs), and a nondeterministic one is
    // a bug that reproduces on somebody else's machine.
    const point = points.define<AgentKind>(POINT);
    point.register(claude, { priority: 5 });
    point.register(codex, { priority: 5 });
    point.register(opencode, { priority: 5 });
    expect(ids(point)).toEqual(['claude-code', 'codex', 'opencode']);
    expect(ids(point)).toEqual(['claude-code', 'codex', 'opencode']);
  });

  it('treats an absent priority as 0, so a negative one sorts last', () => {
    const point = points.define<AgentKind>(POINT);
    point.register(claude, { priority: -1 });
    point.register(codex);
    expect(ids(point)).toEqual(['codex', 'claude-code']);
  });

  it('returns a copy — a caller cannot reorder the point by sorting what it got', () => {
    const point = points.define<AgentKind>(POINT);
    point.register(claude);
    const first = point.all() as AgentKind[];
    first.push(codex);
    expect(ids(point)).toEqual(['claude-code']);
  });

  it('accepts the same provider twice and treats them as two registrations', () => {
    const point = points.define<AgentKind>(POINT);
    const one = point.register(claude);
    point.register(claude);
    expect(point.all()).toHaveLength(2);
    // Identity-checked disposal: the late dispose of one registration must not take
    // the other's, even though the provider VALUE is the same object.
    one.dispose();
    expect(point.all()).toEqual([claude]);
  });
});

describe('order: registration', () => {
  it('ignores priority entirely', () => {
    // An explicit choice by the point's author: "these run in the order they were
    // added" is a real contract (a middleware chain), and honouring priority in it
    // would silently reorder somebody's pipeline.
    const point = points.define<AgentKind>(POINT, { order: 'registration' });
    point.register(claude, { priority: 1 });
    point.register(codex, { priority: 99 });
    expect(ids(point)).toEqual(['claude-code', 'codex']);
    expect(point.first()).toBe(claude);
  });

  it('priority is the default', () => {
    const explicit = points.define<AgentKind>('a.b', { order: 'priority' });
    const implicit = points.define<AgentKind>('c.d');
    for (const point of [explicit, implicit]) {
      point.register(claude, { priority: 1 });
      point.register(codex, { priority: 9 });
      expect(ids(point)).toEqual(['codex', 'claude-code']);
    }
  });
});

describe('disposal', () => {
  it('disposing a registration removes just that provider', () => {
    const point = points.define<AgentKind>(POINT);
    const registration = point.register(claude);
    point.register(codex);
    registration.dispose();
    expect(ids(point)).toEqual(['codex']);
  });

  it('disposing a registration twice is a no-op', () => {
    const point = points.define<AgentKind>(POINT);
    const registration = point.register(claude);
    registration.dispose();
    registration.dispose();
    expect(point.all()).toEqual([]);
  });

  it('disposing the point makes get return undefined', () => {
    // The host disposes an extension's points on deactivate (they go in
    // `ctx.subscriptions`), which is how the SDK's "undefined if its owner is not
    // active" holds: the point and its owner entry go together, so there is still
    // one answer to whether the seam is live.
    const point = points.define<AgentKind>(POINT);
    point.register(claude);
    point.dispose();
    expect(points.get(POINT)).toBeUndefined();
  });

  it('a disposed point holds no providers', () => {
    const point = points.define<AgentKind>(POINT);
    point.register(claude);
    point.dispose();
    expect(point.all()).toEqual([]);
    expect(point.first()).toBeUndefined();
  });

  it('registering into a disposed point is refused WITH a line, not silently dropped', () => {
    // A provider that registered into a dead seam is the silent-no-op class: the
    // extension believes it contributed, the owner never sees it, and nothing says
    // so. This is the ordering trap in the real host — an extension activating
    // while its dependency is being torn down.
    const point = points.define<AgentKind>(POINT);
    point.dispose();
    const registration = point.register(claude);
    expect(point.all()).toEqual([]);
    expect(messages().some((m) => m.includes(POINT) && m.includes('disposed'))).toBe(true);
    expect(() => registration.dispose()).not.toThrow();
  });

  it('disposing the point twice is a no-op', () => {
    const point = points.define<AgentKind>(POINT);
    point.dispose();
    expect(() => point.dispose()).not.toThrow();
  });

  it('disposing the registry drops every point', () => {
    points.define(POINT);
    points.define('tasks.repoSuggestions');
    points.dispose();
    expect(points.get(POINT)).toBeUndefined();
    expect(points.get('tasks.repoSuggestions')).toBeUndefined();
  });
});

describe('providers are opaque', () => {
  it('a function provider works as well as an object one', () => {
    // Nothing here inspects a provider. The point is a typed list; what a provider
    // IS belongs to the extension that defined the seam.
    const point = points.define<(input: string) => string>('tasks.repoSuggestions');
    point.register((input) => input.toUpperCase(), { priority: 1 });
    expect(point.first()?.('shepherd')).toBe('SHEPHERD');
  });

  it('two points with different ids do not see each other', () => {
    const kinds = points.define<AgentKind>(POINT);
    const other = points.define<AgentKind>('tasks.repoSuggestions');
    kinds.register(claude);
    expect(other.all()).toEqual([]);
  });
});
