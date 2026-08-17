import type { ActivateFn } from '@shepherd/sdk';
import type {
  TranscriptHit,
  TranscriptQuery,
  TranscriptSearchProvider,
} from '@shepherd/ext-tasks/manifest';
import { TRANSCRIPT_SEARCH_POINT_ID } from './manifest.ts';
import { countMatches, matchesIn } from './model/search.ts';
import { bestTitle } from './model/session.ts';
import { aborted, createIndex, type RecallIndex } from './store.ts';

/**
 * `shepherd.recall` — the reader for past Claude Code sessions.
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
  index: RecallIndex,
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
  const { points } = api.proposed;

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

  const point = points.get<TranscriptSearchProvider>(TRANSCRIPT_SEARCH_POINT_ID);
  if (point === undefined) {
    /**
     * Reachable when `tasks` is disabled or failed to activate. Logged rather
     * than thrown: a throwing `activate` is a startup failure, and searching
     * transcripts is not load-bearing for anything else in the app.
     */
    ctx.log.warn(`nothing defines ${TRANSCRIPT_SEARCH_POINT_ID} — transcript search is off`);
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
