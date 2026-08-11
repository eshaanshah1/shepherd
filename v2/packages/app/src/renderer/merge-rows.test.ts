import { describe, expect, it } from 'vitest';
import type { TreeItem } from '@shepherd/sdk';
import { mergeRows } from './merge-rows.ts';

/**
 * One list, not one list per machine.
 *
 * The net has three Macs and one body of work; a sidebar with a section per
 * member makes the reader do the merging, and does it worst exactly when it
 * matters — a task finishing over there should join the same DONE list as one
 * finishing here, not start a second one underneath it.
 */

const rows = (...items: TreeItem[]): readonly TreeItem[] => items;
const section = (id: string, label: string, description?: string): TreeItem => ({
  id,
  label,
  section: true,
  ...(description === undefined ? {} : { description }),
});
const task = (id: string, label: string): TreeItem => ({ id, label });

describe('mergeRows', () => {
  it('puts every member’s rows under one copy of each heading', () => {
    const merged = mergeRows([
      { key: 'here', rows: rows(section('s1', 'IN PROGRESS'), task('a', 'A'), section('s2', 'DONE'), task('b', 'B')) },
      { key: 'there', rows: rows(section('s1', 'IN PROGRESS'), task('c', 'C'), section('s2', 'DONE'), task('d', 'D')) },
    ]);

    expect(merged.map((entry) => `${entry.key}:${entry.row.label}`)).toEqual([
      'here:IN PROGRESS',
      'here:A',
      'there:C',
      'here:DONE',
      'here:B',
      'there:D',
    ]);
  });

  it('keeps the order headings first appeared in, across members', () => {
    const merged = mergeRows([
      { key: 'here', rows: rows(section('s2', 'DONE'), task('b', 'B')) },
      { key: 'there', rows: rows(section('s1', 'IN PROGRESS'), task('c', 'C'), section('s2', 'DONE'), task('d', 'D')) },
    ]);

    expect(merged.filter((entry) => entry.row.section === true).map((entry) => entry.row.label)).toEqual([
      'DONE',
      'IN PROGRESS',
    ]);
  });

  /**
   * A count that described one machine's list would be a lie about the merged
   * one. Summed when every side counts, dropped when any side does not — a
   * wrong number is worse than no number.
   */
  it('sums the counts on a heading, and drops them when one side has none', () => {
    const summed = mergeRows([
      { key: 'here', rows: rows(section('s', 'DONE', '2'), task('a', 'A')) },
      { key: 'there', rows: rows(section('s', 'DONE', '3'), task('b', 'B')) },
    ]);
    expect(summed[0]?.row.description).toBe('5');

    const dropped = mergeRows([
      { key: 'here', rows: rows(section('s', 'DONE', '2'), task('a', 'A')) },
      { key: 'there', rows: rows(section('s', 'DONE', 'lots'), task('b', 'B')) },
    ]);
    expect(dropped[0]?.row.description).toBeUndefined();
  });

  it('keeps rows that sit above any heading at the top', () => {
    const merged = mergeRows([
      { key: 'here', rows: rows(task('a', 'A'), section('s', 'DONE'), task('b', 'B')) },
      { key: 'there', rows: rows(task('c', 'C')) },
    ]);
    expect(merged.map((entry) => entry.row.label)).toEqual(['A', 'C', 'DONE', 'B']);
  });

  it('is a plain pass-through for a single member', () => {
    const only = rows(section('s', 'DONE'), task('a', 'A'));
    expect(mergeRows([{ key: 'here', rows: only }]).map((entry) => entry.row)).toEqual([...only]);
  });

  it('says which member each row came from, since the list no longer does', () => {
    const merged = mergeRows([
      { key: 'here', rows: rows(task('a', 'A')) },
      { key: 'there', rows: rows(task('b', 'B')) },
    ]);
    expect(merged.map((entry) => entry.key)).toEqual(['here', 'there']);
  });
});
