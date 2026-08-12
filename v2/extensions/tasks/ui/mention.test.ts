import { describe, expect, it } from 'vitest';
import { findTrigger, isUnwritten, rowText, scopeLine, splitSegments } from './mention.ts';

/**
 * The `#` rule, on its own.
 *
 * It is here rather than only in the component's test because it decides whether
 * a popover appears over a sentence somebody is writing — the failure mode is not
 * a wrong pixel, it is a picker that opens while you type prose. Every case below
 * is a string somebody will type.
 */

const NBSP = ' ';

describe('findTrigger', () => {
  it('finds a `#` at the start of the line', () => {
    expect(findTrigger('#she', 4)).toEqual({ at: 0, query: 'she' });
  });

  it('finds one mid-sentence, which is the whole point', () => {
    const text = 'fix the retry loop in #she';
    expect(findTrigger(text, text.length)).toEqual({ at: 22, query: 'she' });
  });

  it('opens on a bare `#` with nothing after it', () => {
    // The moment you type it. The history is already loaded, so the first
    // keystroke has rows under it.
    expect(findTrigger('#', 1)).toEqual({ at: 0, query: '' });
  });

  it('reads only up to the CARET, never the whole line', () => {
    // Somebody who goes back to fix a typo earlier in the sentence is not
    // mentioning the repo named later in it.
    expect(findTrigger('#shepherd and more', 4)).toEqual({ at: 0, query: 'she' });
  });

  it('takes the LAST `#`, because that is the one being typed', () => {
    expect(findTrigger('#one and #two', 13)).toEqual({ at: 9, query: 'two' });
  });

  describe('does not fire on a `#` inside a word', () => {
    // The one addition to the prototype's rule. Each of these is a real thing
    // people write, and a repo picker over any of them is noise.
    it.each([
      ['written in C#', 13],
      ['utf#8', 5],
      ['issue#42', 8],
      ['a#b', 3],
    ])('%s', (text, offset) => {
      expect(findTrigger(text, offset)).toBeNull();
    });
  });

  it('fires after whitespace, which is what makes it a word boundary', () => {
    expect(findTrigger('in #s', 5)).toEqual({ at: 3, query: 's' });
    expect(findTrigger('in\t#s', 5)).toEqual({ at: 3, query: 's' });
  });

  it('fires after the non-breaking space a pill leaves behind', () => {
    // `pick` inserts one after every pill, so without this the character right
    // after a repo would read as still being inside the previous mention — and a
    // second `#repo` in one sentence would never open a picker.
    expect(findTrigger(`${NBSP}#s`, 3)).toEqual({ at: 1, query: 's' });
  });

  it('closes on whitespace, which is how you leave one you did not want', () => {
    expect(findTrigger('#she ', 5)).toBeNull();
    expect(findTrigger('#she and', 8)).toBeNull();
  });

  it('closes on a non-breaking space too', () => {
    // Otherwise the query after an inserted pill would run on forever.
    expect(findTrigger(`#she${NBSP}`, 5)).toBeNull();
  });

  it('is null when there is no `#` at all', () => {
    expect(findTrigger('ship it', 7)).toBeNull();
  });

  it('keeps a path query intact, separators and all', () => {
    // The capability a name-only picker would have lost: `~` and `/` are ordinary
    // query characters, and `tasks.suggestRepos` is what decides they mean a path.
    expect(findTrigger('#~/dev/she', 10)).toEqual({ at: 0, query: '~/dev/she' });
  });
});

describe('splitSegments', () => {
  const runs = [
    { text: '~/dev/', matched: false },
    { text: 'she', matched: true },
    { text: 'pherd', matched: false },
  ];

  it('cuts on a run boundary', () => {
    const { head, tail } = splitSegments(runs, 6);
    expect(head).toEqual([{ text: '~/dev/', matched: false }]);
    expect(tail).toEqual([
      { text: 'she', matched: true },
      { text: 'pherd', matched: false },
    ]);
  });

  it('splits a run that straddles the cut, keeping its flag on both halves', () => {
    const { head, tail } = splitSegments(runs, 8);
    expect(head).toEqual([
      { text: '~/dev/', matched: false },
      { text: 'sh', matched: true },
    ]);
    expect(tail).toEqual([
      { text: 'e', matched: true },
      { text: 'pherd', matched: false },
    ]);
  });

  it('reassembles into the original text, whatever the cut', () => {
    // The invariant that matters: the only thing worse than no highlight is a
    // highlight that silently renames the path it is drawn over.
    const whole = runs.map((run) => run.text).join('');
    for (let at = 0; at <= whole.length; at += 1) {
      const { head, tail } = splitSegments(runs, at);
      const rebuilt = [...head, ...tail].map((run) => run.text).join('');
      expect(rebuilt).toBe(whole);
    }
  });
});

describe('rowText', () => {
  it('puts the name in the label and its directory in the meta', () => {
    const { name, parent } = rowText('~/dev/shepherd', [
      { text: '~/dev/', matched: false },
      { text: 'she', matched: true },
      { text: 'pherd', matched: false },
    ]);
    expect(name.map((run) => run.text).join('')).toBe('shepherd');
    expect(parent.map((run) => run.text).join('')).toBe('~/dev/');
    // The hit travels with the name, which is what it was matched against.
    expect(name.filter((run) => run.matched).map((run) => run.text)).toEqual(['she']);
  });

  it('treats a bare name as all label and no meta', () => {
    const { name, parent } = rowText('shepherd', [{ text: 'shepherd', matched: false }]);
    expect(name).toEqual([{ text: 'shepherd', matched: false }]);
    expect(parent).toEqual([]);
  });
});

describe('scopeLine', () => {
  it('says where an unscoped task LANDS, not that a field is empty', () => {
    // A task with no repo is a valid task in this app. "no repo" alone would make
    // a working state read as an unfinished form.
    expect(scopeLine([])).toBe('no repo scoped — lands in inbox');
  });

  it('names the one', () => {
    expect(scopeLine(['shepherd'])).toBe('scoped to shepherd');
  });

  it('counts the many, because names would run off the row', () => {
    expect(scopeLine(['shepherd', 'harbor-api'])).toBe('scoped to 2 repos');
  });
});

describe('isUnwritten', () => {
  it('counts an empty field, and one holding only the trigger it typed itself', () => {
    // The `#` is what the button types and what opens the picker; nobody chose it
    // as a word, so ⎋ has nothing to protect and closes the card with the picker.
    expect(isUnwritten('')).toBe(true);
    expect(isUnwritten('#')).toBe(true);
    expect(isUnwritten('  #  ')).toBe(true);
    // A non-breaking space is what `pick` inserts after a pill, and `\s` covers
    // it — so a field this component whitespaced still reads as empty.
    expect(isUnwritten(`#${NBSP}`)).toBe(true);
  });

  it('counts a query as written, because ⎋ then keeps what was typed', () => {
    // The rule the picker already had: dismissing a popover must not take the
    // characters away, so `#she` is a first ⎋ that closes only the picker.
    expect(isUnwritten('#she')).toBe(false);
    expect(isUnwritten('fix the retry loop')).toBe(false);
    expect(isUnwritten('fix it in #')).toBe(false);
  });
});
/*
 * `placePicker` and its seven cases are GONE, with the popover they placed.
 *
 * The picker is fused to the bottom of the well now (see `repo-picker.tsx`), so
 * there are no coordinates to compute: no caret to hang from, no clamp to the
 * card, no flip when the room below runs out. Recording that here rather than
 * leaving a silent deletion — the arithmetic was correct and well covered, and it
 * was deleted because the thing it positioned stopped needing a position.
 */
