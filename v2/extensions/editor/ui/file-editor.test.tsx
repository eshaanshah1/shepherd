import { describe, expect, it } from 'vitest';
import { readDoc, saveNote, saveOutcome } from './file-editor.tsx';

describe('saveOutcome', () => {
  it('is saved when a fresh stamp comes back', () => {
    expect(saveOutcome({ stamp: { mtimeMs: 1, size: 2 } })).toBe('saved');
  });

  it('is stale when the file moved under us', () => {
    // The outcome an agent editing the same worktree produces, and the reason
    // this pane does not autosave.
    expect(saveOutcome({ ok: false, reason: 'stale' })).toBe('stale');
  });

  it('passes any other refusal through as its message', () => {
    expect(saveOutcome({ ok: false, reason: 'EACCES: permission denied' })).toBe(
      'EACCES: permission denied',
    );
  });

  it('does not report success for a shape it cannot read', () => {
    // `ok` says a call succeeded, never that a value has a shape.
    expect(saveOutcome(undefined)).not.toBe('saved');
    expect(saveOutcome({})).not.toBe('saved');
    expect(saveOutcome({ stamp: 'yes' })).not.toBe('saved');
  });
});

describe('saveNote', () => {
  it('says nothing when the save worked', () => {
    expect(saveNote('saved')).toBeUndefined();
  });

  it('tells you your edits survived a stale refusal', () => {
    // The useful half of `stale` is not "it failed" — it is that somebody
    // else's version is on disk and yours is still in the buffer.
    const note = saveNote('stale');
    expect(note).toContain('changed on disk');
    expect(note).toContain('still here');
  });

  it('shows any other refusal verbatim', () => {
    expect(saveNote('EACCES: permission denied')).toBe('EACCES: permission denied');
  });
});

describe('readDoc', () => {
  it('reads the text and its stamp', () => {
    expect(readDoc({ text: 'hi\n', stamp: { mtimeMs: 5, size: 3 } })).toEqual({
      text: 'hi\n',
      stamp: { mtimeMs: 5, size: 3 },
    });
  });

  it('is undefined for a refusal', () => {
    expect(readDoc({ ok: false, reason: 'outside the root' })).toBeUndefined();
  });

  it('is undefined for a stamp it cannot use', () => {
    // A save is checked against this. A defaulted stamp would make the first
    // ⌘S either always refuse or always clobber.
    expect(readDoc({ text: 'hi', stamp: {} })).toBeUndefined();
    expect(readDoc({ text: 'hi' })).toBeUndefined();
  });
});
