import type { CommandRegistry } from '@shepherd/core';
import { s, type Disposable, type TreeItem } from '@shepherd/sdk';
import type { ViewRegistry } from './view-registry.ts';

/**
 * Contributed views, as COMMANDS.
 *
 * They were already reachable — as IPC channels, from the renderer. This makes
 * them reachable the way §4.3 says everything should be: through the one verb
 * table, so the CLI, MCP and a paired device all get them without a second
 * implementation each. v1 shipped three ways to run a verb (`controlRoute`,
 * `applyRemoteCommand`, `ShortcutActions`) and they drifted; the fix is not to
 * be careful, it is to have one table.
 *
 * The renderer keeps its IPC channels. They are a **projection** of these, not a
 * rival: the page needs a synchronous-feeling bridge and its own attribution
 * (`{kind:'user'}` is minted in-process only), while a device is a `device`
 * caller the dispatcher authorizes. Same registry underneath, which is the part
 * that matters.
 */

export const VIEW_COMMANDS = {
  list: 'views.list',
  children: 'views.children',
} as const;

export interface ViewCommandsOptions {
  readonly views: ViewRegistry;
  readonly registry: CommandRegistry;
}

/** What a client needs to draw a contributed view without knowing its domain. */
export interface ViewSummary {
  readonly type: string;
  readonly title: string;
  /**
   * `tree` rows can be drawn by any renderer; a `component` is React the
   * desktop mounts in-proc (ADR 0033), and a phone cannot run it.
   *
   * Reported rather than filtered, deliberately. A client decides what it can
   * draw — the alternative is a `remoteCapable` flag on the host, which would be
   * an extension point with one consumer, invented before anything misbehaved.
   */
  readonly kind: 'tree' | 'component';
}

export function registerViewCommands(options: ViewCommandsOptions): Disposable {
  const { views, registry } = options;

  const subscriptions: Disposable[] = [
    registry.register(VIEW_COMMANDS.list, {
      title: 'Views: List',
      permission: 'views',
      schema: s.nothing(),
      handler: (): { views: ViewSummary[] } => ({
        views: views.list().map((contribution) => ({
          type: contribution.type,
          title: contribution.title ?? contribution.type,
          kind: contribution.kind,
        })),
      }),
    }),

    registry.register(VIEW_COMMANDS.children, {
      title: 'Views: Children',
      permission: 'views',
      schema: s.object({ type: s.string(), parent: s.optional(s.string()) }),
      /**
       * A tree's rows.
       *
       * Answers `[]` for an unknown view or a `component` one rather than
       * failing: a client asking for rows of something that has none is out of
       * date, not broken, and an error would make every version skew look like a
       * fault. `ViewRegistry.children` already makes that decision; this does not
       * make a second one.
       */
      handler: async (args: { type: string; parent?: string }): Promise<readonly TreeItem[]> =>
        views.children(args.type, args.parent),
    }),
  ];

  return { dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) };
}
