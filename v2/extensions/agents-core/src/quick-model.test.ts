import { describe, expect, it } from 'vitest';
import type { AgentKind } from './kind.ts';
import { applyOverride, describeQuick, resolveQuick } from './quick-model.ts';

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
