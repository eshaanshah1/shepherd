import { s, secretKeyIssue, secretLinkIssue, secretPath, type KV, type SecretSpec } from '@shepherd/sdk';

/**
 * Every credential an extension declared, and the encrypted values behind them.
 *
 * Two halves that are deliberately not the same thing:
 *
 *   - **the declarations** — static data from manifests, so the Secrets screen
 *     lists what every installed extension wants with none of them activated;
 *   - **the values** — encrypted at rest, readable only by the extension that
 *     declared the key, and never returned to a listing.
 *
 * ── the encryption is INJECTED, and that is not indirection ──────────────────
 *
 * The only encryption worth having here is the OS keychain's, and reaching it
 * means `electron.safeStorage` — which core may not import and should not: core
 * is the part of this app that has no machine under it (`boundaries.js`). So a
 * `Cipher` is passed in, main supplies the real one, and a test supplies one
 * that is honest about being fake.
 *
 * That seam also buys the answer to a question this feature cannot dodge: **what
 * happens when there is no keychain.** `Cipher.available` is false on a machine
 * where safeStorage is not ready, and this store then refuses to WRITE rather
 * than falling back to plaintext. A secrets store that silently stops encrypting
 * is worse than one that says it cannot help.
 */

/** What main supplies, and the only thing core knows about encryption. */
export interface Cipher {
  /**
   * Is encryption usable right now?
   *
   * On macOS this is "the keychain answered". It is checked per WRITE rather
   * than once at construction: safeStorage becomes ready during startup, and a
   * store that decided at boot would refuse for the life of a process that was
   * merely started early.
   */
  available(): boolean;
  encrypt(plain: string): Uint8Array;
  decrypt(bytes: Uint8Array): string;
}

/** The KV namespace ciphertext lives in. */
export const SECRETS_NAMESPACE = 'secrets';

export interface SecretsRegistryOptions {
  readonly store: { namespace(name: string): KV };
  readonly cipher: Cipher;
  /** Where a swallowed failure goes; there is no logger in core. */
  readonly onError?: (message: string) => void;
}

/** A declared secret, plus what the screen needs to draw it. */
export interface DeclaredSecret extends SecretSpec {
  /** Which extension asked. */
  readonly owner: string;
  /** Is there a value stored? **Never the value itself** — see `list`. */
  readonly set: boolean;
}

export type SecretsError =
  | { readonly code: 'undeclared'; readonly message: string }
  | { readonly code: 'unavailable'; readonly message: string }
  | { readonly code: 'unreadable'; readonly message: string };

export class SecretsRegistry {
  readonly #kv: KV;
  readonly #cipher: Cipher;
  readonly #onError: (message: string) => void;
  /** owner id -> its declared specs, in declaration order. */
  readonly #declared = new Map<string, readonly SecretSpec[]>();

  constructor(options: SecretsRegistryOptions) {
    this.#kv = options.store.namespace(SECRETS_NAMESPACE);
    this.#cipher = options.cipher;
    this.#onError = options.onError ?? (() => {});
  }

  /**
   * What an extension says it needs. Called with the manifest, at install/load,
   * before anything is activated.
   *
   * Returns the problems rather than throwing, and the caller decides what a
   * problem costs. For settings that is "fail the whole activation", because a
   * half-drawn page reads as a missing feature; here a bad key is one field, so
   * `ExtensionRegistry` reports it and keeps the rest — an extension whose
   * second secret has a typo should still be able to hold its first.
   */
  declare(owner: string, specs: readonly SecretSpec[]): readonly string[] {
    const issues: string[] = [];
    const kept: SecretSpec[] = [];
    const seen = new Set<string>();

    for (const spec of specs) {
      const keyIssue = secretKeyIssue(spec.key);
      if (keyIssue !== undefined) {
        issues.push(`${owner}: ${keyIssue}`);
        continue;
      }
      if (seen.has(spec.key)) {
        // Two declarations of one key is a manifest that cannot be drawn: the
        // screen would show one field twice and the second write would win.
        issues.push(`${owner}: declares "${spec.key}" twice`);
        continue;
      }
      if (spec.title === '') {
        issues.push(`${owner}: "${spec.key}" has no title, so nothing could label its field`);
        continue;
      }
      if (spec.link !== undefined) {
        const linkIssue = secretLinkIssue(spec.link);
        if (linkIssue !== undefined) {
          issues.push(`${owner}: "${spec.key}" — ${linkIssue}`);
          continue;
        }
      }
      seen.add(spec.key);
      kept.push(spec);
    }

    if (kept.length > 0) this.#declared.set(owner, kept);
    else this.#declared.delete(owner);
    return issues;
  }

