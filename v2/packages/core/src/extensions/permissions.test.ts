import { beforeEach, describe, expect, it } from 'vitest';
import {
  createLogger,
  extensionId,
  manualClock,
  type ExtensionID,
  type KV,
  type LogRecord,
  type Logger,
  type Manifest,
  type Permission,
} from '@shepherd/sdk';
import { authorize } from '../commands/authorize.ts';
import { SqliteStore } from '../storage/store.ts';
import { permissionDiff, PermissionStore } from './permissions.ts';

const TASKS = extensionId('shepherd.tasks');
const CLAUDE = extensionId('shepherd.claude-code');

let records: LogRecord[];
let logger: Logger;
let kv: KV;

beforeEach(() => {
  records = [];
  logger = createLogger({ clock: manualClock(0), level: 'debug', sink: (_l, r) => records.push(r) });
  // The real `KV`, not a double: the "a stored grant that no longer validates reads
  // as absent" rule IS `NamespacedKV`'s discipline, and a double would let this
  // suite pass while the real read path threw.
  kv = new SqliteStore({ location: ':memory:', logger }).namespace('extensions.permissions');
});

const messages = () => records.map((r) => r.message);
const store = () => new PermissionStore(kv, logger);

function manifest(patch: Partial<Manifest> = {}): Manifest {
  return {
    id: 'shepherd.tasks',
    name: 'Tasks',
    version: '0.1.0',
    api: '^1.0.0',
    activation: ['onStartup'],
    permissions: ['storage'],
    ...patch,
  };
}

describe('permissionDiff', () => {
  it('names what an update added', () => {
    expect(permissionDiff(['storage'], ['storage', 'process.exec'])).toEqual({
      added: ['process.exec'],
      removed: [],
      needsReview: true,
    });
  });

  it('names what an update dropped', () => {
    expect(permissionDiff(['storage', 'network'], ['storage'])).toEqual({
      added: [],
      removed: ['network'],
      needsReview: false,
    });
  });

  it('needsReview is true IFF something was added', () => {
    // §7b: review-at-install, grant once — a capability added by an update
    // re-prompts, one asking for the same or fewer does not. Removing a permission
    // is not a review event: nothing new can happen to the user because of it, and
    // a prompt that fires when an extension asks for LESS trains people to click
    // through prompts without reading.
    expect(permissionDiff([], []).needsReview).toBe(false);
    expect(permissionDiff(['storage'], ['storage']).needsReview).toBe(false);
    expect(permissionDiff(['storage', 'network'], []).needsReview).toBe(false);
    expect(permissionDiff([], ['storage']).needsReview).toBe(true);
  });

  it('is a review when an update both adds and removes', () => {
    expect(permissionDiff(['network'], ['storage'])).toEqual({
      added: ['storage'],
      removed: ['network'],
      needsReview: true,
    });
  });

  it('ignores order — these are sets, not lists', () => {
    expect(permissionDiff(['storage', 'network'], ['network', 'storage'])).toEqual({
      added: [],
      removed: [],
      needsReview: false,
    });
  });

  it('collapses duplicates on either side', () => {
    expect(permissionDiff(['storage', 'storage'], ['storage'])).toEqual({
      added: [],
      removed: [],
      needsReview: false,
    });
    expect(permissionDiff([], ['storage', 'storage']).added).toEqual(['storage']);
  });

  it('is pure — it does not mutate either argument', () => {
    const granted: Permission[] = ['storage'];
    const requested: Permission[] = ['network'];
    permissionDiff(granted, requested);
    expect(granted).toEqual(['storage']);
    expect(requested).toEqual(['network']);
  });
});

