import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cwdIsUnder, folderMatchesAny } from './model/project-dir.ts';
import { isEmptyDigest, type SessionDigest } from './model/session.ts';
import { isSubagentFileName, subagentDirFor } from './parse/subagents.ts';
import { absorb, completeBytes, emptySession, type ParsedSession } from './parse/session.ts';
import { digestOf } from './parse/digest.ts';

/**
 * The stripped-text index — and the only file in this extension that touches disk.
 *
 * **Why an index at all.** recall re-reads every file on every invocation, which
 * is right for a CLI and wrong for a box that answers on each keystroke: the
 * rail's `n in transcripts` row must be true while you type. Measured on a real
 * corpus, 779 files and 481 MB of JSONL reduce to 14.8 MB of conversation, which
 * fits in memory and greps in single-digit milliseconds.
 *
 * **Why it can be incremental.** Session files are append-only, so an entry
 * remembers how many bytes it has consumed and the next refresh reads from there.
 * A file that gained 3 KB costs 3 KB — which is what keeps this responsive while
 * an agent is writing to the very transcript being searched.
 *
 * **Why the yielding matters.** `boundaries.js` denies `worker_threads` to
 * extensions, so this runs on the extension host's own thread — the thread that
 * also serves the rail's tree. It awaits between files so a cold walk cannot
 * freeze the sidebar, and it checks the abort signal on the way, because the
 * keystroke that asked has usually been superseded by another.
 */

/**
 * 2: the entry's digest gained `models`, `usage` and a `seq` on every turn, and
 * the entry gained `subagents`. A v1 file deserializes into a digest missing all
 * of them, so a mismatch is discarded whole rather than migrated.
 */
const CACHE_VERSION = 2;

/** The filesystem calls this needs — an interface so a test needs no real disk. */
export interface IndexFs {
  listDirs(dir: string): readonly string[];
  listFiles(dir: string): readonly string[];
  stat(path: string): { readonly size: number; readonly mtimeMs: number } | null;
  /** Bytes from `from` to the end, decoded as UTF-8. */
  readRange(path: string, from: number): string;
  readText(path: string): string | undefined;
  writeText(path: string, text: string): void;
}

export interface IndexedSession {
  readonly path: string;
  readonly digest: SessionDigest;
  /** Its subagent transcripts, by path. Empty for the great majority. */
  readonly subagents: readonly string[];
}

export interface TranscriptIndex {
  /** Bring every session under `dirs` up to date. Resolves early if aborted. */
  refresh(dirs: readonly string[], signal?: AbortSignal): Promise<void>;
  /** What is known right now — never reads disk. */
  sessionsIn(dirs: readonly string[]): readonly IndexedSession[];
  /**
   * One session, fully parsed — streamed on demand and never cached.
   *
   * This is the other 97%: tool calls, tool output, thinking. Holding it would
   * be exactly what `tasks/store.ts` forbids putting in `ctx.dataDir`.
   */
  parse(path: string): ParsedSession | null;
  /** The subagent transcripts beside a session, read from disk now. */
  subagentsOf(path: string): readonly string[];
  /** Forget everything. A refresh already running may not write its answer back. */
  invalidate(): void;
  save(): void;
}

interface Entry {
  readonly size: number;
  readonly mtimeMs: number;
  /** Bytes already folded in. A trailing partial line is deliberately NOT counted. */
  readonly consumed: number;
  readonly digest: SessionDigest;
  readonly subagents: readonly string[];
}

