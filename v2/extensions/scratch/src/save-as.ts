import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * A note, given a path.
 *
 * This is the moment the sentence becomes a verb: **a scratchpad is a document
 * that has not chosen a path yet.** Before this, a buffer lives in the KV with
 * an id and no location; after it, it is a file, and the editor is where you
 * edit it. That is the whole of what these two panes have to reconcile — the
 * subject differs, and this is the door between the two subjects.
 *
 * It REFUSES an existing file rather than overwriting one. Saving a note is
 * creating a document; replacing one the user already has is a different verb
 * with a different confirmation, and this is not it.
 *
 * `node:fs` directly and no new permission for it: fs and path are stdlib, the
 * same reasoning `install.ts` records for writing a skill.
 */
export function saveAs(
  root: string,
  rel: string,
  text: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  /*
   * Resolved and compared rather than pattern-matched: `a/../../b` contains no
   * leading `..` and still leaves the root.
   */
  if (isAbsolute(rel)) return { ok: false, reason: 'outside the root' };
  const full = resolve(join(root, rel));
  const back = relative(resolve(root), full);
  if (back === '' || back.startsWith('..') || isAbsolute(back)) {
    return { ok: false, reason: 'outside the root' };
  }

  if (existsSync(full)) return { ok: false, reason: 'already exists' };

  try {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : 'could not write' };
  }
}
