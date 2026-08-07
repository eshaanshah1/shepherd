import { err, ok, type Result } from './result.ts';

/**
 * A structural validator, ~zero cost, no dependency.
 *
 * Every command's arguments are validated here before its handler runs, and the
 * same values arrive from four transports (a keystroke, a palette entry, the
 * control socket, an extension). So this is not a convenience: it is the thing
 * that makes "unknown command / failed schema = typed error, never a silent
 * no-op" true, and the error *shape* has to be ours because it travels back out
 * over IPC and over a unix socket to a CLI that prints it.
 *
 * A library would also do this. It is ~200 lines, it needs to say exactly one
 * thing about unknown keys (reject them), and a version pin on the validator
 * every transport shares is a liability the SDK does not need. Both `parse`
 * results are values — nothing here throws.
 */

export interface SchemaIssue {
  /** `''` for the root, else `repos[1].path` — dotted, with array indices. */
  readonly path: string;
  readonly message: string;
}

export interface Schema<T> {
  /** Human-readable, for error text and for docs generated off a command spec. */
  readonly describe: string;
  parse(value: unknown): Result<T, readonly SchemaIssue[]>;
}

/**
 * A schema that also permits its key to be absent. The marker is what lets
 * `Infer` make exactly those keys optional — there is no way to detect
 * "optional" from `Schema<T | undefined>` alone.
 */
export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly optional: true;
}

// ------------------------------------------------------------------- inference

export type Infer<S> = S extends OptionalSchema<infer T> ? T | undefined : S extends Schema<infer T> ? T : never;

type Shape = Record<string, Schema<unknown>>;

type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends OptionalSchema<unknown> ? K : never;
}[keyof S];

type Prettify<T> = { [K in keyof T]: T[K] } & {};

type InferShape<S extends Shape> = Prettify<
  { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & {
    [K in OptionalKeys<S>]?: Infer<S[K]>;
  }
>;

// --------------------------------------------------------------------- helpers

const issue = (path: string, message: string): readonly SchemaIssue[] => [{ path, message }];

/** `typeof` is not enough: `null` and `[]` both report `object`. */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function scalar<T>(describe: string, check: (value: unknown) => value is T): Schema<T> {
  return {
    describe,
    parse: (value) =>
      check(value) ? ok(value) : err(issue('', `expected ${describe}, got ${typeName(value)}`)),
  };
}

/**
 * Prefixes a child's path with the segment it was found under, so the reader
 * gets `repos[1].path` and not `repos.[1].path` or a bare `path`. An index
 * segment abuts its parent; anything else takes a dot; an empty child path (the
 * common case — a scalar complaining about itself) is just the parent.
 */
function join(parent: string, child: string): string {
  if (child === '') return parent;
  if (child.startsWith('[')) return `${parent}${child}`;
  return parent === '' ? child : `${parent}.${child}`;
}

function reparent(issues: readonly SchemaIssue[], segment: string): SchemaIssue[] {
  return issues.map((i) => ({ path: join(segment, i.path), message: i.message }));
}

// ----------------------------------------------------------------- combinators

const string = (): Schema<string> => scalar('string', (v): v is string => typeof v === 'string');

const boolean = (): Schema<boolean> => scalar('boolean', (v): v is boolean => typeof v === 'boolean');

/**
 * Finite only. `NaN` and `Infinity` cannot come out of `JSON.parse`, but an
 * in-process extension caller can pass either, and a `NaN` that reaches a
 * resize or a split ratio corrupts the layout somewhere far from here.
 */
const number = (): Schema<number> =>
  scalar('number', (v): v is number => typeof v === 'number' && Number.isFinite(v));

const int = (): Schema<number> => scalar('integer', (v): v is number => Number.isInteger(v));

/**
 * `null`, as a value in its own right.
 *
 * Needed because JSON has no `undefined`: a tri-state field crossing the wire —
 * "yes" / "no" / "could not tell" — has to spell the third state `null`, and an
 * absent key would be indistinguishable from a field the sending build does not
 * know about. `s.optional` is a different question (may the key be missing) and
 * cannot express this one.
 */
const nullValue = (): Schema<null> => ({
  describe: 'null',
  parse: (value) => (value === null ? ok(null) : err(issue('', `expected null, got ${show(value)}`))),
});

function literal<const T extends string | number | boolean>(expected: T): Schema<T> {
  const describe = JSON.stringify(expected);
  return {
    describe,
    parse: (value) =>
      value === expected ? ok(expected) : err(issue('', `expected ${describe}, got ${show(value)}`)),
  };
}

function enumOf<const T extends readonly (string | number)[]>(values: T): Schema<T[number]> {
  const describe = values.map((v) => JSON.stringify(v)).join(', ');
  return {
    describe: `one of ${describe}`,
    parse: (value) =>
      (values as readonly unknown[]).includes(value)
        ? ok(value as T[number])
        : err(issue('', `expected one of ${describe}, got ${show(value)}`)),
  };
}

function object<S extends Shape>(shape: S): Schema<InferShape<S>> {
  const keys = Object.keys(shape);
  return {
    describe: `{ ${keys.join(', ')} }`,
    parse(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return err(issue('', `expected object, got ${typeName(value)}`));
      }
      const input = value as Record<string, unknown>;
      const issues: SchemaIssue[] = [];
      const out: Record<string, unknown> = {};

      for (const key of keys) {
        const field = shape[key]!;
        const present = Object.hasOwn(input, key);
        if (!present || input[key] === undefined) {
          if (isOptional(field)) continue; // absent stays absent — see below
          issues.push({ path: key, message: `expected ${field.describe}, got missing` });
          continue;
        }
        const parsed = field.parse(input[key]);
        if (parsed.ok) out[key] = parsed.value;
        else issues.push(...reparent(parsed.error, key));
      }

      // Unknown keys are an ERROR, not something to drop. A mistyped CLI flag or
      // a field from a client we no longer speak to must reach the caller as a
      // failure; silently ignoring it is how an argument goes missing and the
      // command appears to work.
      for (const key of Object.keys(input)) {
        if (!Object.hasOwn(shape, key)) issues.push({ path: '', message: `unexpected key ${JSON.stringify(key)}` });
      }

      return issues.length > 0 ? err(issues) : ok(out as InferShape<S>);
    },
  };
}

