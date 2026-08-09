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

const hookSchema = s.object({ script: s.string() });

export interface StoredHook {
  readonly path: string;
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
}

export function createStore(kv: KV, home: string): HookStore {
  const keyFor = (path: string): string => `${REPO_PREFIX}${expandHome(path.trim(), home)}`;

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
  };
}
