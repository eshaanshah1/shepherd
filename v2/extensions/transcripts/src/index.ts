import { s, type ActivateFn } from '@shepherd/sdk';
import type {
  TranscriptHit,
  TranscriptQuery,
  TranscriptSearchProvider,
} from '@shepherd/ext-tasks/manifest';
import { TRANSCRIPT_SEARCH_POINT_ID } from './manifest.ts';
import { countMatches, matchesIn } from './model/search.ts';
import { bestTitle } from './model/session.ts';
import { emptyRollup, withUsage, type UsageRollup } from './model/usage.ts';
import type { ParsedSession } from './parse/session.ts';
import { aborted, createIndex, type TranscriptIndex } from './store.ts';
import { tail, type Tail } from './watch.ts';

/** The commands this extension answers, named once. */
export const TRANSCRIPT_COMMANDS = {
  read: 'transcripts.read',
  usage: 'transcripts.usage',
  watch: 'transcripts.watch',
  unwatch: 'transcripts.unwatch',
} as const;

/** The topics it speaks on. A consumer subscribes; the parser owns the offset. */
export const TRANSCRIPT_EVENTS = {
  appended: 'transcripts.appended',
  lifecycle: 'transcripts.lifecycle',
} as const;

/** Two rollups added together, model by model. */
function mergeRollups(a: UsageRollup, b: UsageRollup): UsageRollup {
  let out = a;
  for (const [model, usage] of Object.entries(b.byModel)) out = withUsage(out, model, usage);
  return out;
}

/**
 * `shepherd.transcripts` — the reader for Claude Code transcripts.
 *
 * It is its own extension rather than a corner of `tasks` or of `claude-code`,
 * and both halves of that are deliberate. Against `tasks`: this parses a vendor's
 * file format, which is exactly the knowledge D11 exists to keep out of the task
 * model. Against `claude-code`: that extension is about *running* an agent and
 * activates when a kind is needed, while this must answer for a task shipped
 * weeks ago whose agents are long dead and whose worktrees are gone — measured,
 * 33 task directories on this machine are in that state with intact transcripts.
 *
 * It draws nothing. The rail row and the ⇧⌘F overlay are `tasks`' surfaces; what
 * crosses from here is data, which is what would let a second agent vendor
 * replace this wholesale.
 */

/** The longest requested dir that contains `cwd` — the task it belongs to. */
function attributeTo(cwd: string | null, dirs: readonly string[]): string | null {
  if (cwd === null) return null;
  let best: string | null = null;
  for (const dir of dirs) {
    const base = dir.replace(/\/+$/, '');
    if (cwd !== base && !cwd.startsWith(`${base}/`)) continue;
    if (best === null || base.length > best.length) best = base;
  }
  return best;
}

/**
 * One search, against a given index.
 *
 * Exported so it can be tested without an extension host — which leaves
 * `activate` as wiring alone, and wiring is the part a test of this shape cannot
 * check anyway.
 */
export async function searchWith(
  index: TranscriptIndex,
  query: TranscriptQuery,
): Promise<readonly TranscriptHit[]> {
  const needle = query.query.trim();
  if (needle === '' || query.dirs.length === 0) return [];
  if (aborted(query.signal)) return [];

  await index.refresh(query.dirs, query.signal);
  // Checked again: the walk yields between files, so a keystroke can supersede
  // this one while it runs.
  if (aborted(query.signal)) return [];

  const hits: TranscriptHit[] = [];
  for (const session of index.sessionsIn(query.dirs)) {
    const matches = matchesIn(session.digest, needle, query.maxPerSession);
    if (matches.length === 0) continue;

    const dir = attributeTo(session.digest.cwd, query.dirs);
    if (dir === null) continue;

    const title = bestTitle(session.digest);
    hits.push({
      dir,
      sessionId: session.digest.sessionId,
      // Omitted rather than sent as `undefined`: the row falls back to the short
      // id, and an absent key says "no title" more clearly than a present one
      // holding nothing.
      ...(title === null ? {} : { title }),
      when: session.digest.lastTs ?? 0,
      total: countMatches(session.digest, needle),
      matches,
    });
  }
  return hits;
}