export const nodeFs: IndexFs = {
  listDirs: (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      // A projects directory that does not exist is a machine where nobody has
      // run the agent yet, not an error worth failing a search over.
      return [];
    }
  },
  listFiles: (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  },
  stat: (path) => {
    try {
      const st = statSync(path);
      return { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  },
  readRange: (path, from) => {
    try {
      return readFileSync(path).subarray(from).toString('utf8');
    } catch {
      return '';
    }
  },
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  writeText: (path, text) => {
    try {
      writeFileSync(path, text, 'utf8');
    } catch {
      // A cache that cannot be written is a slower next launch, not a failure.
    }
  },
};


/**
 * Has the caller given up? — asked as a CALL, deliberately.
 *
 * `signal.aborted` is a readonly property, so a `signal?.aborted === true` guard
 * narrows it to `false` for the rest of the function and TypeScript then rejects
 * every later check as unreachable. It is of course not unreachable: the whole
 * point is that it flips while we are awaiting. Going through a function makes
 * each check its own question.
 */
export function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

export function createIndex(opts: {
  readonly projectsDir: string;
  readonly cacheFile: string;
  readonly fs?: IndexFs;
  readonly log?: (message: string) => void;
}): TranscriptIndex {
  const fs = opts.fs ?? nodeFs;
  const entries = new Map<string, Entry>();
  /**
   * The full parse each entry's digest was projected from — in memory only.
   *
   * An incremental fold needs the whole `ParsedSession` to continue from, and
   * that is exactly the transcript bulk the cache may not hold. So it lives here
   * and dies with the process: after a restart, a file that GREW is re-read from
   * zero, while the far commoner unchanged file answers from its cached digest
   * without being opened at all.
   */
  const parsedByPath = new Map<string, ParsedSession>();
  let loaded = false;
  let dirty = false;
  /**
   * Bumped on every invalidation.
   *
   * A refresh that began before one carries the old generation and must not
   * write its now-stale result back — otherwise an invalidation is silently
   * undone by a walk that resolves just after it. This index is exposed to that:
   * `refresh` awaits between files, so a keystroke can supersede one mid-walk.
   */
  let generation = 0;

  /** The subagent transcripts beside a session. An absent directory is the common case. */
  const subagentsOf = (sessionPath: string): readonly string[] => {
    const dir = subagentDirFor(sessionPath);
    return fs
      .listFiles(dir)
      .filter(isSubagentFileName)
      .map((name) => `${dir}/${name}`);
  };

  const load = (): void => {
    if (loaded) return;
    loaded = true;
    const raw = fs.readText(opts.cacheFile);
    if (raw === undefined) return;
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
      if (parsed.version !== CACHE_VERSION) return;
      if (typeof parsed.entries !== 'object' || parsed.entries === null) return;
      for (const [path, value] of Object.entries(parsed.entries as Record<string, Entry>)) {
        entries.set(path, value);
      }
    } catch {
      // A corrupt cache is a cold start, which is correct and merely slower.
      opts.log?.('recall: cache unreadable, reindexing');
    }
  };

  const refresh = async (dirs: readonly string[], signal?: AbortSignal): Promise<void> => {
    load();
    if (dirs.length === 0 || aborted(signal)) return;
    const mine = generation;

    for (const folder of fs.listDirs(opts.projectsDir)) {
      if (aborted(signal) || mine !== generation) return;
      if (!folderMatchesAny(folder, dirs)) continue;

      const dir = `${opts.projectsDir}/${folder}`;
      for (const name of fs.listFiles(dir)) {
        if (aborted(signal) || mine !== generation) return;

        const path = `${dir}/${name}`;
        const st = fs.stat(path);
        if (st === null) continue;

        const known = entries.get(path);
        if (known !== undefined && known.size === st.size && known.mtimeMs === st.mtimeMs) continue;

        const sessionId = name.replace(/\.jsonl$/, '');
        const carried = parsedByPath.get(path);
        /**
         * Continue only when the file grew AND the parse it grew from is still
         * here. A file that shrank was rewritten rather than appended to, so the
         * stored offset describes bytes that no longer exist; and after a
         * restart the parse is gone even though the entry survived.
         */
        const grew = known !== undefined && carried !== undefined && st.size >= known.size;
        const from = grew ? known.consumed : 0;
        const base = grew ? carried : emptySession(sessionId, path);

        const chunk = fs.readRange(path, from);
        const parsed = absorb(base, chunk);

        // Yield BEFORE writing, so the generation check below sees an
        // invalidation that landed while this file was being read.
        await Promise.resolve();
        if (aborted(signal) || mine !== generation) return;

        parsedByPath.set(path, parsed);
        entries.set(path, {
          size: st.size,
          mtimeMs: st.mtimeMs,
          consumed: from + completeBytes(chunk),
          digest: digestOf(parsed),
          subagents: subagentsOf(path),
        });
        dirty = true;
      }
    }
  };

  return {
    refresh,
    subagentsOf,
    sessionsIn: (dirs) => {
      const out: IndexedSession[] = [];
      for (const [path, entry] of entries) {
        if (isEmptyDigest(entry.digest)) continue;
        if (!cwdIsUnder(entry.digest.cwd, dirs)) continue;
        // `subagents` is absent from a cache written before it existed; an old
        // entry is otherwise perfectly good, so it answers empty rather than
        // forcing a reindex.
        out.push({ path, digest: entry.digest, subagents: entry.subagents ?? [] });
      }
      // Newest first, which is the order a person expects to read them in.
      return out.sort((a, b) => (b.digest.lastTs ?? 0) - (a.digest.lastTs ?? 0));
    },
    parse: (path) => {
      const text = fs.readText(path);
      if (text === undefined) return null;
      const sessionId = (path.split('/').at(-1) ?? path).replace(/\.jsonl$/i, '');
      return absorb(emptySession(sessionId, path), text);
    },
    invalidate: () => {
      generation += 1;
      entries.clear();
      parsedByPath.clear();
      dirty = true;
    },
    save: () => {
      if (!dirty) return;
      fs.writeText(
        opts.cacheFile,
        JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(entries) }),
      );
      dirty = false;
    },
  };
}
