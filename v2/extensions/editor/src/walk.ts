import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The cap, borrowed from t3code's `WORKSPACE_INDEX_MAX_ENTRIES`.
 *
 * `useFileTree` holds its `paths` in full, so this is a real ceiling rather
 * than a paging hint.
 */
export const WALK_MAX_ENTRIES = 25_000;

export interface Walked {
  readonly paths: readonly string[];
  /** The cap was hit. The pane must SAY so rather than show a partial tree. */
  readonly truncated: boolean;
}

/**
 * The fallback for a root that is not a git repository.
 *
 * Only `.git` is pruned. There is no gitignore to consult — that is precisely
 * what makes this the fallback rather than the main path (`paths.ts`) — so the
 * cap is the only thing standing between the tree and somebody's home
 * directory.
 */
export function walk(root: string, max: number = WALK_MAX_ENTRIES): Walked {
  const paths: string[] = [];
  let truncated = false;

  const descend = (dir: string, prefix: string): void => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A directory we cannot read is skipped, not fatal: one EACCES should not
      // cost the user the other nine thousand files.
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === '.git') continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        descend(join(dir, entry.name), rel);
        if (truncated) return;
        continue;
      }
      if (paths.length >= max) {
        truncated = true;
        return;
      }
      paths.push(rel);
    }
  };

  descend(root, '');
  return { paths, truncated };
}
