import { KERNEL, type CategoryLogger, type PresentEffect } from '@shepherd/sdk';
import { qualify } from '../shared/index.ts';

/**
 * A member's row, presented HERE.
 *
 * The gesture a remote row used to run was the row's own `command`, which for a
 * task is `tasks.reveal` — a verb that opens a layout root and switches the
 * window to it. Run over the wire that moved the OTHER Mac's window and left this
 * one showing nothing, which is precisely backwards: clicking somebody else's row
 * should make this Mac a second viewer of their session, not a remote control for
 * their UI.
 *
 * So a row also declares `presents` (`TreeItem.presents`): a verb that ANSWERS
 * what it stands for and performs nothing. This module takes that answer and does
 * the showing locally.
 *
 * **A remote session gets a root of its own.** Not a split of whatever happens to
 * be on screen: it is a thing with a lifetime — it can be closed, it survives a
 * relaunch, and it belongs to a machine rather than to a task — so the layout
 * noun that fits it is the one `tasks` already uses for the same reasons. Closing
 * that root ends the viewing and nothing else; `SessionRouter.kill` is where that
 * is guaranteed.
 */

export interface RemotePresentOptions {
  /**
   * Reach the member and read its inventory BEFORE the pane exists.
   *
   * The ordering is load-bearing: the pane is born already bound to the session
   * (`PaneSeed.session`), and the renderer attaches to it the moment it mounts.
   * Reaching first means the router's mirror can answer that attach immediately
   * rather than deferring it, which is what makes an ordinary click feel like
   * opening a local pane.
   */
  readonly reach: (memberId: string) => Promise<{ ok: boolean; error?: unknown }>;
  /** The one verb table. `layout.openRoot` and `layout.switchRoot` are invoked through it. */
  readonly invoke: (
    command: string,
    args: unknown,
  ) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>;
  readonly log: CategoryLogger;
}

export interface Presented {
  readonly root: string;
  readonly pane: string | null;
}

/**
 * The root a member's session is shown in.
 *
 * Derived from the member and the session rather than minted, so clicking the
 * same row twice lands on the root that is already open instead of stacking a
 * second view of one pty — `layout.openRoot` is idempotent, and this is what
 * makes it idempotent for the right thing.
 */
export function remoteRootId(memberId: string, sessionId: string): string {
  return `remote:${memberId}:${sessionId}`;
}

export function createRemotePresenter(options: RemotePresentOptions) {
  const { reach, invoke, log } = options;

  return {
    /**
     * Show a member's session on this Mac.
     *
     * Errors are values: a member that is asleep, or one whose session ended
     * between drawing the row and clicking it, is an ordinary outcome that the
     * caller reports — not an exception thrown out of a click handler.
     */
    async present(
      memberId: string,
      memberName: string,
      effect: PresentEffect,
    ): Promise<{ ok: true; value: Presented } | { ok: false; error: string }> {
      if (effect.kind !== 'session') {
        // A view is presented by the sidebar, which already draws every member's
        // views as one list — there is nothing for this module to open. Tolerated
        // rather than refused: `PresentEffect` is additive and a client that does
        // not recognise a kind shows what it already had.
        return { ok: false, error: `nothing to open for a ${effect.kind} effect` };
      }

      const reached = await reach(memberId);
      if (!reached.ok) {
        return { ok: false, error: `could not reach ${memberName}: ${String(reached.error)}` };
      }

      const root = remoteRootId(memberId, effect.sessionId);
      /**
       * The pane is born BOUND — `session` on the way in, not a `bindSession`
       * after the fact.
       *
       * The renderer decides to start a pty by looking for a binding in the
       * snapshot it was handed, so a pane announced unbound is a pane it opens a
       * local shell in. Binding a moment later loses that race and leaves a stray
       * shell beside the terminal you asked for. See `PaneSeed.session`.
       */
      const opened = await invoke('layout.openRoot', {
        root,
        session: qualify(memberId, effect.sessionId),
        // Whose machine this is, where the pane's name goes. A user title, so the
        // program's own OSC title cannot overwrite the one fact this pane is
        // about.
        title: memberName,
      });
      if (!opened.ok) {
        return { ok: false, error: `${opened.error.code}: ${opened.error.message}` };
      }

      const switched = await invoke('layout.switchRoot', { root });
      if (!switched.ok) {
        // The root exists and is bound; only the window did not move. Reported and
        // not fatal — the sidebar's own highlight reads from the active root, so
        // this is visible rather than silent.
        log.warn(`opened ${root} but could not switch to it: ${switched.error.message}`);
      }

      const answer = opened.value as { root?: string; pane?: string | null };
      log.info(`showing ${memberName}'s session ${effect.sessionId} in ${root}`);
      return { ok: true, value: { root, pane: answer.pane ?? null } };
    },
  };
}

/** The caller every invocation here is attributed to. */
export const PRESENT_CALLER = KERNEL;
