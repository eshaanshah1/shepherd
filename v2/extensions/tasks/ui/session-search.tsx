import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { segmentsOfRange, type ExtensionViewProps } from '@shepherd/sdk';
import { CommandPalette, type MarkState, type PaletteCommand } from '@shepherd/ui';

/**
 * ⇧⌘F — the surface a transcript hit actually fits on.
 *
 * The rail filters titles in place and reports a count; this is where the count
 * is spent. It is `CommandPalette` rather than a new component because the
 * palette already owns everything hard about this shape: the 620px `lg` modal
 * pinned near the top, the query row, group heads that appear only when a group
 * has matches, mousemove-not-mouseenter selection, and close-on-activate. Session
 * search is a second scope inside it, not a third surface.
 */

/** Spelled out rather than imported: `ui/` may not import the service half. */
const TRANSCRIPT_HITS = 'tasks.transcriptHits';
const FILTER = 'tasks.filter';

interface Match {
  readonly source: string;
  readonly text: string;
  readonly at: readonly [number, number];
}

interface Hit {
  readonly sessionId: string;
  /** The session's own title. Secondary — a session is not the unit of work. */
  readonly title?: string;
  /** The TASK this session belongs to, joined on by the extension. */
  readonly task?: string;
  /** That task's state mark — the same one the rail draws for it. */
  readonly mark?: MarkState;
  readonly when: number;
  readonly total: number;
  readonly matches: readonly Match[];
}

/**
 * The states, spelled out.
 *
 * A UI fact, and a narrowing one: `mark` arrives as `unknown` off a port, and
 * handing `StateMark` a string it has no case for would draw an empty slot with
 * no way to tell that from a task that has no state.
 */
const MARKS = new Set<string>(['working', 'waiting', 'ready', 'later', 'failed', 'shipped']);

function readMark(value: unknown): MarkState | undefined {
  return typeof value === 'string' && MARKS.has(value) ? (value as MarkState) : undefined;
}

interface Answer {
  readonly query: string;
  readonly hits: readonly Hit[];
}

/**
 * `unknown` off a port, read defensively.
 *
 * `ok` says the call succeeded, not that the value has a shape — it crossed an
 * IPC boundary and came from an extension this page has never seen. Anything
 * malformed reads as "no answer yet" rather than taking the overlay down.
 */
function readAnswer(value: unknown): Answer | null {
  if (typeof value !== 'object' || value === null) return null;
  const typed = value as { query?: unknown; hits?: unknown };
  if (typeof typed.query !== 'string' || !Array.isArray(typed.hits)) return null;

  const hits: Hit[] = [];
  for (const raw of typed.hits) {
    if (typeof raw !== 'object' || raw === null) continue;
    const hit = raw as Partial<Hit>;
    if (typeof hit.sessionId !== 'string' || !Array.isArray(hit.matches)) continue;
    const mark = readMark((raw as { mark?: unknown }).mark);
    hits.push({
      sessionId: hit.sessionId,
      ...(typeof hit.title === 'string' ? { title: hit.title } : {}),
      ...(typeof hit.task === 'string' ? { task: hit.task } : {}),
      ...(mark === undefined ? {} : { mark }),
      when: typeof hit.when === 'number' ? hit.when : 0,
      total: typeof hit.total === 'number' ? hit.total : hit.matches.length,
      matches: hit.matches as readonly Match[],
    });
  }
  return { query: typed.query, hits };
}

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * One palette row per MATCH, not per session.
 *
 * A session that matched in three places is three places you might want to land,
 * and collapsing them into one row would make that choice for you. The session is
 * named on every one of them, which is what keeps the rows attributable.
 */
function rowsOf(hits: readonly Hit[]): readonly PaletteCommand[] {
  return hits.flatMap((hit) => {
    /*
     * The session's identity, and never a pane: a pane does not survive a restart
     * and does not exist at all for an archived task, which is most of what this
     * searches.
     */
    const short = hit.sessionId.slice(0, 6);
    /*
     * **The TASK names the row.** A session title is the agent's summary of one
     * conversation, so three matches inside one session repeat the same words
     * three times and never once say which piece of work you are looking at —
     * which is the first of the four things a hit has to carry. The session's own
     * title falls back in only when the task is unknown, and the short id behind
     * that.
     */
    const label = hit.task ?? hit.title ?? short;
    const extra = hit.total - hit.matches.length;
    // `a3f81c · 12:38` — which conversation, and when. One cell, because two
    // stacked lines of metadata is more chrome than a result row can carry.
    const when = hit.when === 0 ? short : `${short} · ${clock.format(new Date(hit.when))}`;

    return hit.matches.map((match, at) => ({
      id: `${hit.sessionId}:${String(at)}`,
      title: label,
      group: 'Transcripts',
      // The task's own mark, the same one the rail draws for it — which is what
      // makes the leading slot worth the indent it was already taking.
      ...(hit.mark === undefined ? {} : { mark: hit.mark }),
      detail: segmentsOfRange(match.text, [match.at[0], match.at[1]]),
      meta: when,
      // Only on the first row of a session: repeating `4 more` beside each of its
      // matches would read as four more per row.
      ...(at === 0 && extra > 0 ? { note: `${String(extra)} more` } : {}),
    }));
  });
}

export function SessionSearchView({ invoke, done }: ExtensionViewProps): ReactElement {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [query, setQuery] = useState<string | undefined>(undefined);

  const ask = useCallback(async (): Promise<void> => {
    const result = await invoke(TRANSCRIPT_HITS, {});
    if (!result.ok) return;
    const next = readAnswer(result.value);
    if (next !== null) setAnswer(next);
  }, [invoke]);

  /**
   * Ask on mount, so the overlay opens on the rail's query.
   *
   * This is the whole reason `n in transcripts` carries the query across: the
   * field arrives filled and nothing is retyped. `??` rather than an assignment,
   * so a keystroke that lands during the round trip is not overwritten by the
   * answer to the question it superseded.
   */
  useEffect(() => {
    let live = true;
    void invoke(TRANSCRIPT_HITS, {}).then((result) => {
      if (!live || !result.ok) return;
      const next = readAnswer(result.value);
      if (next === null) return;
      setAnswer(next);
      setQuery((current) => current ?? next.query);
    });
    return () => {
      live = false;
    };
  }, [invoke]);

  const onQueryChange = useCallback(
    (next: string) => {
      setQuery(next);
      /*
       * Typing here moves the RAIL too — one query, two views of it. The
       * alternative was a second query living in this component, which would let
       * the count row and the overlay disagree about what was searched for while
       * both were on screen.
       */
      void invoke(FILTER, { query: next }).then(() => ask());
    },
    [invoke, ask],
  );

  const rows = useMemo(() => rowsOf(answer?.hits ?? []), [answer]);

  return (
    <CommandPalette
      open
      filtered
      query={query ?? ''}
      onQueryChange={onQueryChange}
      onOpenChange={(next) => {
        if (!next) done();
      }}
      commands={rows}
      onRun={() => {
        /*
         * Opening the session AT THE LINE is a recorded follow-up: it needs a
         * verb that resumes a session and scrolls it, and neither half exists
         * yet. Closing is honest in the meantime — the rail behind is already
         * filtered to the tasks that matched.
         */
        done();
      }}
      placeholder="Search sessions…"
      emptyLabel="No matching transcript"
    />
  );
}
