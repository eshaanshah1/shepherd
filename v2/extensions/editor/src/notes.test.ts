import { describe, expect, it } from 'vitest';
import { NOTES_ROOT, noteIdFromPath, notePath, readNotes } from './notes.ts';

describe('readNotes', () => {
  it('reads the rows scratch.list answers', () => {
    expect(readNotes({ docs: [{ id: 'scr_a', title: 'Deploy checks', updatedAt: 1 }] })).toEqual([
      { id: 'scr_a', title: 'Deploy checks' },
    ]);
  });

  it('drops a row with no id — an invented one would open somebody else s note', () => {
    expect(readNotes({ docs: [{ title: 'no id' }, { id: 'scr_a', title: 'ok' }] })).toEqual([
      { id: 'scr_a', title: 'ok' },
    ]);
  });

  it('falls back to untitled rather than dropping a row with no title', () => {
    // The id is the identifier; the title is only what it is called. Losing the
    // second is not worth losing the note.
    expect(readNotes({ docs: [{ id: 'scr_a' }] })).toEqual([{ id: 'scr_a', title: 'untitled' }]);
  });

  it('is empty when scratch is not installed, rather than throwing', () => {
    // A build without the scratch extension is a real state, not a failure: no
    // Notes root, and the tree is otherwise fine.
    expect(readNotes(undefined)).toEqual([]);
    expect(readNotes({ docs: 'nope' })).toEqual([]);
    expect(readNotes({ ok: false, reason: 'no such command' })).toEqual([]);
  });
});

describe('notePath', () => {
  it('is under the Notes root and carries the title', () => {
    // Not an equality: the id rides along too, because the tree is keyed by
    // path and two notes with one title would collapse into a single row.
    expect(notePath({ id: 'scr_a', title: 'Deploy checks' })).toContain(
      `${NOTES_ROOT}/Deploy checks`,
    );
  });

  it('disambiguates two notes with the same title', () => {
    const a = notePath({ id: 'scr_a', title: 'Notes' });
    const b = notePath({ id: 'scr_b', title: 'Notes' });
    expect(a).not.toBe(b);
  });

  it('flattens a slash in the title, which would otherwise fake a directory', () => {
    const path = notePath({ id: 'scr_a', title: 'a/b' });
    expect(path.startsWith(`${NOTES_ROOT}/`)).toBe(true);
    // One level under Notes, and no invented `a/` folder in between.
    expect(path.split('/')).toHaveLength(2);
  });

  it('is called Notes, not Scratch', () => {
    // The rail's `Scratchpad` section is loose SHELLS (ADR 0047) and a scratch
    // pane is a markdown DOCUMENT. A third thing called scratch would make the
    // word mean nothing.
    expect(NOTES_ROOT).toBe('Notes');
  });
});

describe('noteIdFromPath', () => {
  const notes = [
    { id: 'scr_a', title: 'One' },
    { id: 'scr_b', title: 'Two' },
  ];

  it('finds the note a row stands for', () => {
    expect(noteIdFromPath(notePath(notes[0]!), notes)).toBe('scr_a');
    expect(noteIdFromPath(notePath(notes[1]!), notes)).toBe('scr_b');
  });

  it('is undefined for a real file path', () => {
    // The rows share one tree, so telling a note from a file is what decides
    // whether a click opens a tab or loads a buffer.
    expect(noteIdFromPath('src/a.ts', notes)).toBeUndefined();
  });

  it('is undefined for a Notes row whose note has since gone', () => {
    expect(noteIdFromPath(`${NOTES_ROOT}/Gone`, notes)).toBeUndefined();
  });
});
