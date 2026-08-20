import { describe, expect, it } from 'vitest';
import { FALLBACK_TITLE, headingTitle, readScratchId, wordCount, SAVE_DEBOUNCE_MS } from './scratch-pane.tsx';

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

describe('headingTitle', () => {
  it('takes a leading heading, at any level', () => {
    expect(headingTitle('# deploy notes')).toBe('deploy notes');
    expect(headingTitle('### deploy notes')).toBe('deploy notes');
    expect(headingTitle('###### deploy notes')).toBe('deploy notes');
  });

  it('skips blank lines people leave at the top', () => {
    expect(headingTitle('\n\n  \n# deploy notes')).toBe('deploy notes');
  });

  it('reads only the FIRST non-empty line', () => {
    expect(headingTitle('# first\n\n# second')).toBe('first');
  });

  it('is undefined when the document opens with prose', () => {
    // A sentence fragment reads worse in a tab than the fallback does, because
    // it looks like it might be a name.
    expect(headingTitle('just some notes\n\n# a heading later')).toBeUndefined();
  });

  it('is undefined for an empty document', () => {
    expect(headingTitle('')).toBeUndefined();
    expect(headingTitle('\n\n   \n')).toBeUndefined();
  });

  it('is undefined for a hash with no space — that is not a heading', () => {
    expect(headingTitle('#notaheading')).toBeUndefined();
  });

  it('is undefined for a hash with nothing after it', () => {
    expect(headingTitle('#')).toBeUndefined();
    expect(headingTitle('#   ')).toBeUndefined();
  });

  it('is undefined for seven hashes, which CommonMark does not allow', () => {
    expect(headingTitle('####### too deep')).toBeUndefined();
  });

  it('drops the closing hashes of a closed ATX heading', () => {
    expect(headingTitle('# deploy notes #')).toBe('deploy notes');
    expect(headingTitle('## deploy notes ###')).toBe('deploy notes');
  });

  it('allows up to three leading spaces, as CommonMark does', () => {
    expect(headingTitle('   # indented')).toBe('indented');
    expect(headingTitle('    # four spaces is a code block')).toBeUndefined();
  });

  it('truncates a heading too long to be a tab', () => {
    const title = headingTitle(`# ${'x'.repeat(80)}`);
    expect(title).toBeDefined();
    expect(title?.length).toBeLessThanOrEqual(40);
    expect(title?.endsWith('…')).toBe(true);
  });

  it('leaves a heading that fits exactly alone', () => {
    expect(headingTitle(`# ${'x'.repeat(40)}`)).toBe('x'.repeat(40));
  });
});

describe('the fallback title', () => {
  it('is the literal word, never null', () => {
    // `layout.rename` accepts null, which CLEARS the user title — and a view
    // pane runs no program, so it would then read `term` rather than `scratch`.
    expect(FALLBACK_TITLE).toBe('scratch');
  });
});