  /** An extension is gone: forget what it wanted. Its VALUES are kept — see below. */
  undeclare(owner: string): void {
    /*
     * The declaration goes and the ciphertext stays.
     *
     * Deleting the value here would mean an extension disabled for an afternoon
     * costs you a credential you have to go and mint again — and the value is
     * useless to anyone else, because it is keyed by the owner that declared it.
     * `forget` is the deliberate version of that, and it is the user's gesture.
     */
    this.#declared.delete(owner);
  }

  /**
   * Every declared secret, and whether it holds a value. **Never a value.**
   *
   * This is what the Secrets screen draws, and the omission is the point: a
   * screen that could show a token is a screen that shows one over somebody's
   * shoulder. Reading a value takes the owning extension's own permission, and
   * the screen is not that extension.
   */
  list(): readonly DeclaredSecret[] {
    return [...this.#declared].flatMap(([owner, specs]) =>
      specs.map((spec) => ({ ...spec, owner, set: this.#kv.get(secretPath(owner, spec.key), s.string()) !== undefined })),
    );
  }

  /** Has this extension declared this key? The gate every read and write passes. */
  isDeclared(owner: string, key: string): boolean {
    return (this.#declared.get(owner) ?? []).some((spec) => spec.key === key);
  }

  /**
   * The value, decrypted — or `undefined` for one that was never set.
   *
   * An UNDECLARED key is a caller bug and answers `undefined` too, rather than
   * throwing: `get` is on the hot path of an extension deciding whether it can
   * work at all, and the honest answer to "may I have a secret I never asked
   * for" is the same as to "may I have one nobody filled in" — no.
   *
   * A value that will not decrypt is reported and answered as absent. That
   * happens for real: a keychain entry re-created after an OS reinstall cannot
   * decrypt ciphertext written by the old one, and the recovery is to set it
   * again — which is exactly what "absent" leads a user to do.
   */
  get(owner: string, key: string): string | undefined {
    if (!this.isDeclared(owner, key)) return undefined;
    const stored = this.#kv.get(secretPath(owner, key), s.string());
    if (typeof stored !== 'string' || stored === '') return undefined;
    try {
      return this.#cipher.decrypt(Buffer.from(stored, 'base64'));
    } catch (error: unknown) {
      this.#onError(`could not decrypt ${owner}/${key} — ${String(error)}. Set it again.`);
      return undefined;
    }
  }

  /**
   * Store a value, encrypted.
   *
   * Refuses an undeclared key: the declaration is what the user saw and agreed
   * to, and a write outside it would put a credential in the store that no
   * screen lists and nothing can clear.
   *
   * Refuses when there is no keychain, rather than storing plaintext. A secrets
   * store that silently stops encrypting is worse than one that says it cannot
   * help — and the user can act on being told.
   */
  set(owner: string, key: string, value: string): { ok: true } | { ok: false; error: SecretsError } {
    if (!this.isDeclared(owner, key)) {
      return { ok: false, error: { code: 'undeclared', message: `${owner} did not declare a secret "${key}"` } };
    }
    if (!this.#cipher.available()) {
      return {
        ok: false,
        error: {
          code: 'unavailable',
          message: 'the system keychain is not available, so this cannot be stored encrypted',
        },
      };
    }
    // An empty value is a DELETE, so "clear this field" and "store nothing" are
    // one gesture rather than two that behave differently.
    if (value === '') {
      this.#kv.delete(secretPath(owner, key));
      return { ok: true };
    }
    try {
      this.#kv.set(secretPath(owner, key), Buffer.from(this.#cipher.encrypt(value)).toString('base64'));
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: { code: 'unavailable', message: `could not encrypt: ${String(error)}` } };
    }
  }

  delete(owner: string, key: string): void {
    this.#kv.delete(secretPath(owner, key));
  }

  /**
   * Every stored value for an owner, gone — including keys it no longer
   * declares.
   *
   * The deliberate counterpart to `undeclare` keeping them: uninstalling an
   * extension should be able to take its credentials with it, and a key it
   * dropped in an update would otherwise be unreachable ciphertext forever.
   */
  forget(owner: string): void {
    for (const key of this.#kv.keys()) {
      if (key.startsWith(`${owner}/`)) this.#kv.delete(key);
    }
  }
}
