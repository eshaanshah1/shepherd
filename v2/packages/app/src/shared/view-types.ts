/**
 * Which member a view belongs to, carried in its type.
 *
 * `mac-b∷tasks.tree` means "the `tasks.tree` of the member `mac-b`". The prefix
 * is this Mac's own bookkeeping and is stripped before any call leaves —
 * over there it is the ordinary type the phone has always asked for.
 *
 * It lives in `shared` because both halves need it and for opposite reasons:
 * main routes on it, and the page groups on it so that every member's copy of a
 * list is drawn as ONE list rather than one section per machine.
 */

/**
 * A double colon that is one character (U+2237), not two ASCII colons a view
 * type could plausibly contain.
 */
const SEPARATOR = '∷';

export function qualify(memberId: string, type: string): string {
  return `${memberId}${SEPARATOR}${type}`;
}

/** Which member owns this type, or undefined for one of this Mac's own. */
export function memberOf(type: string): string | undefined {
  const at = type.indexOf(SEPARATOR);
  return at < 0 ? undefined : type.slice(0, at);
}

/**
 * The type as the member that owns it knows it.
 *
 * Split on the FIRST separator only: everything after it is the extension's own
 * string and may contain anything, including another separator.
 */
export function unqualify(type: string): string {
  const at = type.indexOf(SEPARATOR);
  return at < 0 ? type : type.slice(at + SEPARATOR.length);
}
