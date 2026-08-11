import type { TreeItem } from '@shepherd/sdk';

/**
 * Several members' rows, drawn as ONE list.
 *
 * The net has one body of work spread over several machines, so a section per
 * member would make the reader do the merging — and would do it worst exactly
 * where it matters: a task finishing over there would start a second DONE list
 * under the first rather than joining it.
 *
 * So the merge is **by heading**. Each member sends rows already grouped by its
 * own sections, this walks them, and rows land under the one copy of each
 * heading. Headings keep the order they were first seen in, which makes the list
 * stable as members come and go — a machine waking up adds rows, it does not
 * reorder the list somebody is reading.
 *
 * What it deliberately does NOT do is understand any heading. "DONE" is a string
 * an extension chose; this matches on it and knows nothing about it, exactly as
 * the dock knows nothing about tasks (sketch §2b).
 */

export interface RowSource {
  /** Whose rows these are — the view type they came from. */
  readonly key: string;
  readonly rows: readonly TreeItem[];
}

export interface MergedRow {
  readonly key: string;
  readonly row: TreeItem;
}

export function mergeRows(sources: readonly RowSource[]): readonly MergedRow[] {
  /** Heading label -> the rows under it, in the order members were asked. */
  const groups = new Map<string, { heading?: MergedRow; counts: (number | undefined)[]; rows: MergedRow[] }>();
  /** Rows above any heading at all. */
  const TOP = '';

  const group = (label: string) => {
    const held = groups.get(label);
    if (held !== undefined) return held;
    const fresh: { heading?: MergedRow; counts: (number | undefined)[]; rows: MergedRow[] } = {
      counts: [],
      rows: [],
    };
    groups.set(label, fresh);
    return fresh;
  };
  group(TOP);

  for (const source of sources) {
    let current = TOP;
    for (const row of source.rows) {
      if (row.section === true) {
        current = row.label;
        const target = group(current);
        // The first member to send a heading supplies the one that is drawn;
        // the rest only contribute their counts.
        target.heading ??= { key: source.key, row };
        target.counts.push(count(row.description));
        continue;
      }
      group(current).rows.push({ key: source.key, row });
    }
  }

  const out: MergedRow[] = [];
  for (const [label, held] of groups) {
    if (label !== TOP && held.heading !== undefined) {
      out.push({ ...held.heading, row: withCount(held.heading.row, held.counts) });
    }
    out.push(...held.rows);
  }
  return out;
}

/**
 * A count that described one machine's list would be a lie about the merged one.
 *
 * Summed when every side counts, dropped when any side does not — a wrong number
 * is worse than no number, and a description is free text an extension may use
 * for something that is not a count at all.
 */
function withCount(heading: TreeItem, counts: readonly (number | undefined)[]): TreeItem {
  if (counts.length === 0) return heading;
  if (counts.some((value) => value === undefined)) {
    const { description: _dropped, ...rest } = heading;
    return rest;
  }
  const total = counts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return { ...heading, description: String(total) };
}

function count(description: string | undefined): number | undefined {
  if (description === undefined) return undefined;
  return /^\d+$/.test(description.trim()) ? Number.parseInt(description, 10) : undefined;
}
