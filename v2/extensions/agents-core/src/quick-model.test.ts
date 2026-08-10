import { describe, expect, it } from 'vitest';
import type { AgentKind } from './kind.ts';
import { resolveQuick } from './quick-model.ts';

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
