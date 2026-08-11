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
 */

export interface RemoteViewsOptions {
  /** The net's roster, read per call so a member that just joined is included. */
  readonly members: () => readonly RosterEntry[];
  readonly invokeAt: (memberId: string, command: string, args: unknown) => Promise<unknown>;
  readonly log: CategoryLogger;
}

export interface RemoteViews {
  /** Whether this view type belongs to a member rather than to this Mac. */
  owns(type: string): boolean;
  list(): Promise<readonly ViewContributionDTO[]>;
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
  const { members, invokeAt, log } = options;

  /** Everyone in the net this Mac could actually call. */
  const reachable = (): readonly RosterEntry[] => members().filter((member) => member.addrs.length > 0);

  return {
    owns: (type) => memberOf(type) !== undefined,

    async list() {
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
    },

    async children(type, parent) {
      const memberId = memberOf(type);
      if (memberId === undefined) return [];
      const rows = await invokeAt(memberId, 'views.children', {
        type: unqualify(type),
        ...(parent === undefined ? {} : { parent }),
      });
      return Array.isArray(rows) ? (rows as readonly TreeItem[]) : [];
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