function array<T>(inner: Schema<T>): Schema<T[]> {
  return {
    describe: `${inner.describe}[]`,
    parse(value) {
      if (!Array.isArray(value)) return err(issue('', `expected array, got ${typeName(value)}`));
      const issues: SchemaIssue[] = [];
      const out: T[] = [];
      value.forEach((element, index) => {
        const parsed = inner.parse(element);
        if (parsed.ok) out.push(parsed.value);
        else issues.push(...reparent(parsed.error, `[${index}]`));
      });
      return issues.length > 0 ? err(issues) : ok(out);
    },
  };
}

function record<T>(inner: Schema<T>): Schema<Record<string, T>> {
  return {
    describe: `{ [key: string]: ${inner.describe} }`,
    parse(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return err(issue('', `expected object, got ${typeName(value)}`));
      }
      const issues: SchemaIssue[] = [];
      const out: Record<string, T> = {};
      for (const [key, element] of Object.entries(value)) {
        const parsed = inner.parse(element);
        if (parsed.ok) out[key] = parsed.value;
        else issues.push(...reparent(parsed.error, key));
      }
      return issues.length > 0 ? err(issues) : ok(out);
    },
  };
}

function optional<T>(inner: Schema<T>): OptionalSchema<T> {
  return {
    optional: true,
    describe: `${inner.describe}?`,
    parse: (value) => (value === undefined ? ok(undefined) : inner.parse(value)),
  };
}

function isOptional(schema: Schema<unknown>): schema is OptionalSchema<unknown> {
  return (schema as OptionalSchema<unknown>).optional === true;
}

/**
 * First branch that parses wins. A failure reports the *alternatives* rather
 * than the last branch's complaint — "expected object, got string" from the
 * final variant tells a caller nothing about the union it actually missed.
 */
function union<const S extends readonly Schema<unknown>[]>(...variants: S): Schema<Infer<S[number]>> {
  const describe = variants.map((v) => v.describe).join(', or ');
  return {
    describe,
    parse(value) {
      for (const variant of variants) {
        const parsed = variant.parse(value);
        if (parsed.ok) return ok(parsed.value as Infer<S[number]>);
      }
      return err(issue('', `no variant matched (expected ${describe})`));
    },
  };
}

/** The schema for a command that takes no arguments. */
const nothing = (): Schema<undefined> => ({
  describe: 'nothing',
  parse: (value) => (value === undefined ? ok(undefined) : err(issue('', `expected no argument, got ${typeName(value)}`))),
});

/** An escape hatch, deliberately ugly to type so it stays rare. */
const unknownValue = (): Schema<unknown> => ({ describe: 'unknown', parse: (value) => ok(value) });

function show(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? JSON.stringify(value)
    : typeName(value);
}

/** One namespace so a schema reads as `s.object({ … })` at every call site. */
export const s = {
  string,
  number,
  int,
  boolean,
  literal,
  nullValue,
  enumOf,
  object,
  array,
  record,
  optional,
  union,
  nothing,
  unknown: unknownValue,
} as const;

/** Renders issues as one line — for a log, an IPC error message, or a CLI. */
export function formatIssues(issues: readonly SchemaIssue[]): string {
  return issues.map((i) => (i.path === '' ? i.message : `${i.path}: ${i.message}`)).join('; ');
}