describe('grant / granted / revoke', () => {
  it('round-trips a grant', () => {
    const permissions = store();
    permissions.grant(TASKS, ['storage', 'sessions']);
    expect(permissions.granted(TASKS)).toEqual(['sessions', 'storage']);
  });

  it('an extension nobody granted anything holds nothing', () => {
    expect(store().granted(TASKS)).toEqual([]);
    expect(store().isGranted(TASKS, 'storage')).toBe(false);
  });

  it('isGranted answers per permission', () => {
    const permissions = store();
    permissions.grant(TASKS, ['storage']);
    expect(permissions.isGranted(TASKS, 'storage')).toBe(true);
    expect(permissions.isGranted(TASKS, 'process.exec')).toBe(false);
  });

  it('stores canonically — deduped and in the declared PERMISSIONS order', () => {
    // So a stored set has one representation. Two orderings of the same grant
    // would make every later comparison order-dependent, and a diff is the thing
    // that decides whether the user sees a prompt.
    const permissions = store();
    permissions.grant(TASKS, ['storage', 'sessions', 'storage']);
    expect(permissions.granted(TASKS)).toEqual(['sessions', 'storage']);
  });

  it('a grant survives a new store over the same KV', () => {
    store().grant(TASKS, ['storage']);
    expect(store().granted(TASKS)).toEqual(['storage']);
  });

  it('revoke removes the grant and says so', () => {
    const permissions = store();
    permissions.grant(TASKS, ['storage']);
    permissions.revoke(TASKS);
    expect(permissions.granted(TASKS)).toEqual([]);
    expect(store().granted(TASKS)).toEqual([]);
    expect(messages().some((m) => m.includes('revoked') && m.includes('shepherd.tasks'))).toBe(true);
  });

  it('revoking nothing is not an error', () => {
    expect(() => store().revoke(TASKS)).not.toThrow();
  });

  it('a stored grant that no longer validates reads as absent, WITH a line', () => {
    // The `KV` discipline: the value on disk was written by an earlier build and
    // the reader is the only one who knows what it expects today. A blob that fails
    // validation must not throw on a load path — but it must not be silent either,
    // because "the extension lost its permissions" is otherwise unanswerable.
    kv.set('shepherd.tasks', ['storage', 'telepathy']);
    const permissions = store();
    expect(permissions.granted(TASKS)).toEqual([]);
    expect(messages().some((m) => m.includes('shepherd.tasks') && m.includes('did not validate'))).toBe(true);
  });

  it('a grant of an unknown permission cannot be written in the first place', () => {
    // Belt and braces: `grant` takes `Permission[]` at the type level, and this is
    // the runtime half for a value that arrived from a transport.
    const permissions = store();
    permissions.grant(TASKS, ['storage', 'telepathy' as Permission]);
    expect(permissions.granted(TASKS)).toEqual(['storage']);
    expect(messages().some((m) => m.includes('telepathy'))).toBe(true);
  });
});

describe('grantSet — the shape `authorize` consumes', () => {
  it('populates extensions and leaves devices and agents empty', () => {
    // Devices arrive with the remote layer and agents with the agent layer; an
    // empty map is the honest statement that neither exists yet, and `authorize`
    // already reads an absent principal as "unknown", not as "allowed".
    const permissions = store();
    permissions.grant(TASKS, ['storage']);
    permissions.grant(CLAUDE, ['sessions', 'agents']);
    const grants = permissions.grantSet();
    expect([...grants.extensions.entries()]).toEqual([
      [CLAUDE, ['sessions', 'agents']],
      [TASKS, ['storage']],
    ]);
    expect(grants.devices.size).toBe(0);
    expect(grants.agents.size).toBe(0);
  });

  it('is what authorize reads a real verdict out of', () => {
    const permissions = store();
    permissions.grant(TASKS, ['storage']);
    const grants = permissions.grantSet();
    expect(authorize({ kind: 'extension', id: TASKS }, 'storage', grants)).toEqual({ allowed: true });
    expect(authorize({ kind: 'extension', id: TASKS }, 'process.exec', grants).allowed).toBe(false);
    // Not in the map at all: a claim rather than a fact.
    expect(authorize({ kind: 'extension', id: CLAUDE }, undefined, grants).allowed).toBe(false);
  });

  it('an extension granted nothing is still a known principal', () => {
    // `grant(id, [])` is a real fact — the user reviewed an extension that asked
    // for nothing — and it must not read as "not installed", or a permission-free
    // extension could not invoke a permission-free command.
    const permissions = store();
    permissions.grant(TASKS, []);
    expect(authorize({ kind: 'extension', id: TASKS }, undefined, permissions.grantSet())).toEqual({ allowed: true });
  });

  it('skips a corrupt row rather than failing the whole set', () => {
    const permissions = store();
    permissions.grant(TASKS, ['storage']);
    kv.set('shepherd.broken', 'not-an-array');
    const grants = permissions.grantSet();
    expect([...grants.extensions.keys()]).toEqual([TASKS]);
    expect(messages().some((m) => m.includes('shepherd.broken'))).toBe(true);
  });
});