export const activate: ActivateFn = (ctx, api) => {
  const { points, commands, events } = api.proposed;

  /**
   * `~/.claude/projects`, composed here rather than handed over resolved.
   *
   * `ctx.homeDir`'s own doc says why the kernel gives raw home instead of a menu
   * of paths: "naming another program's file in this interface would make the
   * kernel the authority on that program's layout, and it is the extension that
   * knows the vendor." This is that extension.
   */
  const index = createIndex({
    projectsDir: `${ctx.homeDir}/.claude/projects`,
    cacheFile: `${ctx.dataDir}/index.json`,
    log: (message) => {
      ctx.log.info(message);
    },
  });

  /** Live tails, by path. One per file however many callers asked for it. */
  const tails = new Map<string, Tail>();

  const pathArg = s.object({ path: s.string() });

  ctx.subscriptions.push(
    commands.register(TRANSCRIPT_COMMANDS.read, {
      // No title: a program asks this, not a person browsing the palette.
      schema: s.object({ path: s.string(), subagents: s.optional(s.boolean()) }),
      /**
       * The parent alone by default, its subagents only when asked.
       *
       * A caller rendering a conversation and a caller totalling tokens want
       * opposite answers here, and neither should pay for the other's.
       */
      handler: (args) => {
        const parsed = index.parse(args.path);
        if (parsed === null) return null;
        if (args.subagents !== true) return parsed;

        const children = index
          .subagentsOf(args.path)
          .map((child) => index.parse(child))
          .filter((child): child is ParsedSession => child !== null);
        return { ...parsed, subagents: children };
      },
    }),

    commands.register(TRANSCRIPT_COMMANDS.usage, {
      schema: pathArg,
      /**
       * Subagents are counted ALWAYS.
       *
       * Their tokens were spent on the parent's behalf, so a total that omitted
       * them would be the same class of wrong the dedupe rule exists to prevent,
       * only in the other direction.
       */
      handler: (args) => {
        const parsed = index.parse(args.path);
        if (parsed === null) return null;
        return index
          .subagentsOf(args.path)
          .map((child) => index.parse(child))
          .filter((child): child is ParsedSession => child !== null)
          .reduce((acc, child) => mergeRollups(acc, child.usage), parsed.usage);
      },
    }),

    commands.register(TRANSCRIPT_COMMANDS.watch, {
      schema: pathArg,
      handler: (args) => {
        if (tails.has(args.path)) return false;
        tails.set(
          args.path,
          tail(
            args.path,
            {
              onAppended: (messages) => {
                events.emit(TRANSCRIPT_EVENTS.appended, { path: args.path, messages });
              },
              onLifecycle: (lifecycle) => {
                events.emit(TRANSCRIPT_EVENTS.lifecycle, { path: args.path, ...lifecycle });
              },
            },
            // The clock is injected all the way down, so a test drives the
            // debounce without sleeping.
            { schedule: (fn, ms) => ctx.clock.setTimeout(fn, ms).dispose },
          ),
        );
        return true;
      },
    }),

    commands.register(TRANSCRIPT_COMMANDS.unwatch, {
      schema: pathArg,
      handler: (args) => {
        tails.get(args.path)?.close();
        return tails.delete(args.path);
      },
    }),

    // Every tail holds a watcher. Deactivation has to close them, or the host
    // keeps a handle on a file nobody is reading.
    {
      dispose: () => {
        for (const open of tails.values()) open.close();
        tails.clear();
      },
    },
  );

  const point = points.get<TranscriptSearchProvider>(TRANSCRIPT_SEARCH_POINT_ID);
  if (point === undefined) {
    /**
     * Reachable when `tasks` is disabled or failed to activate. Logged rather
     * than thrown: a throwing `activate` is a startup failure, and searching
     * transcripts is not load-bearing for anything else in the app.
     */
    ctx.log.warn(`nothing defines ${TRANSCRIPT_SEARCH_POINT_ID} — transcript search is off`);
    // The commands above are already registered and stay so: they answer about
    // a file on disk and owe `tasks` nothing.
    return;
  }

  ctx.subscriptions.push(
    point.register({
      search: async (query) => {
        const hits = await searchWith(index, query);
        // Persisted AFTER answering: the walk is the expensive half and a caller
        // is waiting on it, while the cache only has to be right before the next
        // launch.
        index.save();
        return hits;
      },
    }),
  );
};
