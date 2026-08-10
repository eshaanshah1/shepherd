/**
 * The `#` rule, and the two string operations the picker draws with.
 *
 * Pure and here rather than in the component, because both of these have exactly
 * one correct answer per input and neither needs a DOM to be wrong. The trigger
 * in particular decides whether a keystroke opens a popover over the sentence
 * somebody is writing — a rule that fires when it should not is not a cosmetic
 * defect, it is a picker that appears while you type prose.
 */

export interface DisplaySegment {
  readonly text: string;
  readonly matched: boolean;
}

export interface Trigger {
  /** Index of the `#` in the text it was found in. */
  readonly at: number;
  /** What has been typed after it — the query, `#` excluded. */
  readonly query: string;
}

/**
 * Is there a live `#query` ending at the caret?
 *
 * The rule: the last `#` at or before the caret, with no whitespace between it
 * and the caret. Whitespace ends a mention, which is what makes a space the way
 * out of a picker you did not mean to open.
 *
 * **The `#` must sit at a word boundary** — the start of the line or after
 * whitespace. This is the one addition to the prototype's rule, and it is what
 * stops `C#`, `utf#8` and `issue#42` opening a repo picker mid-word. `#42` after
 * a space still opens one: it is a legitimately ambiguous thing to have typed,
 * and the honest answer is the empty state rather than a rule that guesses.
 *
 * A non-breaking space counts as whitespace on both sides of that rule. It is
 * what gets inserted after a pill, so without it the character immediately after
 * a repo would read as still being inside the previous mention.
 */
export function findTrigger(text: string, offset: number): Trigger | null {
  const before = text.slice(0, offset);
  const at = before.lastIndexOf('#');
  if (at < 0) return null;

  const preceding = at === 0 ? '' : before[at - 1];
  if (preceding !== '' && preceding !== undefined && !/[\s ]/.test(preceding)) return null;

  const query = before.slice(at + 1);
  if (/[\s ]/.test(query)) return null;
  return { at, query };
}

/**
 * Cut the port's match runs in two at `at`, so a row can highlight its name and
 * its parent path as separate columns.
 *
 * The runs arrive already computed by the ranker and are deliberately not
 * re-derived here — a view that re-runs the matcher is a second chance to
 * disagree with whatever did the ordering. Splitting them is not re-deriving
 * them: every character keeps the `matched` flag it crossed the port with, and
 * the two halves still reassemble into the original text.
 *
 * A run straddling the cut becomes two runs of the same flag.
 */
export function splitSegments(
  segments: readonly DisplaySegment[],
  at: number,
): { readonly head: readonly DisplaySegment[]; readonly tail: readonly DisplaySegment[] } {
  const head: DisplaySegment[] = [];
  const tail: DisplaySegment[] = [];
  let seen = 0;
  for (const run of segments) {
    const start = seen;
    const end = seen + run.text.length;
    seen = end;
    if (end <= at) {
      head.push(run);
      continue;
    }
    if (start >= at) {
      tail.push(run);
      continue;
    }
    head.push({ text: run.text.slice(0, at - start), matched: run.matched });
    tail.push({ text: run.text.slice(at - start), matched: run.matched });
  }
  return { head, tail };
}

/**
 * A row, split into the two things it draws: the repo's own name and the
 * directory it sits in.
 *
 * The NAME is the label and the parent is the meta, because a name is what you
 * typed at and a path is what tells two of them apart. `display` is the
 * home-collapsed text the port sends, so the cut is its last `/`.
 */
export interface RowText {
  readonly name: readonly DisplaySegment[];
  readonly parent: readonly DisplaySegment[];
}

export function rowText(display: string, segments: readonly DisplaySegment[]): RowText {
  const cut = display.lastIndexOf('/');
  // No separator: the whole thing is a name, and there is no parent to draw.
  if (cut < 0) return { name: segments, parent: [] };
  const { head, tail } = splitSegments(segments, cut + 1);
  return { name: tail, parent: head };
}

/**
 * The scope line under the editor.
 *
 * Its zero case is the one that matters: it says where an unscoped task LANDS,
 * rather than reporting the absence of a repo. A task with no repo is a valid
 * task in this app — it goes to the inbox — and a line reading "no repo" would
 * make a working state look like an unfinished form.
 */
export function scopeLine(names: readonly string[]): string {
  if (names.length === 0) return 'no repo scoped — lands in inbox';
  if (names.length === 1) return `scoped to ${names[0]}`;
  return `scoped to ${names.length} repos`;
}