describe('review — the one place `source` decides a grant', () => {
  it('pre-grants a built-in everything it declares, with no user action', () => {
    // §7: built-ins ship inside the app and are the proving ground for proposed
    // APIs. The user already trusts the app; a prompt for a capability they cannot
    // decline without breaking the product is a prompt that teaches nothing.
    const permissions = store();
    const outcome = permissions.review(manifest({ permissions: ['sessions', 'attention'] }), 'builtin');
    expect(outcome).toEqual({ granted: true, needsReview: false, added: ['sessions', 'attention'], removed: [] });
    expect(permissions.granted(TASKS)).toEqual(['sessions', 'attention']);
  });

  it('leaves a user extension ungranted until somebody reviews it', () => {
    const permissions = store();
    const outcome = permissions.review(manifest({ permissions: ['storage'] }), 'user');
    expect(outcome).toEqual({ granted: false, needsReview: true, added: ['storage'], removed: [] });
    expect(permissions.granted(TASKS)).toEqual([]);
    expect(permissions.isGranted(TASKS, 'storage')).toBe(false);
  });

  it('does NOT silently widen an existing grant when an update asks for more', () => {
    // The negative control for grant-once: the second review must leave the old,
    // narrower grant exactly as it was. A store that wrote the requested set here
    // would make the re-prompt cosmetic.
    const permissions = store();
    permissions.grant(TASKS, ['storage']);
    const outcome = permissions.review(manifest({ permissions: ['storage', 'process.exec'] }), 'user');
    expect(outcome).toMatchObject({ granted: false, needsReview: true, added: ['process.exec'] });
    expect(permissions.granted(TASKS)).toEqual(['storage']);
  });

  it('an update asking for the same set does not re-prompt', () => {
    const permissions = store();
    permissions.grant(TASKS, ['storage', 'network']);
    const outcome = permissions.review(manifest({ permissions: ['network', 'storage'] }), 'user');
    expect(outcome).toEqual({ granted: true, needsReview: false, added: [], removed: [] });
    expect(permissions.granted(TASKS)).toEqual(['storage', 'network']);
  });

  it('an update asking for FEWER narrows the grant without a prompt', () => {
    // The grant follows the manifest down. Keeping a permission the extension no
    // longer declares would leave a capability nothing asked for and nothing shows.
    const permissions = store();
    permissions.grant(TASKS, ['storage', 'network']);
    const outcome = permissions.review(manifest({ permissions: ['storage'] }), 'user');
    expect(outcome).toEqual({ granted: true, needsReview: false, added: [], removed: ['network'] });
    expect(permissions.granted(TASKS)).toEqual(['storage']);
    expect(permissions.isGranted(TASKS, 'network')).toBe(false);
  });

  it('a user extension that asks for nothing is granted with no prompt', () => {
    const permissions = store();
    expect(permissions.review(manifest({ permissions: [] }), 'user')).toEqual({
      granted: true,
      needsReview: false,
      added: [],
      removed: [],
    });
    expect(authorize({ kind: 'extension', id: TASKS }, undefined, permissions.grantSet())).toEqual({ allowed: true });
  });

  it('logs the outcome either way', () => {
    const permissions = store();
    permissions.review(manifest(), 'builtin');
    permissions.review(manifest({ id: 'shepherd.claude-code', permissions: ['agents'] }), 'user');
    expect(messages().some((m) => m.includes('shepherd.tasks') && m.includes('builtin'))).toBe(true);
    expect(messages().some((m) => m.includes('shepherd.claude-code') && m.includes('review'))).toBe(true);
  });
});

describe('a built-in can still be denied', () => {
  it('revoke takes effect immediately, for a built-in as much as anyone', () => {
    // Pre-granting is an install-time decision, not a bypass in the authorization
    // path: there is exactly one path, and it reads the store.
    const permissions = store();
    permissions.review(manifest({ permissions: ['sessions'] }), 'builtin');
    permissions.revoke(TASKS);
    expect(permissions.isGranted(TASKS, 'sessions')).toBe(false);
    expect(authorize({ kind: 'extension', id: TASKS }, 'sessions', permissions.grantSet()).allowed).toBe(false);
  });

  it('but the next review pre-grants it again, and that is deliberate', () => {
    // A built-in that stayed denied across a relaunch would leave the app partly
    // broken with no UI in M1 to put it back. Recorded as a judgement call: a
    // revoked built-in is denied for this run, not forever.
    const permissions = store();
    permissions.review(manifest({ permissions: ['sessions'] }), 'builtin');
    permissions.revoke(TASKS);
    permissions.review(manifest({ permissions: ['sessions'] }), 'builtin');
    expect(permissions.isGranted(TASKS, 'sessions')).toBe(true);
  });
});

describe('missing — what an activation gate reports', () => {
  it('lists the declared permissions that are not granted', () => {
    const permissions = store();
    permissions.grant(TASKS, ['storage']);
    expect(permissions.missing(manifest({ permissions: ['storage', 'process.exec', 'network'] }))).toEqual([
      'process.exec',
      'network',
    ]);
  });

  it('is empty for a fully granted extension', () => {
    const permissions = store();
    permissions.review(manifest({ permissions: ['storage'] }), 'builtin');
    expect(permissions.missing(manifest({ permissions: ['storage'] }))).toEqual([]);
  });
});

describe('id handling', () => {
  it('keys by the extension id, so two extensions do not share a grant', () => {
    const permissions = store();
    permissions.grant(TASKS, ['storage']);
    expect(permissions.granted(CLAUDE)).toEqual([]);
  });

  it('hands back branded ids in grantSet, which is what GrantSet is typed on', () => {
    const permissions = store();
    permissions.grant(TASKS, ['storage']);
    const keys: ExtensionID[] = [...permissions.grantSet().extensions.keys()];
    expect(keys).toEqual([TASKS]);
  });
});
