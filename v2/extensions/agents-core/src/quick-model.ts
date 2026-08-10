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
