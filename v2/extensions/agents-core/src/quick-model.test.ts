import { describe, expect, it } from 'vitest';
import type { KV, SettingsAPI } from '@shepherd/sdk';
import type { AgentKind } from './kind.ts';
import {
  applyOverride,
  describeQuick,
  migrateQuickOverride,
  overrideFromSettings,
  quickChoices,
  resolveQuick,
} from './quick-model.ts';

/**
 * Which kind and which model serve the quick tier.
 *
 * The case worth naming is the last one: a configured kind that is not present
 * resolves to NOTHING rather than to somebody else's vendor. Falling back would
 * spend the user's model budget on a vendor they explicitly did not choose, and
 * the only evidence would be a bill.
 */

const kind = (id: string, quickModel?: string): AgentKind => ({
  id,
  topics: [],
  reduce: () => ({ kind: 'ignore', why: 'not under test' }),
  ...(quickModel === undefined
    ? {}
    : { headless: { quickModel, argv: () => [], parse: (out: string) => out } }),
});

describe('resolveQuick', () => {
  it('has no answer when nothing is registered', () => {
    expect(resolveQuick([], undefined)).toBeUndefined();
  });

  it('ignores a kind with no headless half', () => {
    expect(resolveQuick([kind('interactive-only')], undefined)).toBeUndefined();
  });

  it('takes the first capable kind, in the order the point handed them over', () => {
    const target = resolveQuick([kind('a', 'model-a'), kind('b', 'model-b')], undefined);
    expect(target?.kind.id).toBe('a');
    expect(target?.model).toBe('model-a');
  });

  it('skips an incapable kind ahead of a capable one', () => {
    const target = resolveQuick([kind('interactive-only'), kind('b', 'model-b')], undefined);
    expect(target?.kind.id).toBe('b');
  });

  it('lets the override name the model without naming the kind', () => {
    const target = resolveQuick([kind('a', 'model-a')], { model: 'something-cheaper' });
    expect(target?.kind.id).toBe('a');
    expect(target?.model).toBe('something-cheaper');
  });

  it('lets the override name the kind', () => {
    const target = resolveQuick([kind('a', 'model-a'), kind('b', 'model-b')], { kind: 'b' });
    expect(target?.kind.id).toBe('b');
    expect(target?.model).toBe('model-b');
  });

  it('answers nothing when the configured kind is absent, rather than another vendor', () => {
    expect(resolveQuick([kind('a', 'model-a')], { kind: 'gone' })).toBeUndefined();
  });

  it('answers nothing when the configured kind exists but cannot do this', () => {
    // Naming an interactive-only kind is the same mistake as naming an absent
    // one, and it must fail the same way rather than silently using `a`.
    expect(resolveQuick([kind('a', 'model-a'), kind('b')], { kind: 'b' })).toBeUndefined();
  });
});

describe('applyOverride', () => {
  it('sets a model without forgetting a kind that was already chosen', () => {
    // The verb takes either field, so a merge rather than a replace: setting the
    // model must not silently move the user back to the default vendor.
    expect(applyOverride({ kind: 'b' }, { model: 'model-cheap' })).toEqual({ kind: 'b', model: 'model-cheap' });
  });

  it('sets a kind without forgetting a model', () => {
    expect(applyOverride({ model: 'model-cheap' }, { kind: 'b' })).toEqual({ kind: 'b', model: 'model-cheap' });
  });

  it('starts from nothing', () => {
    expect(applyOverride(undefined, { model: 'model-cheap' })).toEqual({ model: 'model-cheap' });
  });

  it('clears everything, back to whatever the kind declares', () => {
    expect(applyOverride({ kind: 'b', model: 'model-cheap' }, { clear: true })).toBeUndefined();
  });

  it('clears even when a field is given alongside, because clear is the louder word', () => {
    expect(applyOverride({ kind: 'b' }, { clear: true, model: 'ignored' })).toBeUndefined();
  });

  it('changes nothing when asked nothing — the read form of the verb', () => {
    const current = { kind: 'b', model: 'model-cheap' };
    expect(applyOverride(current, {})).toEqual(current);
  });
});

describe('describeQuick', () => {
  it('reports the EFFECTIVE resolution, not the stored override', () => {
    // What a user wants to know from `shepherd agent quick-model` is which model
    // will actually run — an override echoed back answers a different question.
    expect(describeQuick([kind('a', 'model-a')], undefined)).toEqual({
      kind: 'a',
      model: 'model-a',
      override: null,
      available: ['a'],
    });
  });

  it('says what is available, so a rejected kind id is diagnosable', () => {
    // The pair that matters: `kind: null` because the configured one is absent,
    // beside the list of ones that are not.
    expect(describeQuick([kind('a', 'model-a'), kind('b')], { kind: 'gone' })).toEqual({
      kind: null,
      model: null,
      override: { kind: 'gone' },
      available: ['a'],
    });
  });
});


// -------------------------------------------------------------- as settings

