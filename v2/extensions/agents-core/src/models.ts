import type { AgentKind } from './kind.ts';

/**
 * What the app offers when it asks "which model?", and which one it offers first.
 *
 * Pure, so both are testable; one file, because a default outside the offered
 * list is a `--model` nobody can see or change back to. Neither names a vendor —
 * the ids, labels and default all arrive from whichever kinds registered (D11).
 */

/** One row of a model menu, in `SelectOption`'s shape so nothing reshapes it. */
export interface ModelChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/**
 * Every model every registered kind will run.
 *
 * The kind is named only when more than one is registered — with two, `sonnet`
 * and `sonnet` are different models sharing a label; with one it is noise in the
 * column a row draws its description in.
 */
export function modelChoices(kinds: readonly AgentKind[]): readonly ModelChoice[] {
  const named = kinds.length > 1;
  return kinds.flatMap((kind) =>
    (kind.listModels?.() ?? []).map((model) => {
      const parts = [...(named ? [kind.id] : []), ...(model.note === undefined ? [] : [model.note])];
      return {
        value: model.id,
        label: model.label,
        // Absent, not empty: an empty description still reserves its column.
        ...(parts.length === 0 ? {} : { description: parts.join(' · ') }),
      };
    }),
  );
}

/**
 * Which model a new interactive agent opens on — resolved, never "unset": the
 * user's setting, else what a kind declares, else the first model offered.
 *
 * Each candidate must still be ON the menu. A value in no option draws an em dash
 * and reaches `--model` as an id the vendor has retired.
 *
 * `null` only when nothing lists a model at all; the caller then sends none and
 * the vendor's own default applies.
 */
export function resolveDefaultModel(kinds: readonly AgentKind[], chosen: string | null): string | null {
  const offered = modelChoices(kinds);
  if (chosen !== null && offered.some((model) => model.value === chosen)) return chosen;
  const declared = kinds.find((kind) => kind.defaultModel !== undefined)?.defaultModel;
  if (declared !== undefined && offered.some((model) => model.value === declared)) return declared;
  return offered[0]?.value ?? null;
}
