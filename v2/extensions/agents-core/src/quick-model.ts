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
