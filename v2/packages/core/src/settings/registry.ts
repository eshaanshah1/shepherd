import {
  CORE_NAMESPACE,
  defaultsOf,
  err,
  namespaceOf,
  ok,
  pageIssues,
  settingValueSchema,
  toDisposable,
  validateSetting,
  type Disposable,
  type KV,
  type Logger,
  type Result,
  type SettingSpec,
  type SettingValue,
  type SettingsError,
  type SettingsPage,
} from '@shepherd/sdk';
import type { SqliteStore } from '../storage/store.ts';

/**
 * A page, plus who contributed it — the shell draws the owner as a subtitle, and
 * the seed rule reads it.
 *
 * Recorded beside the page rather than in a table next to the registry, for
 * `points.ts`'s reason: "who owns this" and "does this page exist" have to become
 * false at the same instant, which is what a single `Map` keyed by owner gives.
 */
export interface OwnedPage extends SettingsPage {
  readonly owner: string;
}

/** The KV namespace every setting's value lives in, whoever declared it. */
const SETTINGS_NAMESPACE = 'settings';

export interface SettingsRegistryOptions {
  readonly store: SqliteStore;
  readonly logger: Logger;
}

/**
 * The authority on what settings exist and what they currently are.
 *
 * Two decisions worth reading before changing anything here:
 *
 *   - **Only non-default values are stored**, and a write equal to the default
 *     DELETES the row. That is what makes "reset" a real operation rather than a
 *     write of today's default frozen forever, and what lets a default the app
 *     changes in a later version reach every install that never touched the
 *     setting. Materializing defaults on first launch would make the store a
 *     snapshot of one version's opinions.
 *   - **An unknown key is an error, not a stored orphan.** This registry is the
 *     authority on what exists; a store that accepted anything is how a typo
 *     becomes a setting nobody can find and nothing can reset.
 */
export class SettingsRegistry {
  readonly #kv: KV;
  readonly #log;
  /** owner → its pages. Keyed by owner, so a teardown is one delete. */
  readonly #contributions = new Map<string, readonly SettingsPage[]>();
  readonly #listeners = new Set<(key: string, value: SettingValue) => void>();

  constructor(options: SettingsRegistryOptions) {
    this.#kv = options.store.namespace(SETTINGS_NAMESPACE);
    this.#log = options.logger.child('settings');
  }

  /**
   * Throws on a bad page, and contributes NOTHING when it does.
   *
   * All-or-nothing per owner: a partially accepted contribution is a screen that
   * draws some of an extension's settings and silently omits the rest, which
   * reads as a missing feature rather than as the manifest error it is. The host
   * turns this throw into a refused activation naming the extension.
   */
  contribute(owner: string, pages: readonly SettingsPage[]): Disposable {
    const namespace = owner === CORE_NAMESPACE ? CORE_NAMESPACE : namespaceOf(owner);
    const issues = pages.flatMap((page) => pageIssues(page, namespace));
    const taken = new Set(Object.keys(defaultsOf(this.#allPages())));
    for (const page of pages) {
      for (const spec of page.settings ?? []) {
        if (taken.has(spec.key)) issues.push(`settings key "${spec.key}" is already declared by another page`);
      }
    }
    if (issues.length > 0) throw new Error(`${owner}: ${issues.join('; ')}`);

    this.#contributions.set(owner, pages);
    this.#log.debug(`+${pages.length} settings page(s) from ${owner}`);
    return toDisposable(() => {
      this.#contributions.delete(owner);
    });
  }

  pages(): readonly OwnedPage[] {
    const owned = [...this.#contributions.entries()].flatMap(([owner, pages]) =>
      pages.map((page) => ({ ...page, owner })),
    );
    /**
     * `order` first, then title. A page with no order sorts AFTER every page that
     * declared one — `Infinity`, not 0: an extension that expressed no opinion
     * must not land in front of the app's own General page.
     */
    return owned.sort(
      (a, b) =>
        (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY) || a.title.localeCompare(b.title),
    );
  }

  spec(key: string): SettingSpec | undefined {
    for (const page of this.#allPages()) {
      const found = (page.settings ?? []).find((candidate) => candidate.key === key);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** The effective value: what is stored, or the declared default. */
  get(key: string): SettingValue | undefined {
    const spec = this.spec(key);
    if (spec === undefined) return undefined;
    const stored = this.#stored(key);
    return stored === undefined ? spec.default : stored;
  }

  /** Every effective value in one namespace — what an extension is seeded with. */
  values(namespace: string): Record<string, SettingValue> {
    const scoped: Record<string, SettingValue> = {};
    for (const [key, fallback] of Object.entries(defaultsOf(this.#allPages()))) {
      if (!key.startsWith(`${namespace}.`)) continue;
      const stored = this.#stored(key);
      scoped[key] = stored === undefined ? fallback : stored;
    }
    return scoped;
  }

  set(key: string, value: unknown): Result<SettingValue, SettingsError> {
    const spec = this.spec(key);
    if (spec === undefined) {
      return err({
        code: 'unknown-key',
        message:
          `no setting "${key}" is declared. The registry is the authority on what exists — ` +
          'a value stored under an undeclared key would be a setting nobody can find and nothing can reset.',
      });
    }
    const validated = validateSetting(spec, value);
    if (!validated.ok) return validated;

    const before = this.get(key);
    if (validated.value === spec.default) this.#kv.delete(key);
    else this.#kv.set(key, validated.value);

    if (before !== validated.value) this.#announce(key, validated.value);
    return ok(validated.value);
  }

  reset(key: string): Result<SettingValue, SettingsError> {
    const spec = this.spec(key);
    if (spec === undefined) return err({ code: 'unknown-key', message: `no setting "${key}" is declared` });
    return this.set(key, spec.default);
  }

  /** Whether nothing is stored for this key — which is what a reset restores. */
  isDefault(key: string): boolean {
    return this.#stored(key) === undefined;
  }

  onDidChange(fn: (key: string, value: SettingValue) => void): Disposable {
    this.#listeners.add(fn);
    return toDisposable(() => void this.#listeners.delete(fn));
  }

  #allPages(): readonly SettingsPage[] {
    return [...this.#contributions.values()].flat();
  }

  /**
   * `undefined` means "nothing stored", which is what `isDefault` answers from —
   * and it is deliberately distinct from a stored `null`, which is a nullable
   * spec's explicit "unset".
   */
  #stored(key: string): SettingValue | undefined {
    const read = this.#kv.get(key, settingValueSchema);
    return read === undefined ? undefined : read;
  }

  #announce(key: string, value: SettingValue): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(key, value);
      } catch (error) {
        // One bad subscriber must not stop the rest from learning. A settings
        // change reaches the theme, the extension host and the window; a throw
        // in the first would otherwise leave the others reading a stale value
        // with nothing on screen to explain it.
        this.#log.warn(
          `a settings listener threw for ${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
