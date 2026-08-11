import type { CategoryLogger, TreeItem } from '@shepherd/sdk';
import type { RosterEntry } from '@shepherd/remote';
import type { ViewContributionDTO } from '../shared/index.ts';

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

/**
 * The separator, chosen to be something no extension will ever put in a view
 * type: a double colon that is one character (U+2237), not two ASCII colons a
 * type could plausibly contain.
 */
const SEPARATOR = '∷';

export function qualify(memberId: string, type: string): string {
  return `${memberId}${SEPARATOR}${type}`;
}

/** Which member owns this type, or undefined for one of this Mac's own. */
export function memberOf(type: string): string | undefined {
  const at = type.indexOf(SEPARATOR);
  return at < 0 ? undefined : type.slice(0, at);
}

/**
 * The type as the member that owns it knows it.
 *
 * Split on the FIRST separator only: everything after it is the extension's own
 * string and may contain anything, including another separator.
 */
export function unqualify(type: string): string {
  const at = type.indexOf(SEPARATOR);
  return at < 0 ? type : type.slice(at + SEPARATOR.length);
}

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

    async invoke(type, command, args) {
      const memberId = memberOf(type);
      if (memberId === undefined) return undefined;
      return await invokeAt(memberId, command, args ?? {});
    },
  };
}
