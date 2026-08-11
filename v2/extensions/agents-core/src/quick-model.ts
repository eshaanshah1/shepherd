import type { SettingChoice, SettingsAPI, KV, Schema } from '@shepherd/sdk';
import { s } from '@shepherd/sdk';
import { QUICK_KIND_SETTING, QUICK_MODEL_KEY, QUICK_MODEL_SETTING } from './manifest.ts';
import type { AgentKind, HeadlessHalf } from './kind.ts';

/**
 * Which kind and which model serve the quick tier.
 *
 * §7c's rule is "the consumer's choice or, omitted, the user's configured
 * default". The consumer's half is deliberately left out: no consumer has asked
 * to pick a vendor per call, and a parameter added before one does would be
 * public API shaped by nobody.
 *
 * Pure, so the one interesting decision below is testable without a registry.
 */

export interface QuickOverride {
  /** A kind id. Absent means "the first capable one". */
  readonly kind?: string;
  /** A vendor's model id. Absent means the kind's own `quickModel`. */
  readonly model?: string;
}

export interface QuickTarget {
  readonly kind: AgentKind & { readonly headless: HeadlessHalf };
  readonly model: string;
}

export function resolveQuick(
  kinds: readonly AgentKind[],
  override: QuickOverride | undefined,
): QuickTarget | undefined {
  const capable = kinds.filter(
    (kind): kind is AgentKind & { headless: HeadlessHalf } => kind.headless !== undefined,
  );
  const wanted = override?.kind;
  /**
   * A configured kind that is absent — or present but interactive-only —
   * resolves to NOTHING, never to whichever other vendor happens to be first.
   *
   * Falling back would spend the user's model budget on a vendor they explicitly
   * did not choose, and the only evidence of it would be a bill. A wrong id is a
   * configuration mistake, and it should read as one.
   */
  const chosen = wanted === undefined ? capable[0] : capable.find((kind) => kind.id === wanted);
  if (chosen === undefined) return undefined;
  return { kind: chosen, model: override?.model ?? chosen.headless.quickModel };
}

/** What the `quickModel` verb was asked to change, if anything. */
export interface QuickChange {
  readonly kind?: string;
  readonly model?: string;
  readonly clear?: boolean;
}

/**
 * The stored override after a change — a MERGE, and `undefined` to forget it.
 *
 * Merged rather than replaced because the verb takes either field on its own:
 * setting the model must not silently move the user back to the default vendor.
 * `clear` wins over both, because it is the louder word and a caller who passed
 * it alongside a field meant the reset.
 */
export function applyOverride(
  current: QuickOverride | undefined,
  change: QuickChange,
): QuickOverride | undefined {
  if (change.clear === true) return undefined;
  if (change.kind === undefined && change.model === undefined) return current;
  return {
    ...current,
    ...(change.kind === undefined ? {} : { kind: change.kind }),
    ...(change.model === undefined ? {} : { model: change.model }),
  };
}

/**
 * What the verb answers: the EFFECTIVE resolution, never just the stored override.
 *
 * What somebody typing `shepherd agent quick-model` wants to know is which model
 * will actually run; an override echoed back answers a different question. When
 * nothing resolves, `available` is what makes a rejected kind id diagnosable
 * rather than mysterious.
 */
export function describeQuick(
  kinds: readonly AgentKind[],
  override: QuickOverride | undefined,
): {
  readonly kind: string | null;
  readonly model: string | null;
  readonly override: QuickOverride | null;
  readonly available: readonly string[];
} {
  const target = resolveQuick(kinds, override);
  return {
    kind: target?.kind.id ?? null,
    model: target?.model ?? null,
    override: override ?? null,
    available: kinds.filter((kind) => kind.headless !== undefined).map((kind) => kind.id),
  };
}


// ------------------------------------------------------------------- as settings

/**
 * The two settings keys → the override `resolveQuick` takes.
 *
 * `null` is DROPPED rather than passed through: a nullable spec's null means "the
 * extension's own fallback", while `resolveQuick` reads a PRESENT `kind` as "this
 * kind or nothing at all" — so a null arriving as a kind id would resolve to no
 * agent, and a quick call would fail as though the user had chosen a vendor that
 * is not installed.
 */
export function overrideFromSettings(values: Readonly<Record<string, unknown>>): QuickOverride | undefined {
  const kind = values[QUICK_KIND_SETTING];
  const model = values[QUICK_MODEL_SETTING];
  const override: QuickOverride = {
    ...(typeof kind === 'string' && kind !== '' ? { kind } : {}),
    ...(typeof model === 'string' && model !== '' ? { model } : {}),
  };
  return override.kind === undefined && override.model === undefined ? undefined : override;
}

/**
 * What the settings screen may offer for both quick-tier rows.
 *
 * One list, deliberately: a kind id and a model id are both strings the vendor
 * chose, and the screen asks the same command for either row. Each entry carries
 * the kind it came from as its description, which is what makes a bare model alias
 * (`sonnet`) readable when two vendors are installed.
 */
export function quickChoices(kinds: readonly AgentKind[], key: string): readonly SettingChoice[] {
  const capable = kinds.filter(
    (kind): kind is AgentKind & { headless: HeadlessHalf } => kind.headless !== undefined,
  );
  if (key === QUICK_KIND_SETTING) {
    return capable.map((kind) => ({ value: kind.id, label: kind.id }));
  }
  // Every model every capable kind advertises. A kind that advertises none serves
  // exactly one, and `quickModel` is it.
  return capable.flatMap((kind) =>
    (kind.headless.quickModels ?? [kind.headless.quickModel]).map((model) => ({
      value: model,
      label: model,
      description: kind.id,
    })),
  );
}

const storedOverrideSchema: Schema<{ kind?: string; model?: string }> = s.stored({
  kind: s.optional(s.string()),
  model: s.optional(s.string()),
});

/**
 * The pre-settings KV key, moved once.
 *
 * Three rules, each with a failure behind it:
 *
 *   - It never overwrites a settings value the user has ALREADY chosen — a
 *     migration that did would undo a deliberate choice with a stale one.
 *   - It deletes the old key even when it wrote nothing, or the migration runs on
 *     every launch forever.
 *   - A malformed blob is dropped rather than thrown: this runs during activation,
 *     and a preference that cannot be parsed must not stop the extension that
 *     tracks every agent from starting.
 */
export async function migrateQuickOverride(
  storage: KV,
  settings: SettingsAPI,
  current: Readonly<Record<string, unknown>>,
): Promise<void> {
  const stored = storage.get(QUICK_MODEL_KEY, storedOverrideSchema);
  if (stored === undefined) return;

  const writes: [string, string | undefined][] = [
    [QUICK_KIND_SETTING, stored.kind],
    [QUICK_MODEL_SETTING, stored.model],
  ];
  for (const [key, value] of writes) {
    // `null` is this key's default and therefore its untouched state; anything
    // else is the user's own choice and wins over the old blob.
    if (value === undefined || (current[key] ?? null) !== null) continue;
    await settings.set(key, value);
  }
  storage.delete(QUICK_MODEL_KEY);
}
