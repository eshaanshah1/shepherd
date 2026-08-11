import { sessionId as toSessionId, type CategoryLogger, type PresentEffect, type TreeItem } from '@shepherd/sdk';
import type { RosterEntry } from '@shepherd/remote';
import { memberOf, qualify, unqualify, type ViewContributionDTO } from '../shared/index.ts';

/**
 * Another member's views, drawn on this Mac.
 *
 * **A remote view is not a kind of view.** It is the same three-call
 * conversation the sidebar already has — which views exist, what rows does this
 * one have, run this row's verb — held with a different member. So this module
 * adds exactly one thing: which member a view type belongs to. There is no
 * mirroring, no view-sharing protocol and no second vocabulary, because §4.3's
 * rule is that everything reaches ONE command registry and remote is a
 * transport into it, not a dialect of it.
 *
 * **The qualification is local bookkeeping.** `mac-b∷tasks.tree` means "the
 * `tasks.tree` of the member `mac-b`", and the prefix is stripped before the
 * call leaves this machine — over there it is just `tasks.tree`, exactly as the
 * phone asks for it. Nothing on the other Mac knows or needs to know that
 * somebody is calling it by a longer name.
 *
 * **A member that cannot be reached is a missing section, not a broken window.**
 * These are machines that sleep, move networks and get closed; a sidebar that
 * failed to draw because one of them was asleep would be a sidebar nobody could
 * rely on.
 *
 * That rule is why `list` does not go to the wire. Catching each member's error
 * was only half of it: a Mac that is switched off does not fail, it says
 * *nothing* — and the window's `views.list` awaited every member before it
 * answered, so two paired Macs that were off left the sidebar empty for as long
 * as the app ran, this Mac's own views included. The members are asked in the
 * background and the answer arrives as the same `changed` nudge a local
 * extension raises, because the shell already re-reads on one.
 */

export interface RemoteViewsOptions {
  /** The net's roster, read per call so a member that just joined is included. */
  readonly members: () => readonly RosterEntry[];
  readonly invokeAt: (memberId: string, command: string, args: unknown) => Promise<unknown>;
  /**
   * Raised when a refresh changed what `list` answers — the same nudge a local
   * view raises, so the shell re-reads through the path it already has.
   */
  readonly changed?: () => void;
  readonly log: CategoryLogger;
}

export interface RemoteViews {
  /** Whether this view type belongs to a member rather than to this Mac. */
  owns(type: string): boolean;
  /**
   * What the members last answered. **Synchronous, and deliberately so:** this
   * is what the window's view list is built from, and its type is the guarantee
   * that a machine on the other side of a network can never delay it. Reading it
   * schedules the next `refresh`.
   */
  list(): readonly ViewContributionDTO[];
  /** Ask every reachable member again. One in flight at a time. */
  refresh(): Promise<void>;
  children(type: string, parent?: string): Promise<readonly TreeItem[]>;
  activate(type: string, command: { readonly id: string; readonly args?: unknown }): Promise<void>;
  /**
   * Ask a member's row what it stands for, WITHOUT running its gesture.
   *
   * The row's `presents` verb, carried and never interpreted — exactly as
   * `activate` carries `command`. See `TreeItem.presents` for why a click on
   * another member's row must not run the row's own command.
   */
  present(
    type: string,
    presents: { readonly id: string; readonly args?: unknown },
  ): Promise<PresentEffect | undefined>;
  invoke(type: string, command: string, args?: unknown): Promise<unknown>;
}

