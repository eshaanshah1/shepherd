import { describe, expect, expectTypeOf, it } from 'vitest';
import { isErr, isOk } from './result.ts';
import { s, type Infer, type SchemaIssue } from './schema.ts';

/** The issues, flattened to `path: message` — what a caller actually shows. */
function issues(result: unknown): string[] {
  const r = result as { ok: boolean; error?: readonly SchemaIssue[] };
  if (r.ok) return [];
  return (r.error ?? []).map((issue) => `${issue.path}: ${issue.message}`);
}

describe('scalars', () => {
  it('accepts the right type and rejects the rest', () => {
    expect(s.string().parse('x')).toEqual({ ok: true, value: 'x' });
    expect(isErr(s.string().parse(7))).toBe(true);
    expect(s.number().parse(7)).toEqual({ ok: true, value: 7 });
    expect(isErr(s.number().parse('7'))).toBe(true);
    expect(s.boolean().parse(false)).toEqual({ ok: true, value: false });
    expect(isErr(s.boolean().parse(0))).toBe(true);
  });

  it('rejects NaN and Infinity as numbers', () => {
    // JSON.parse cannot produce either, but a same-process extension caller can,
    // and a NaN that reaches a resize or a ratio is a corrupted layout.
    expect(isErr(s.number().parse(Number.NaN))).toBe(true);
    expect(isErr(s.number().parse(Number.POSITIVE_INFINITY))).toBe(true);
  });

  it('distinguishes null from undefined from missing', () => {
    expect(isErr(s.string().parse(null))).toBe(true);
    expect(isErr(s.string().parse(undefined))).toBe(true);
  });

  it('int() takes integers only', () => {
    expect(s.int().parse(3)).toEqual({ ok: true, value: 3 });
    expect(isErr(s.int().parse(3.5))).toBe(true);
  });

  it('literal and enumOf name what they wanted', () => {
    expect(s.literal('row').parse('row')).toEqual({ ok: true, value: 'row' });
    const axis = s.enumOf(['row', 'column'] as const);
    expect(axis.parse('column')).toEqual({ ok: true, value: 'column' });
    const bad = axis.parse('diagonal');
    expect(issues(bad)).toEqual([': expected one of "row", "column", got "diagonal"']);
  });
});

describe('objects', () => {
  const spec = s.object({
    cwd: s.string(),
    cols: s.optional(s.int()),
  });

  it('parses a valid object and keeps only the declared keys', () => {
    expect(spec.parse({ cwd: '/tmp', cols: 80 })).toEqual({ ok: true, value: { cwd: '/tmp', cols: 80 } });
  });

  it('allows an absent optional key, and omits it rather than setting undefined', () => {
    const parsed = spec.parse({ cwd: '/tmp' });
    expect(parsed).toEqual({ ok: true, value: { cwd: '/tmp' } });
    // `{cwd, cols: undefined}` would serialize differently over IPC and would
    // defeat `'cols' in spec` checks downstream.
    if (isOk(parsed)) expect(Object.hasOwn(parsed.value, 'cols')).toBe(false);
  });

  it('accepts an explicit undefined for an optional key', () => {
    expect(spec.parse({ cwd: '/tmp', cols: undefined })).toEqual({ ok: true, value: { cwd: '/tmp' } });
  });

  it('REJECTS an unknown key rather than dropping it', () => {
    // The strictness is the point: a mistyped CLI flag or a stale client field
    // must be an error a caller sees, not a silently ignored argument. This is
    // the same rule as "unknown command is a typed error, never a no-op".
    expect(issues(spec.parse({ cwd: '/tmp', colours: 80 }))).toEqual([': unexpected key "colours"']);
  });

  it('reports EVERY bad field, not just the first', () => {
    const both = s.object({ a: s.string(), b: s.number() }).parse({ a: 1, b: 'x' });
    expect(issues(both)).toEqual(['a: expected string, got number', 'b: expected number, got string']);
  });

  it('rejects arrays and null as objects', () => {
    expect(isErr(spec.parse([]))).toBe(true);
    expect(isErr(spec.parse(null))).toBe(true);
  });

  it('nests paths through objects and arrays', () => {
    const nested = s.object({ repos: s.array(s.object({ path: s.string() })) });
    expect(issues(nested.parse({ repos: [{ path: 'ok' }, { path: 7 }] }))).toEqual([
      'repos[1].path: expected string, got number',
    ]);
  });
});

