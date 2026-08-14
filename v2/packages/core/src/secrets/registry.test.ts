import { describe, expect, it } from 'vitest';
import { s, type KV } from '@shepherd/sdk';
import { SecretsRegistry, type Cipher } from './registry.ts';

/**
 * The store, and the two things it must never do: hand a value to somebody who
 * did not declare it, and write one in the clear.
 */

/** An in-memory KV that behaves like the sqlite one for these purposes. */
function memory(): { namespace(name: string): KV; raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    raw,
    namespace: (space) => ({
      get: <T,>(key: string, schema: { parse(value: unknown): { ok: true; value: T } | { ok: false } }) => {
        const held = raw.get(`${space}:${key}`);
        if (held === undefined) return undefined;
        const parsed = schema.parse(held);
        return parsed.ok ? parsed.value : undefined;
      },
      set: (key, value) => void raw.set(`${space}:${key}`, value),
      delete: (key) => void raw.delete(`${space}:${key}`),
      keys: () =>
        [...raw.keys()].filter((key) => key.startsWith(`${space}:`)).map((key) => key.slice(space.length + 1)),
    }),
  };
}

/**
 * A cipher that is honest about being fake: it transforms, so a test can tell
 * ciphertext from plaintext, and it is obviously not encryption.
 */
const rot: Cipher = {
  available: () => true,
  encrypt: (plain) => new TextEncoder().encode([...plain].reverse().join('')),
  decrypt: (bytes) => [...new TextDecoder().decode(bytes)].reverse().join(''),
};

const spec = { key: 'token', title: 'GitHub token' };

function build(cipher: Cipher = rot) {
  const store = memory();
  const errors: string[] = [];
  const registry = new SecretsRegistry({ store, cipher, onError: (message) => errors.push(message) });
  return { registry, store, errors };
}