export function remoteViews(options: RemoteViewsOptions): RemoteViews {
  const { members, invokeAt, changed, log } = options;

  /** Everyone in the net this Mac could actually call. */
  const reachable = (): readonly RosterEntry[] => members().filter((member) => member.addrs.length > 0);

  /** The members' last answer. Empty is a real state: nobody has answered yet. */
  let held: readonly ViewContributionDTO[] = [];
  /**
   * The refresh in flight, so a window that re-reads three times over asks the
   * net once. It is also what makes `list`'s implicit refresh safe to leave
   * un-throttled: a member that takes twenty seconds to time out cannot be
   * dialled again while it is still being dialled.
   */
  let asking: Promise<void> | undefined;

  const ask = async (): Promise<readonly ViewContributionDTO[]> => {
    const answers = await Promise.all(
      reachable().map(async (member) => {
        try {
          const answer = (await invokeAt(member.memberId, 'views.list', {})) as {
            views?: readonly ViewContributionDTO[];
          };
          return (answer.views ?? []).map((view) => ({
            ...view,
            type: qualify(member.memberId, view.type),
            // What the shell draws its indicator from. The id alone would put
            // an opaque uuid on screen; the name is what a person recognises.
            remote: { memberId: member.memberId, name: member.name },
          }));
        } catch (error) {
          // Said out loud, and then dropped: a member that is asleep is the
          // ordinary case, not a fault, and it must not empty the sidebar.
          log.info(`${member.name} did not answer for its views: ${String(error)}`);
          return [];
        }
      }),
    );
    return answers.flat();
  };

  const refresh = async (): Promise<void> => {
    if (asking !== undefined) return await asking;
    asking = (async () => {
      const answered = await ask();
      // Compared before it is announced: the shell re-reads on a nudge, so a
      // nudge for an unchanged list would provoke the read that raises the next
      // one, and the two would keep each other going for ever.
      const news = JSON.stringify(answered) !== JSON.stringify(held);
      held = answered;
      if (news) changed?.();
    })();
    try {
      await asking;
    } finally {
      asking = undefined;
    }
  };

  return {
    owns: (type) => memberOf(type) !== undefined,

    list() {
      // The read is what schedules the next read. A caller asks this list when
      // it suspects it is stale, which is exactly when the members are worth
      // asking again — and the answer lands one nudge later rather than in this
      // call, which is the whole point.
      void refresh();
      return held;
    },

    refresh,

    async children(type, parent) {
      const memberId = memberOf(type);
      if (memberId === undefined) return [];
      try {
        const rows = await invokeAt(memberId, 'views.children', {
          type: unqualify(type),
          ...(parent === undefined ? {} : { parent }),
        });
        return Array.isArray(rows) ? (rows as readonly TreeItem[]) : [];
      } catch (error) {
        // `list`'s rule, one call along: a member that went to sleep between the
        // two is a section with no rows. Thrown, it would reject into the
        // renderer's read loop — which walks the trees in order and awaits each
        // — and cost every view after this one its rows.
        log.info(`${memberId} did not answer for ${type}'s rows: ${String(error)}`);
        return [];
      }
    },

    /**
     * A row's verb, run over there.
     *
     * The command id is the ROW'S — declared by the extension that drew it —
     * so this carries it rather than interpreting it, and the member authorizes
     * it against what it actually offered us. A shell that decided which verbs
     * were allowed would be the capability boundary in the wrong place.
     */
    async activate(type, command) {
      const memberId = memberOf(type);
      if (memberId === undefined) return;
      await invokeAt(memberId, command.id, command.args ?? {});
    },

    /**
     * What that row would have shown, as the member itself reports it.
     *
     * The answer has crossed a wire from a machine this build has never seen, so
     * it is READ rather than cast: `ok` says the call succeeded, not that the
     * value has a shape. An unrecognised effect is dropped as though absent —
     * `PresentEffect` is additive on purpose, and a client that refused an unknown
     * kind would break against a member running a newer build.
     */
    async present(type, presents) {
      const memberId = memberOf(type);
      if (memberId === undefined) return undefined;
      const answer = await invokeAt(memberId, presents.id, presents.args ?? {});
      if (typeof answer !== 'object' || answer === null) return undefined;
      const effect = (answer as { present?: unknown }).present;
      if (typeof effect !== 'object' || effect === null) return undefined;
      const { kind, sessionId, viewType } = effect as {
        kind?: unknown;
        sessionId?: unknown;
        viewType?: unknown;
      };
      if (kind === 'session' && typeof sessionId === 'string' && sessionId !== '') {
        return { kind: 'session', sessionId: toSessionId(sessionId) };
      }
      if (kind === 'view' && typeof viewType === 'string' && viewType !== '') {
        // Qualified on the way IN, because over there it is an ordinary local
        // type and here it is that member's — the same rule `list` keeps.
        return { kind: 'view', viewType: qualify(memberId, viewType) };
      }
      log.info(`${memberId} answered ${presents.id} with nothing this build can show`);
      return undefined;
    },

    async invoke(type, command, args) {
      const memberId = memberOf(type);
      if (memberId === undefined) return undefined;
      return await invokeAt(memberId, command, args ?? {});
    },
  };
}

export { memberOf, qualify, unqualify };
