/**
 * The scratchpad, as rows in the editor's tree.
 *
 * **`Notes`, never `Scratch`.** The rail's `Scratchpad` section is loose SHELLS
 * (ADR 0047) and a scratch pane is a markdown DOCUMENT. A third thing called
 * scratch in a third place would make the word mean nothing.
 *
 * A row here does NOT render inside the editor pane: clicking one opens or
 * focuses its own `scratch.pad` tab. The boundary lint forbids this extension
 * importing scratch's `ui/`, and the restriction turns out to be the honest
 * design — a note is its own place, not a file in a repo that happens to have
 * no path. What the root buys is one tree listing everything in the task you
 * can edit.
 */
export const NOTES_ROOT = 'Notes';

/**
 * The separator between a note's title and its id in a tree path.
 *
 * A character that does not appear in paths and does not read as punctuation in
 * a name — the id has to be in the path (see `notePath`) but it is not part of
 * what the note is called.
 */
const ID_MARK = '·';

export interface Note {
  readonly id: string;
  readonly title: string;
}

/**
 * What `scratch.list` answered, read rather than cast.
 *
 * `ok` says a call succeeded, never that a value has a shape — and this crossed
 * an IPC port to an extension whose version this build does not pin. A row with
 * no id is DROPPED: the id is the identifier, and an invented one would open
 * somebody else's note. A missing TITLE is defaulted instead, because it is
 * only what the note is called.
 *
 * A build with no `scratch` extension answers nothing, which is a real state
 * and lands on an empty list rather than a refusal.
 */
export function readNotes(value: unknown): readonly Note[] {
  if (typeof value !== 'object' || value === null) return [];
  const docs = (value as { docs?: unknown }).docs;
  if (!Array.isArray(docs)) return [];
  return docs.flatMap((row): Note[] => {
    if (typeof row !== 'object' || row === null) return [];
    const shape = row as { id?: unknown; title?: unknown };
    if (typeof shape.id !== 'string' || shape.id === '') return [];
    const title = typeof shape.title === 'string' && shape.title !== '' ? shape.title : 'untitled';
    return [{ id: shape.id, title }];
  });
}

/**
 * The path the tree holds this note under.
 *
 * The id is appended because the tree is KEYED BY PATH: two notes both called
 * `Notes` would collapse into one row and the second would be unreachable. A
 * slash in a title is flattened for the same class of reason — it would fake a
 * directory that nothing else knows about, and clicking the leaf inside it
 * would resolve to no note at all.
 */
export function notePath(note: Note): string {
  const safe = note.title.replaceAll('/', '-');
  return `${NOTES_ROOT}/${safe}${ID_MARK}${note.id}`;
}

/**
 * Which note a tree row stands for, or none if the row is a file.
 *
 * The two share one tree, so this is what decides whether a click opens a tab
 * or loads a buffer. Matched against the notes we actually hold rather than
 * parsed out of the path: a `Notes/…` row whose note has since been saved to a
 * repo or closed should resolve to nothing, not to an id that no longer exists.
 */
export function noteIdFromPath(path: string, notes: readonly Note[]): string | undefined {
  if (!path.startsWith(`${NOTES_ROOT}/`)) return undefined;
  return notes.find((note) => notePath(note) === path)?.id;
}
