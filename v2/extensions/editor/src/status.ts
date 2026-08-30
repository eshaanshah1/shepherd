/**
 * What a row's mark says — the vocabulary `@pierre/trees` draws from.
 *
 * A rename and a copy collapse to one word because a tree row can only say what
 * happened to the path it IS, and for both of those that answer is the same.
 */
export type StatusKind = 'added' | 'modified' | 'deleted' | 'untracked' | 'renamed';

export interface StatusEntry {
  readonly path: string;
  readonly status: StatusKind;
}

/**
 * `git status --porcelain -z` → the marks the tree draws.
 *
 * **`prefix` is not optional decoration; it is what makes the marks line up.**
 * `git ls-files` in a subdirectory reports paths relative to the CWD, and
 * `git status --porcelain` reports them relative to the REPOSITORY ROOT —
 * neither a `.` pathspec nor `-c status.relativePaths=true` changes it, since
 * porcelain is documented as unaffected by that config. So a pane opened on
 * `<repo>/v2` gets a tree of `extensions/…` and marks for `v2/extensions/…`:
 * two vocabularies with no overlap. Shipped, that drew no marks at all, grew a
 * phantom `v2/` root in the Changes tree, and asked git for diffs of paths that
 * do not exist from that cwd.
 *
 * `prefix` is `git rev-parse --show-prefix` — `''` at the repo root, `v2/`
 * inside it — and a path outside it is DROPPED rather than kept: a sibling
 * directory's edit is real, and is not something this tree has a row for.
 *
 * **`-z`, not the newline form.** A path may legally contain a newline, and the
 * newline form quotes and escapes those — a second parser, for a case that
 * would arrive as silently corrupted rows rather than as an error.
 *
 * **A rename is two fields.** `R  new\0old\0` is ONE entry spread over two
 * NUL-separated values. Consuming one leaves the old path sitting where the
 * next entry's two-character status code should be, and every row after it is
 * garbage — which is why the loop advances an extra step for `R` and `C`.
 */
export function readStatus(out: string, prefix = ''): readonly StatusEntry[] {
  const fields = out.split('\0').filter((field) => field !== '');
  const entries: StatusEntry[] = [];

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    // `XY path` — two status characters, a space, then at least one character
    // of path. Anything shorter is not a record.
    if (field === undefined || field.length < 4) continue;
    const staged = field[0];
    const worktree = field[1];
    const path = field.slice(3);

    if (staged === 'R' || staged === 'C') {
      // The next field is the OLD path, not the next record — skipped whether
      // or not this entry survives the prefix.
      i += 1;
      const rebased = rebase(path, prefix);
      if (rebased !== undefined) entries.push({ path: rebased, status: 'renamed' });
      continue;
    }

    const rebased = rebase(path, prefix);
    if (rebased === undefined) continue;

    if (staged === '?' || worktree === '?') {
      entries.push({ path: rebased, status: 'untracked' });
      continue;
    }

    // The STAGED column wins when both are set: `MM` is a file modified,
    // staged, then modified again, and "modified" is the whole of what a mark
    // can say about it either way.
    const kind = mark(staged) ?? mark(worktree);
    if (kind !== undefined) entries.push({ path: rebased, status: kind });
  }

  return entries;
}

/**
 * `git diff --name-status -z <base>` → the same marks, for work already
 * committed.
 *
 * A DIFFERENT shape from porcelain status and not a second spelling of it: here
 * the status letter is a field of its own and the path is the next one, so the
 * two-character-code parse above would read every letter as a path. A rename is
 * THREE fields (`R100`, old, new) and the row belongs to the new path — the old
 * one no longer exists to draw.
 *
 * A similarity score rides on the letter (`R100`, `C75`), so the letter is read
 * from the first character rather than compared whole.
 */
export function readNameStatus(out: string, prefix = ''): readonly StatusEntry[] {
  const fields = out.split('\0').filter((field) => field !== '');
  const entries: StatusEntry[] = [];

  for (let i = 0; i + 1 < fields.length; i += 2) {
    const code = fields[i]?.[0];
    if (code === undefined) continue;
    if (code === 'R' || code === 'C') {
      // Old path, new path. The extra step is what keeps every later pair
      // aligned; without it the new path is read as the next status code.
      const rebased = rebase(fields[i + 2] ?? '', prefix);
      i += 1;
      if (rebased !== undefined) entries.push({ path: rebased, status: 'renamed' });
      continue;
    }
    const rebased = rebase(fields[i + 1] ?? '', prefix);
    if (rebased === undefined) continue;
    const kind = mark(code);
    if (kind !== undefined) entries.push({ path: rebased, status: kind });
  }

  return entries;
}

/**
 * A repo-root path, as the pane's root sees it — or nothing, if it is elsewhere.
 *
 * The prefix always ends in `/` (git's own form), which is what keeps a sibling
 * named `v2-old/` from matching `v2/`.
 */
function rebase(path: string, prefix: string): string | undefined {
  if (prefix === '') return path;
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  return rest === '' ? undefined : rest;
}

function mark(code: string | undefined): StatusKind | undefined {
  switch (code) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    default:
      return undefined;
  }
}

export interface DiffStat {
  readonly files: number;
  readonly added: number;
  readonly removed: number;
}

/**
 * `git diff --numstat`, summed — how MUCH changed, where `readStatus` answers
 * what.
 *
 * A binary file reports `-` for both counts and is still a changed FILE, so it
 * counts once and contributes no lines. Dropping the row instead would report
 * `0 files` for a turn that replaced an icon, which is the one case where the
 * numbers and the truth part company visibly.
 *
 * Anything that is not three tab-separated fields is skipped rather than
 * guessed at — the same rule the parsers above follow, and what makes this safe
 * against a `-z`-less quoted path arriving from a git that surprises us.
 */
export function readNumstat(stdout: string): DiffStat {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    files += 1;
    added += Number.parseInt(parts[0] ?? '', 10) || 0;
    removed += Number.parseInt(parts[1] ?? '', 10) || 0;
  }
  return { files, added, removed };
}