describe('declaring', () => {
  it('keeps a well-formed declaration and lists it as unset', () => {
    const { registry } = build();
    expect(registry.declare('shepherd.github', [spec])).toEqual([]);
    expect(registry.list()).toEqual([{ ...spec, owner: 'shepherd.github', set: false }]);
  });

  it('reports a bad key and keeps the extension’s other secrets', () => {
    // An extension whose second secret has a typo should still hold its first.
    const { registry } = build();
    const issues = registry.declare('shepherd.github', [spec, { key: 'a/b', title: 'Escapes' }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('a/b');
    expect(registry.list().map((entry) => entry.key)).toEqual(['token']);
  });

  it('refuses a duplicate key, which would draw one field twice', () => {
    const { registry } = build();
    const issues = registry.declare('shepherd.github', [spec, { key: 'token', title: 'Again' }]);
    expect(issues[0]).toContain('twice');
    expect(registry.list()).toHaveLength(1);
  });

  it('refuses a link that is not https, because it becomes something a user clicks', () => {
    const { registry } = build();
    const issues = registry.declare('x.y', [{ ...spec, link: 'javascript:alert(1)' }]);
    expect(issues[0]).toContain('https');
    expect(registry.list()).toEqual([]);
  });

  it('refuses a spec with no title, since nothing could label its field', () => {
    const { registry } = build();
    expect(registry.declare('x.y', [{ key: 'token', title: '' }])[0]).toContain('no title');
  });
});

describe('storing', () => {
  it('encrypts, and the plaintext is nowhere in the store', () => {
    const { registry, store } = build();
    registry.declare('shepherd.github', [spec]);
    expect(registry.set('shepherd.github', 'token', 'gho_secret')).toEqual({ ok: true });
    expect(JSON.stringify([...store.raw])).not.toContain('gho_secret');
    expect(registry.get('shepherd.github', 'token')).toBe('gho_secret');
  });

  it('REFUSES to store when there is no keychain, rather than falling back to plaintext', () => {
    // A secrets store that silently stops encrypting is worse than one that says
    // it cannot help.
    const { registry, store } = build({ ...rot, available: () => false });
    registry.declare('shepherd.github', [spec]);
    const result = registry.set('shepherd.github', 'token', 'gho_secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unavailable');
    expect(JSON.stringify([...store.raw])).not.toContain('gho_secret');
  });

  it('refuses a key the extension never declared', () => {
    // The declaration is what the user saw and agreed to. A write outside it
    // would put a credential in the store that no screen lists.
    const { registry } = build();
    registry.declare('shepherd.github', [spec]);
    const result = registry.set('shepherd.github', 'other', 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('undeclared');
  });

  it('treats an empty value as a delete, so clearing a field is one gesture', () => {
    const { registry } = build();
    registry.declare('shepherd.github', [spec]);
    registry.set('shepherd.github', 'token', 'gho_secret');
    expect(registry.set('shepherd.github', 'token', '')).toEqual({ ok: true });
    expect(registry.get('shepherd.github', 'token')).toBeUndefined();
    expect(registry.list()[0]?.set).toBe(false);
  });
});

describe('reading', () => {
  it('answers undefined for a key this extension did not declare', () => {
    const { registry } = build();
    registry.declare('shepherd.github', [spec]);
    registry.set('shepherd.github', 'token', 'gho_secret');
    // Even though the value exists — it is not this caller's.
    registry.declare('evil.ext', [{ key: 'token', title: 'Mine now' }]);
    expect(registry.get('evil.ext', 'token')).toBeUndefined();
  });

  it('keeps two extensions’ same-named secrets apart', () => {
    const { registry } = build();
    registry.declare('a.one', [spec]);
    registry.declare('b.two', [spec]);
    registry.set('a.one', 'token', 'first');
    registry.set('b.two', 'token', 'second');
    expect(registry.get('a.one', 'token')).toBe('first');
    expect(registry.get('b.two', 'token')).toBe('second');
  });

  it('reports a value that will not decrypt and answers absent', () => {
    // Real: a keychain entry re-created after an OS reinstall cannot decrypt
    // ciphertext the old one wrote. "Absent" is what leads a user to set it again.
    const { registry, errors } = build({
      ...rot,
      decrypt: () => {
        throw new Error('cannot decrypt');
      },
    });
    registry.declare('shepherd.github', [spec]);
    registry.set('shepherd.github', 'token', 'gho_secret');
    expect(registry.get('shepherd.github', 'token')).toBeUndefined();
    expect(errors[0]).toContain('Set it again');
  });

  it('never puts a value in the listing', () => {
    // A screen that could show a token is a screen that shows one over
    // somebody's shoulder.
    const { registry } = build();
    registry.declare('shepherd.github', [spec]);
    registry.set('shepherd.github', 'token', 'gho_secret');
    expect(JSON.stringify(registry.list())).not.toContain('gho_secret');
    expect(registry.list()[0]?.set).toBe(true);
  });
});

describe('an extension going away', () => {
  it('undeclare drops the ask and KEEPS the value', () => {
    // An extension disabled for an afternoon must not cost you a credential you
    // have to mint again — and the value is useless to anyone else.
    const { registry } = build();
    registry.declare('shepherd.github', [spec]);
    registry.set('shepherd.github', 'token', 'gho_secret');
    registry.undeclare('shepherd.github');
    expect(registry.list()).toEqual([]);

    registry.declare('shepherd.github', [spec]);
    expect(registry.get('shepherd.github', 'token')).toBe('gho_secret');
  });

  it('forget takes them, including keys it no longer declares', () => {
    const { registry, store } = build();
    registry.declare('shepherd.github', [spec, { key: 'old', title: 'Dropped in an update' }]);
    registry.set('shepherd.github', 'token', 'a');
    registry.set('shepherd.github', 'old', 'b');
    registry.declare('shepherd.github', [spec]);

    registry.forget('shepherd.github');
    expect([...store.raw]).toEqual([]);
  });

  it('forget takes nobody else’s', () => {
    const { registry } = build();
    registry.declare('a.one', [spec]);
    registry.declare('b.two', [spec]);
    registry.set('a.one', 'token', 'first');
    registry.set('b.two', 'token', 'second');
    registry.forget('a.one');
    expect(registry.get('b.two', 'token')).toBe('second');
  });
});

describe('the stored shape', () => {
  it('is base64 text, so it round-trips through a JSON store', () => {
    const { registry, store } = build();
    registry.declare('shepherd.github', [spec]);
    registry.set('shepherd.github', 'token', 'gho_secret');
    const [, stored] = [...store.raw][0] as [string, unknown];
    expect(typeof stored).toBe('string');
    expect(s.string().parse(stored).ok).toBe(true);
    expect(String(stored)).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});
