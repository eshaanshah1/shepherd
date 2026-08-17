import { describe, expect, it } from 'vitest';
import { segmentsOf, segmentsOfRange } from './segments.ts';

describe('segmentsOf', () => {
  it('merges adjacent hits into one run', () => {
    expect(segmentsOf('shepherd', [0, 1, 2, 3])).toEqual([
      { text: 'shep', matched: true },
      { text: 'herd', matched: false },
    ]);
  });

  it('returns one unmatched run when nothing hit', () => {
    expect(segmentsOf('shepherd', [])).toEqual([{ text: 'shepherd', matched: false }]);
  });

  it('drops out-of-range and duplicate positions', () => {
    expect(segmentsOf('ab', [0, 0, 99, -1])).toEqual([
      { text: 'a', matched: true },
      { text: 'b', matched: false },
    ]);
  });

  it('returns no segments for empty text', () => {
    expect(segmentsOf('', [])).toEqual([]);
  });
});

describe('segmentsOfRange', () => {
  it('cuts a contiguous run into three parts', () => {
    expect(segmentsOfRange('set band.rail to 264', [4, 8])).toEqual([
      { text: 'set ', matched: false },
      { text: 'band', matched: true },
      { text: '.rail to 264', matched: false },
    ]);
  });

  it('omits an empty leading part when the match starts at 0', () => {
    expect(segmentsOfRange('shepherd narrower', [0, 8])).toEqual([
      { text: 'shepherd', matched: true },
      { text: ' narrower', matched: false },
    ]);
  });

  it('clamps a range that runs past the end', () => {
    expect(segmentsOfRange('abc', [1, 99])).toEqual([
      { text: 'a', matched: false },
      { text: 'bc', matched: true },
    ]);
  });

  it('returns one unmatched run for an inverted range', () => {
    expect(segmentsOfRange('abc', [2, 1])).toEqual([{ text: 'abc', matched: false }]);
  });

  it('returns no segments for empty text', () => {
    expect(segmentsOfRange('', [0, 1])).toEqual([]);
  });
});