describe('overrideFromSettings', () => {
  it('reads kind and model from the two settings keys', () => {
    expect(
      overrideFromSettings({ 'agents-core.quickKind': 'claude-code', 'agents-core.quickModel': 'opus' }),
    ).toEqual({ kind: 'claude-code', model: 'opus' });
  });

  it('reads null as ABSENT, so the extension own fallback still applies', () => {
    // `null` is a nullable spec's "unset" — whichever capable kind is first,
    // whatever that kind advertises. Passed through as a kind id it would resolve
    // to no agent at all, and a quick call would fail as though the user had
    // chosen a vendor that is not installed.
    expect(overrideFromSettings({ 'agents-core.quickKind': null, 'agents-core.quickModel': null })).toBeUndefined();
  });

  it('keeps a model choice when only the kind is unset', () => {
    expect(overrideFromSettings({ 'agents-core.quickKind': null, 'agents-core.quickModel': 'opus' })).toEqual({
      model: 'opus',
    });
  });

  it('ignores an empty string, which is not a choice', () => {
    expect(overrideFromSettings({ 'agents-core.quickKind': '', 'agents-core.quickModel': '' })).toBeUndefined();
  });
});

describe('quickChoices', () => {
  const kind = (id: string, models?: readonly string[]) =>
    ({
      id,
      topics: [],
      reduce: () => ({ kind: 'ignore', why: 'test' }),
      headless: {
        quickModel: `${id}-default`,
        ...(models === undefined ? {} : { quickModels: models }),
        argv: () => [],
        parse: () => undefined,
      },
    }) as unknown as AgentKind;

  it('offers every capable kind for the kind row', () => {
    const choices = quickChoices([kind('one'), kind('two')], 'agents-core.quickKind');
    expect(choices.map((choice) => choice.value)).toEqual(['one', 'two']);
  });

  it('offers what each vendor ADVERTISES for the model row, named by its kind', () => {
    const choices = quickChoices([kind('one', ['a', 'b'])], 'agents-core.quickModel');
    expect(choices).toEqual([
      { value: 'a', label: 'a', description: 'one' },
      { value: 'b', label: 'b', description: 'one' },
    ]);
  });

  it('falls back to the single model a kind advertising none must serve', () => {
    expect(quickChoices([kind('one')], 'agents-core.quickModel')).toEqual([
      { value: 'one-default', label: 'one-default', description: 'one' },
    ]);
  });

  it('offers nothing from a kind that cannot answer a prompt at all', () => {
    const interactive = { id: 'gui', topics: [], reduce: () => ({ kind: 'ignore', why: 'test' }) } as unknown as AgentKind;
    expect(quickChoices([interactive], 'agents-core.quickModel')).toEqual([]);
  });
});

describe('migrateQuickOverride', () => {
  function fakeKv(seed: Record<string, unknown>) {
    const map = new Map(Object.entries(seed));
    const deleted: string[] = [];
    return {
      deleted,
      kv: {
        get: <T,>(key: string, schema: { parse(value: unknown): { ok: boolean; value?: T } }) => {
          if (!map.has(key)) return undefined;
          const parsed = schema.parse(map.get(key));
          return parsed.ok ? (parsed.value as T) : undefined;
        },
        set: (key: string, value: unknown) => void map.set(key, value),
        delete: (key: string) => {
          deleted.push(key);
          map.delete(key);
        },
        keys: () => [...map.keys()],
      } as unknown as KV,
    };
  }

  function fakeSettings() {
    const writes: [string, unknown][] = [];
    return {
      writes,
      api: {
        get: () => null,
        set: async (key: string, value: unknown) => {
          writes.push([key, value]);
          return { ok: true as const, value: undefined };
        },
        onDidChange: () => ({ dispose: () => {} }),
      } as unknown as SettingsAPI,
    };
  }

  it('moves a pre-settings override into settings and deletes the key', async () => {
    const store = fakeKv({ 'quick-model': { kind: 'claude-code', model: 'opus' } });
    const settings = fakeSettings();
    await migrateQuickOverride(store.kv, settings.api, {});
    expect(settings.writes).toEqual([
      ['agents-core.quickKind', 'claude-code'],
      ['agents-core.quickModel', 'opus'],
    ]);
    expect(store.deleted).toEqual(['quick-model']);
  });

  it('does nothing on a second run, because the key is gone', async () => {
    const store = fakeKv({});
    const settings = fakeSettings();
    await migrateQuickOverride(store.kv, settings.api, {});
    expect(settings.writes).toEqual([]);
    expect(store.deleted).toEqual([]);
  });

  it('does not overwrite a value the user has already chosen', async () => {
    const store = fakeKv({ 'quick-model': { model: 'opus' } });
    const settings = fakeSettings();
    await migrateQuickOverride(store.kv, settings.api, { 'agents-core.quickModel': 'haiku' });
    expect(settings.writes).toEqual([]);
    // The stale key goes anyway, or the migration runs on every launch forever.
    expect(store.deleted).toEqual(['quick-model']);
  });

  it('drops a malformed blob rather than throwing during activation', async () => {
    const store = fakeKv({ 'quick-model': 'not an object' });
    const settings = fakeSettings();
    await expect(migrateQuickOverride(store.kv, settings.api, {})).resolves.toBeUndefined();
    expect(settings.writes).toEqual([]);
  });
});
