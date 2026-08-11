/**
 * What a task's tabs look like once they are shelved, and how to name the file
 * each one's screen goes in.
 *
 * Pure and total — no `fs`, no commands, no host. It takes what the layout said
 * and what the record knows, and joins them; the IO around it is `index.ts`'s.
 *
 * The shape exists because archiving used to throw the layout away. A task's
 * worktrees were snapshotted and its panes closed, and what came back was one
 * root with one shell in it — which was fine while a task WAS one pane group,
 * and became a loss the moment it could be five tabs of work in progress.
 */

/** A pane, as it was when the task was shelved. */
export interface ArchivedPane {
  /**
   * The id it had. A restored pane gets a NEW one — `deserializeNode` mints them
   * by design — so this is a correlation key within the archive and never
   * something to look up later.
   */
  readonly pane: string;
  readonly cwd: string | null;
  readonly userTitle: string | null;
  /**
   * The session it was showing, and who was running in it.
   *
   * All three are **opaque** (D11). They come from the agent kind that captured
   * them and go back through the same seam; the moment this extension reads one
   * it has learned which agent it hired, and the second kind will not fit.
   */
  readonly sessionId?: string;
  readonly kindId?: string;
  readonly resumeTarget?: string;
  /** Where this pane's captured screen went, relative to the archive dir. */
  readonly history?: string;
}

/** One tab — a layout root — as it was. */
export interface ArchivedTab {
  readonly root: string;
  /**
   * The split shape, in the layout's own persisted vocabulary.
   *
   * Carried verbatim and never interpreted here: it is `serialize.ts`'s format,
   * the layout is what will rebuild from it, and a second reader of that shape
   * in an extension is a second thing to keep in step with it.
   */
  readonly tree?: unknown;
  readonly focusedPane: string | null;
  readonly panes: readonly ArchivedPane[];
}

/** What the layout said about one root, and what the record knows about a pane. */
export interface RootReading {
  readonly root: string;
  readonly tree?: unknown;
  readonly focusedPane: string | null;
  readonly panes: readonly { readonly pane: string; readonly cwd: string | null; readonly userTitle: string | null }[];
}

export interface SessionReading {
  readonly pane: string;
  readonly sessionId?: string;
  readonly kindId?: string;
  readonly resumeTarget?: string;
}

export interface ArchiveInput {
  readonly roots: readonly RootReading[];
  readonly sessions: readonly SessionReading[];
  /** Which panes' screens were captured, and where they went. */
  readonly history?: Readonly<Record<string, string>>;
}

/**
 * Join the layout's roots to the record's sessions, by pane.
 *
 * By PANE and not by session id, deliberately: a task's record carries a
 * `pending-` session id for the first seconds of a spawn, and only its pane is
 * true in that window. The same reasoning that put `pane` on `TaskSession`.
 */
export function archiveTabsFrom(input: ArchiveInput): readonly ArchivedTab[] {
  const byPane = new Map(input.sessions.map((session) => [session.pane, session]));
  return input.roots.map((root) => ({
    root: root.root,
    ...(root.tree === undefined ? {} : { tree: root.tree }),
    focusedPane: root.focusedPane,
    panes: root.panes.map((pane) => {
      const session = byPane.get(pane.pane);
      const history = input.history?.[pane.pane];
      return {
        pane: pane.pane,
        cwd: pane.cwd,
        userTitle: pane.userTitle,
        // Absent rather than null for a pane that had no agent: an absent field
        // is "there was nothing here", and a null one invites a reader to
        // wonder which of the two it means.
        ...(session?.sessionId === undefined ? {} : { sessionId: session.sessionId }),
        ...(session?.kindId === undefined ? {} : { kindId: session.kindId }),
        ...(session?.resumeTarget === undefined ? {} : { resumeTarget: session.resumeTarget }),
        ...(history === undefined ? {} : { history }),
      };
    }),
  }));
}

/**
 * Where one pane's screen goes, relative to the archive directory.
 *
 * **Every segment is sanitised**, and that is not tidiness: a root id contains
 * `:` and `/` by construction (`task:t1/tab-2`), so a path built by
 * concatenation would write outside the directory it was meant to — and a task
 * id is a string this extension mints but a root id can be handed to it.
 */
export function historyPath(taskId: string, root: string, pane: string): string {
  return `${safe(taskId)}/${safe(root)}/${safe(pane)}.term`;
}

/**
 * A dot is NOT in the allow-list, and that is the whole point of the function.
 *
 * Keeping it would leave `..` intact — `../..` sanitises to itself — and a
 * segment that is two dots is a directory traversal wearing a costume. The
 * `.term` suffix is appended outside this, so nothing legible is lost.
 */
const safe = (segment: string): string => segment.replace(/[^A-Za-z0-9_-]/g, '_');
