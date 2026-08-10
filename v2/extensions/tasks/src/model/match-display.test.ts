import { describe, expect, it } from 'vitest';
import { fuzzyMatch } from '@shepherd/sdk';
import { displayMatch, segmentsOf } from './match-display.ts';
import { collapseHome, expandHome } from './repo-path.ts';

const HOME = '/Users/eshaannileshshah';

/** What the field actually paints, as one string per state. */
const drawn = (path: string, positions: readonly number[], home = HOME): string =>
  displayMatch(path, positions, home)
    .segments.map((run) => (run.matched ? `[${run.text}]` : run.text))
    .join('');

describe('segmentsOf', () => {
  it('merges adjacent hits, so `shep` is one span and not four', () => {
    expect(segmentsOf('shepherd', [0, 1, 2, 3])).toEqual([
      { text: 'shep', matched: true },
      { text: 'herd', matched: false },
    ]);
  });

  it('keeps scattered hits apart — that is what shows WHY the match won', () => {
    // fzf's whole argument: `shpd` did not match a prefix, and the highlight is
    // the only thing that says which characters it did match.
    expect(segmentsOf('shepherd', [0, 1, 4, 7])).toEqual([
      { text: 'sh', matched: true },
      { text: 'ep', matched: false },
      { text: 'h', matched: true },
      { text: 'er', matched: false },
      { text: 'd', matched: true },
    ]);
  });

  it('always reassembles into the original text', () => {
    for (const positions of [[], [0], [7], [0, 3, 7], [2, 2, 2], [-1, 99]]) {
      expect(segmentsOf('shepherd', positions).map((run) => run.text).join('')).toBe('shepherd');
    }
  });

  it('drops an out-of-range position rather than slicing an empty span in', () => {
    // These arrive from a suggestion provider this code has never seen (D5).
    expect(segmentsOf('abc', [-1, 3, 99, 1.5])).toEqual([{ text: 'abc', matched: false }]);
  });

  it('answers nothing for empty text, not a run of nothing', () => {
    expect(segmentsOf('', [])).toEqual([]);
  });
});

describe('displayMatch', () => {
  it('writes the path the way a person writes it', () => {
    expect(displayMatch(`${HOME}/Home/dev/shepherd`, [], HOME).text).toBe('~/Home/dev/shepherd');
  });

  it('moves the highlight with the text it is drawn over', () => {
    // The positions are indices into the ABSOLUTE path; collapsing home takes
    // characters out from the left, so an unmoved highlight would land that many
    // characters late — and still render, which is why this needs a test rather
    // than a look.
    const path = `${HOME}/Home/dev/shepherd`;
    const positions = fuzzyMatch('shep', 'shepherd')!.positions.map((at) => at + path.length - 8);
    expect(drawn(path, positions)).toBe('~/Home/dev/[shep]herd');
  });

  it('folds a hit inside the home prefix onto the `~` that replaced it', () => {
    // Typing `/Users/…` matches characters that are no longer on screen. Dropping
    // them would render a path with no highlight at all, which reads as "nothing
    // matched" on a row that did.
    expect(drawn(`${HOME}/dev/x`, [0, 1, 2])).toBe('[~]/dev/x');
  });

  it('leaves a path outside home alone, highlight and all', () => {
    expect(drawn('/opt/work/api', [5, 6, 7, 8])).toBe('/opt/[work]/api');
  });

  it('round-trips through expandHome, which is what reads the field back', () => {
    const path = `${HOME}/Home/dev/shepherd`;
    expect(expandHome(collapseHome(path, HOME), HOME)).toBe(path);
  });
});
