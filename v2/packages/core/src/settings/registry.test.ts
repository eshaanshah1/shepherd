import { beforeEach, describe, expect, it } from 'vitest';
import { nullLogger, type SettingsPage } from '@shepherd/sdk';
import { SqliteStore } from '../storage/store.ts';
import { SettingsRegistry } from './registry.ts';

const PAGE: SettingsPage = {
  id: 'agents.models',
  title: 'Models',
  settings: [
    { key: 'agents-core.quickModel', type: 'string', label: 'Model', default: 'sonnet' },
    { key: 'agents-core.quickKind', type: 'enum', label: 'Kind', default: null, nullable: true, choicesFrom: 'k' },
  ],
};

const GENERAL: SettingsPage = {
  id: 'general',
  title: 'General',
  order: 0,
  settings: [
    {
      key: 'shepherd.theme',
      type: 'enum',
      label: 'Theme',
      default: 'system',
      choices: [{ value: 'system', label: 'System' }],
    },
  ],
};

let store: SqliteStore;
let registry: SettingsRegistry;

beforeEach(() => {
  store = new SqliteStore({ location: ':memory:', logger: nullLogger });
  registry = new SettingsRegistry({ store, logger: nullLogger });
  registry.contribute('shepherd.agents-core', [PAGE]);
});

describe('effective values', () => {
  it('reads an untouched key as its declared default', () => {
    expect(registry.get('agents-core.quickModel')).toBe('sonnet');
    expect(registry.isDefault('agents-core.quickModel')).toBe(true);
  });

  it('stores a changed value and reads it back', () => {
    expect(registry.set('agents-core.quickModel', 'opus').ok).toBe(true);
    expect(registry.get('agents-core.quickModel')).toBe('opus');
    expect(registry.isDefault('agents-core.quickModel')).toBe(false);
  });

  it('answers undefined for a key nobody declared, rather than guessing', () => {
    expect(registry.get('agents-core.nope')).toBeUndefined();
  });

  it('keeps an explicit null distinct from "nothing stored"', () => {
    // The nullable spec's default IS null, so storing null is storing the
    // default — which deletes the row. Both read back as null, and `isDefault`
    // is the only thing that can tell them apart.
    expect(registry.set('agents-core.quickKind', null).ok).toBe(true);
    expect(registry.get('agents-core.quickKind')).toBeNull();
    expect(registry.isDefault('agents-core.quickKind')).toBe(true);
  });
});

describe('storing only what differs', () => {
  it('DELETES the row when a write equals the default, so a changed default still reaches this install', () => {
    registry.set('agents-core.quickModel', 'opus');
    registry.set('agents-core.quickModel', 'sonnet');
    expect(registry.isDefault('agents-core.quickModel')).toBe(true);

    // The proof, and the reason defaults are not materialized: a build that
    // ships a different default now wins over the same file.
    const second = new SettingsRegistry({ store, logger: nullLogger });
    second.contribute('shepherd.agents-core', [
      { ...PAGE, settings: [{ key: 'agents-core.quickModel', type: 'string', label: 'Model', default: 'haiku' }] },
    ]);
    expect(second.get('agents-core.quickModel')).toBe('haiku');
  });

  it('a value the user DID change survives a changed default', () => {
    registry.set('agents-core.quickModel', 'opus');
    const second = new SettingsRegistry({ store, logger: nullLogger });
    second.contribute('shepherd.agents-core', [
      { ...PAGE, settings: [{ key: 'agents-core.quickModel', type: 'string', label: 'Model', default: 'haiku' }] },
    ]);
    expect(second.get('agents-core.quickModel')).toBe('opus');
  });
});

describe('writes', () => {
  it('refuses an unknown key rather than storing an orphan', () => {
    const result = registry.set('agents-core.nope', 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-key');
  });

  it('refuses a value its spec refuses', () => {
    const result = registry.set('agents-core.quickModel', 7);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('reset returns to the default and clears the row', () => {
    registry.set('agents-core.quickModel', 'opus');
    expect(registry.reset('agents-core.quickModel')).toEqual({ ok: true, value: 'sonnet' });
    expect(registry.isDefault('agents-core.quickModel')).toBe(true);
  });
});

describe('change notification', () => {
  it('fires per key, with the effective value', () => {
    const seen: [string, unknown][] = [];
    registry.onDidChange((key, value) => seen.push([key, value]));
    registry.set('agents-core.quickModel', 'opus');
    registry.reset('agents-core.quickModel');
    expect(seen).toEqual([
      ['agents-core.quickModel', 'opus'],
      ['agents-core.quickModel', 'sonnet'],
    ]);
  });

  it('does not fire when the value did not change', () => {
    const seen: string[] = [];
    registry.onDidChange((key) => seen.push(key));
    registry.set('agents-core.quickModel', 'sonnet');
    expect(seen).toEqual([]);
  });

  it('one throwing subscriber does not stop the others from learning', () => {
    const seen: string[] = [];
    registry.onDidChange(() => {
      throw new Error('no');
    });
    registry.onDidChange((key) => seen.push(key));
    registry.set('agents-core.quickModel', 'opus');
    expect(seen).toEqual(['agents-core.quickModel']);
  });
});

describe('contributions', () => {
  it('refuses a page whose keys are outside the declaring namespace, and contributes none of it', () => {
    expect(() =>
      registry.contribute('shepherd.tasks', [
        { id: 'p', title: 'P', settings: [{ key: 'claudeCode.model', type: 'string', label: 'M', default: '' }] },
      ]),
    ).toThrow(/claudeCode\.model/);
    expect(registry.pages().some((page) => page.id === 'p')).toBe(false);
  });

  it('refuses a key another page already declared', () => {
    expect(() =>
      registry.contribute('shepherd.agents-core-2', [
        {
          id: 'dupe',
          title: 'Dupe',
          settings: [{ key: 'agents-core-2.x', type: 'string', label: 'X', default: '' }],
        },
      ]),
    ).not.toThrow();
    expect(() =>
      registry.contribute('shepherd.agents-core-3', [
        {
          id: 'dupe2',
          title: 'Dupe2',
          settings: [{ key: 'agents-core-2.x', type: 'string', label: 'X', default: '' }],
        },
      ]),
    ).toThrow(/already declared/);
  });

  it('hands a namespace exactly its own effective values, plus nothing else', () => {
    registry.contribute('shepherd', [GENERAL]);
    registry.set('agents-core.quickModel', 'opus');
    expect(registry.values('agents-core')).toEqual({
      'agents-core.quickModel': 'opus',
      'agents-core.quickKind': null,
    });
    expect(registry.values('shepherd')).toEqual({ 'shepherd.theme': 'system' });
  });

  it('forgets a disposed contribution, keys and all', () => {
    const disposable = registry.contribute('shepherd.worktree-hook', [
      { id: 'w', title: 'Hooks', component: 'worktree-hook.editor' },
    ]);
    expect(registry.pages().some((page) => page.id === 'w')).toBe(true);
    disposable.dispose();
    expect(registry.pages().some((page) => page.id === 'w')).toBe(false);
  });

  it('sorts by order then title, and a page with no order sorts last', () => {
    registry.contribute('shepherd', [GENERAL]);
    registry.contribute('shepherd.zeta', [{ id: 'zeta', title: 'Zeta', order: 10, component: 'x' }]);
    expect(registry.pages().map((page) => page.id)).toEqual(['general', 'zeta', 'agents.models']);
  });
});