describe('collections and unions', () => {
  it('array checks every element', () => {
    expect(s.array(s.string()).parse(['a', 'b'])).toEqual({ ok: true, value: ['a', 'b'] });
    expect(isErr(s.array(s.string()).parse('a'))).toBe(true);
  });

  it('record checks values and keeps keys', () => {
    const env = s.record(s.string());
    expect(env.parse({ TERM: 'xterm' })).toEqual({ ok: true, value: { TERM: 'xterm' } });
    expect(issues(env.parse({ TERM: 1 }))).toEqual(['TERM: expected string, got number']);
  });

  it('union takes the first branch that parses', () => {
    const target = s.union(s.string(), s.object({ nodeId: s.string() }));
    expect(target.parse('main')).toEqual({ ok: true, value: 'main' });
    expect(target.parse({ nodeId: 'n1' })).toEqual({ ok: true, value: { nodeId: 'n1' } });
  });

  it('a failed union reports what it tried, not the last branch it happened to try', () => {
    const target = s.union(s.literal('a'), s.literal('b'));
    expect(issues(target.parse('c'))).toEqual([': no variant matched (expected "a", or "b")']);
  });

  it('nothing() accepts only undefined — the schema for an argument-less command', () => {
    expect(s.nothing().parse(undefined)).toEqual({ ok: true, value: undefined });
    expect(isErr(s.nothing().parse({}))).toBe(true);
  });
});

describe('types', () => {
  it('infers the parsed shape, with optionals optional', () => {
    const spec = s.object({
      cwd: s.string(),
      cols: s.optional(s.int()),
      axis: s.enumOf(['row', 'column'] as const),
      repos: s.array(s.string()),
    });
    expectTypeOf<Infer<typeof spec>>().toEqualTypeOf<{
      cwd: string;
      cols?: number;
      axis: 'row' | 'column';
      repos: string[];
    }>();
  });
});

describe('s.nullValue', () => {
  it('accepts null and nothing else', () => {
    expect(s.nullValue().parse(null)).toEqual({ ok: true, value: null });
    for (const other of [undefined, 0, '', false, {}, []]) {
      expect(s.nullValue().parse(other).ok, JSON.stringify(other) ?? 'undefined').toBe(false);
    }
  });

  it('is how a tri-state field crosses the wire', () => {
    // JSON has no `undefined`, so "could not tell" has to be spelled `null` —
    // an absent key would be indistinguishable from a field the sender's build
    // does not know about. `s.optional` answers a different question.
    const tri = s.union(s.boolean(), s.nullValue());
    expect(tri.parse(true)).toEqual({ ok: true, value: true });
    expect(tri.parse(false)).toEqual({ ok: true, value: false });
    expect(tri.parse(null)).toEqual({ ok: true, value: null });
    expect(tri.parse(undefined).ok).toBe(false);
  });
});

describe('s.stored — the lenient reader', () => {
  const record = s.stored({ id: s.string(), title: s.string() });

  it('reads a record it fully understands', () => {
    expect(record.parse({ id: 'a', title: 't' })).toEqual({ ok: true, value: { id: 'a', title: 't' } });
  });

  it('KEEPS a record carrying a key it does not know', () => {
    // The whole point. `s.object` rejects unknown keys, which is right for a
    // command's ARGUMENTS — a mistyped flag must fail — and wrong for something
    // read back from disk, where an unknown key means "written by a newer build".
    // Rejecting there makes `KV.get` return undefined, which reads as "no such
    // task" while its worktrees sit on disk with nothing referencing them.
    const out = record.parse({ id: 'a', title: 't', addedLater: 42 });
    expect(out).toEqual({ ok: true, value: { id: 'a', title: 't' } });
  });

  it('still fails a record missing something it needs', () => {
    // Lenient about additions, never about absences: a task with no id is not a
    // task from the future, it is corrupt.
    expect(record.parse({ title: 't' }).ok).toBe(false);
  });

  it('still fails a field of the wrong type', () => {
    expect(record.parse({ id: 7, title: 't' }).ok).toBe(false);
  });

  it('still rejects a non-object', () => {
    expect(record.parse('nope').ok).toBe(false);
    expect(record.parse(null).ok).toBe(false);
  });
});
