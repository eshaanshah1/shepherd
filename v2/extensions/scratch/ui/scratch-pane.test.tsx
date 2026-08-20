import { describe, expect, it } from 'vitest';
import { readScratchId, wordCount, SAVE_DEBOUNCE_MS } from './scratch-pane.tsx';

/**
 * The pane's PURE half. Driving real typing through CodeMirror under jsdom is
 * unreliable, and the behaviour worth asserting lives next door in
 * `live-preview.test.ts`, which needs no DOM at all.
 */

describe('readScratchId', () => {
  it('reads the id a pane was opened with', () => {
    expect(readScratchId({ id: 'scr_a' })).toBe('scr_a');
  });

  it('is undefined for a pane restored without one', () => {
    // The case the empty-state notice exists for.
    expect(readScratchId({})).toBeUndefined();
    expect(readScratchId(undefined)).toBeUndefined();
    expect(readScratchId(null)).toBeUndefined();
    expect(readScratchId('scr_a')).toBeUndefined();
    expect(readScratchId({ id: 42 })).toBeUndefined();
    expect(readScratchId({ id: '' })).toBeUndefined();
  });
});

describe('wordCount', () => {
  it('counts words, not characters', () => {
    expect(wordCount('one two three')).toBe(3);
  });

  it('is zero for whitespace alone, which is what closes a pane silently', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('   \n\n  \t ')).toBe(0);
  });

  it('does not care about line breaks or runs of spaces', () => {
    expect(wordCount('one\n\ntwo   three\t\tfour')).toBe(4);
  });
});

describe('the save cadence', () => {
  it('is 400ms, matching the layout store rather than inventing a second one', () => {
    expect(SAVE_DEBOUNCE_MS).toBe(400);
  });
});
