import { disposeAll, s, type Disposable, type PaneID } from '@shepherd/sdk';
import type { CommandRegistry } from '../commands/registry.ts';
import type { ForegroundReading, SessionInfo } from './host.ts';

/**
 * Sessions as commands, so the reconciliation sweep — which lives in an
 * extension, in another process — asks the same table a keystroke does rather
 * than getting a private channel of its own.
 *
 * `sessions` is the permission because this answer is more than an inventory:
 * the cwd of every terminal and what is running in each of them is exactly what
 * an extension has to be trusted with before it can drive them.
 */

/**
 * What `sessions.list` needs, and nothing more.
 *
 * Narrowed in R1 from `SessionHost` to this: the ptys may live in another
 * process now, so `foreground` is a round trip there and a field read here. The
 * union of the two return types is what lets ONE registration serve both, and
 * the handler `await`s — which is free for the in-process case.
 */
export interface SessionInventory {
  list(): SessionInfo[];
  foreground(id: SessionInfo['id']): ForegroundReading | Promise<ForegroundReading>;
}

export interface SessionCommandsOptions {
  readonly host: SessionInventory;
  readonly registry: CommandRegistry;
  /**
   * Answers "is the user looking at this session" for each row.
   *
   * Here rather than on a channel of its own because of what it dissolves: an
   * agent extension keeps a pushed mirror of the one predicate (`session.viewing`
   * keeps it current), and a mirror needs a **seed** — after activation, and
   * again after an extension-host crash. Nothing in main knows when a child
   * subscribes to a topic, and teaching the extension host to re-announce one
   * particular topic would couple the kernel to an extension's vocabulary. But
   * an agent extension must read this command anyway to learn what sessions
   * exist, so the seed rides the read it was always going to make.
   *
   * Optional: a host with no resolver (a test, the session smoke) answers `null`,
   * which is "not known" and never `false`.
   */
  readonly viewing?: ViewingLookup;
}

/**
 * Just the question, so core's session module does not depend on the attention
 * module to answer it. `null` = this session is on no pane, so the question does
 * not apply.
 */
export type ViewingLookup = (pane: PaneID) => boolean;

export const SESSION_COMMANDS = {
  list: 'sessions.list',
} as const;

export function registerSessionCommands(options: SessionCommandsOptions): Disposable {
  const { host, registry, viewing } = options;

  const subscriptions: Disposable[] = [
    registry.register(SESSION_COMMANDS.list, {
      title: 'List Sessions',
      permission: 'sessions',
      schema: s.nothing(),
      // `async` + `Promise.all`, because `foreground` may be a round trip when
      // the ptys live in another process (R1). In process it resolves in the
      // same tick, so the in-process path pays nothing for the option.
      handler: async () =>
        Promise.all(
          host.list().map(async (info) => {
          // ONE read for both fields. Asking the host twice samples the pty
          // twice, so a child exiting between the two calls yields a
          // self-contradictory answer — `{foregroundProcess: 'sleep',
          // hasForegroundProcess: false}` — which is worse than either field
          // alone for the sweep that cross-checks them. The derived boolean
          // still comes from the host rather than being recomputed here: the
          // predicate is a judgement about what a session's command means, and a
          // second copy would drift the first time either side is corrected.
            const foreground = await host.foreground(info.id);
            return {
              id: info.id,
              // The child-side `Session` declares `pid`, and this command is its
              // only transport — omitting it would make that member unfulfillable.
              pid: info.pid,
              cwd: info.cwd,
              command: info.command,
              args: info.args,
              cols: info.cols,
              rows: info.rows,
              ...(info.paneId === undefined ? {} : { paneId: info.paneId }),
              ...(foreground.name === undefined ? {} : { foregroundProcess: foreground.name }),
              // Tri-state, and it crosses the wire as one: `null` is "the tty
              // could not be read", which a reconciler must not read as "nothing
              // is running". JSON has no `undefined`, so the absent case would be
              // indistinguishable from a field this build does not send.
              hasForegroundProcess: foreground.hasForegroundProcess ?? null,
              // The seed for an agent extension's viewing mirror — see
              // `SessionCommandsOptions.viewing`. `null` is "not known" (no pane,
              // or no resolver wired) and is deliberately not `false`, which would
              // read as "they are definitely not looking".
              viewing:
                info.paneId === undefined || viewing === undefined ? null : viewing(info.paneId),
            };
          }),
        ),
    }),
  ];

  return { dispose: () => disposeAll(subscriptions) };
}
