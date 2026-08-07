/**
 * A task's slug — the name of its folder, derived once and then STORED.
 *
 * Two properties, and the second is the one that is easy to get wrong.
 *
 * **It names a directory**, so it may not be empty, may not be `.` or `..`, and
 * may not contain a separator. A title is user text and the tasks root is a real
 * place on disk; a title of `../../etc/passwd` must not describe where anything
 * goes. Everything outside `[a-z0-9]` collapses to `-` and the ends are trimmed,
 * which makes traversal unrepresentable rather than filtered — there is no
 * sequence of characters left that means "up".
 *
 * **It is derived once and then a stored fact** (D8). The folder is derived from
 * the store, so a slug that were re-derived later would let two tasks titled the
 * same resolve to one directory and quietly share a worktree. `uniqueSlug`
 * therefore takes what is already taken and answers once; the caller writes the
 * answer down, and nothing recomputes it from the title again.
 */

/** Long enough to stay readable; short enough that `<root>/<slug>/<repo>/…` is sane. */
const MAX_LENGTH = 60;

/** What an unrepresentable title becomes. Never empty, never a directory verb. */
const FALLBACK = 'task';

export function slugify(title: string): string {
  const slug = trimSeparators(
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, MAX_LENGTH),
  );
  // `.` and `..` cannot survive the replacement above — both are pure
  // punctuation and collapse to nothing. The check is on the RESULT anyway,
  // because that is the property that matters and it costs one comparison.
  return slug === '' || slug === '.' || slug === '..' ? FALLBACK : slug;
}

/**
 * The first free slug at or after `desired`.
 *
 * Suffixes `-2`, `-3`, … rather than a hash or a timestamp: a person reads these
 * in a file browser, and `fix-login-2` says what it is. The suffix is appended
 * within the length bound, trimming the stem when it has to, so a maximal slug
 * still yields a distinct name rather than colliding at the boundary.
 */
export function uniqueSlug(desired: string, taken: ReadonlySet<string>): string {
  if (!taken.has(desired)) return desired;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const stem = desired.slice(0, MAX_LENGTH - suffix.length);
    const candidate = `${trimSeparators(stem)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Strip leading/trailing separators — including one left behind by a truncation. */
function trimSeparators(value: string): string {
  return value.replace(/^-+|-+$/g, '');
}
