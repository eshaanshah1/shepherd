import { s, type KV } from '@shepherd/sdk';
import { expandHome } from './model/path.ts';

/**
 * Where a hook lives: this extension's KV, and nowhere else.
 *
 * Not a config file, and not a dotfile in the repo — deliberately. A hook is
 * personal: it copies this machine's `.env`, symlinks this machine's caches,
 * names directories only this machine has. Keeping it in the database means it
 * is reachable through the app and the Shepherd CLI and cannot be committed
 * into a repo somebody else clones.
 *
 * The SOURCE repo path is the key, because it is the only stable identity a repo
 * has in v2 — there is no repo registry, just the `{path, name}` a user picks
 * per task. Which makes `expandHome` load-bearing rather than cosmetic: two
 * spellings of one path have to be one hook.
 */
const GLOBAL_KEY = 'hook:global';
const REPO_PREFIX = 'hook:repo:';
/**
 * A hook for a SET of repos, run once at the task root.
 *
 * `hook:set:` and not `hook:repos:` — the latter is one character away from
 * being caught by `startsWith(REPO_PREFIX)`, and a prefix scheme that survives
 * only by arithmetic is one rename away from `listRepos()` returning set keys.
 *
 * The members are joined by `\n`, which cannot appear in any path a repo picker
 * can produce, so the key round-trips by `split('\n')`.
 */
const SET_PREFIX = 'hook:set:';
const SET_SEPARATOR = '\n';

const hookSchema = s.object({ script: s.string() });

export interface StoredHook {
  readonly path: string;
  readonly script: string;
}

export interface StoredSet {
  readonly paths: readonly string[];
  readonly script: string;
}

export interface HookStore {
  /** The script that runs for EVERY repo, or `undefined`. */
  global(): string | undefined;
  setGlobal(script: string): void;
  forRepo(path: string): string | undefined;
  setForRepo(path: string, script: string): void;
  /** Every repo that has a hook, sorted by path. Never includes the global one. */
  listRepos(): readonly StoredHook[];
  /**
   * A set's members as the store identifies them — expanded, deduped, sorted.
   *
   * Exposed because a set's NAME has to come from its identity rather than from
   * whatever order a caller typed: `{beta, alpha}` and `{alpha, beta}` are one
   * hook, and reporting the second as `beta + alpha` would give one hook two
   * names depending on who asked.
   */
  membersOf(paths: readonly string[]): readonly string[];
  /** The script for exactly this set of repos, or `undefined`. */
  forSet(paths: readonly string[]): string | undefined;
  /** Empty script clears. **Throws** on an empty set — see `keyForSet`. */
  setForSet(paths: readonly string[], script: string): void;
  /** Every stored set, by size then key. Never a repo hook or the global one. */
  listSets(): readonly StoredSet[];
}

export function createStore(kv: KV, home: string): HookStore {
  const keyFor = (path: string): string => `${REPO_PREFIX}${expandHome(path.trim(), home)}`;

  /**
   * The members, expanded, deduped, sorted, joined — in that order.
   *
   * Deduping AFTER expansion is what makes `~/dev/alpha` and
   * `/Users/x/dev/alpha` one member rather than two, and sorting is what makes
   * `{a,b}` and `{b,a}` one hook. Both are identity, not tidiness: this string
   * IS the hook.
   */
  const membersOf = (paths: readonly string[]): readonly string[] =>
    [...new Set(paths.map((path) => expandHome(path.trim(), home)))].sort();

  const keyForSet = (paths: readonly string[]): string => `${SET_PREFIX}${membersOf(paths).join(SET_SEPARATOR)}`;

  /**
   * Empty clears, which is v1's `setWorktreeHook` and v1's reasoning: a stored
   * empty string is a hook that runs `/bin/bash -lc ''` against every worktree —
   * a no-op that still costs a process and still reads as configured.
   */
  const write = (key: string, script: string): void => {
    const trimmed = script.trim();
    if (trimmed === '') kv.delete(key);
    else kv.set(key, { script: trimmed });
  };

  const read = (key: string): string | undefined => {
    // `kv.get` answers `undefined` for a value that no longer parses, and that
    // is the right degradation here: "there is no hook" is survivable, and a
    // throw would be thrown in the middle of provisioning somebody's task.
    const stored = kv.get(key, hookSchema);
    return stored === undefined || stored.script.trim() === '' ? undefined : stored.script;
  };

  return {
    global: () => read(GLOBAL_KEY),
    setGlobal: (script) => write(GLOBAL_KEY, script),
    forRepo: (path) => read(keyFor(path)),
    setForRepo: (path, script) => write(keyFor(path), script),
    listRepos: () =>
      kv
        .keys()
        .filter((key) => key.startsWith(REPO_PREFIX))
        .map((key) => ({ path: key.slice(REPO_PREFIX.length), script: read(key) }))
        .filter((hook): hook is StoredHook => hook.script !== undefined)
        .sort((a, b) => a.path.localeCompare(b.path)),
    membersOf: (paths) => membersOf(paths),
    forSet: (paths) => (paths.length === 0 ? undefined : read(keyForSet(paths))),
    setForSet: (paths, script) => {
      // A write forms the identity, so this one is refused rather than
      // degraded: an empty set is a subset of every task — a second global hook
      // — and its key would be the bare prefix.
      if (membersOf(paths).length === 0) throw new Error('a set hook needs at least one repo');
      write(keyForSet(paths), script);
    },
    listSets: () =>
      kv
        .keys()
        .filter((key) => key.startsWith(SET_PREFIX))
        // Annotated, so the narrowing below is legal: `StoredSet.paths` is a
        // `readonly string[]`, and a predicate's type must be assignable to its
        // parameter's — which an inferred mutable `string[]` is not.
        .map((key): { readonly paths: readonly string[]; readonly script: string | undefined } => ({
          paths: key.slice(SET_PREFIX.length).split(SET_SEPARATOR),
          script: read(key),
        }))
        .filter((set): set is StoredSet => set.script !== undefined)
        .sort(
          (a, b) =>
            a.paths.length - b.paths.length ||
            a.paths.join(SET_SEPARATOR).localeCompare(b.paths.join(SET_SEPARATOR)),
        ),
  };
}
