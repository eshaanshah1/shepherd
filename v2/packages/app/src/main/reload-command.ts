import { s, type Disposable } from '@shepherd/sdk';
import type { CommandRegistry } from '@shepherd/core';

/**
 * `window.reload` — new UI without killing anybody's agents.
 *
 * The problem it solves is the one that makes updating annoying: a session is a
 * `node-pty` child of the MAIN process, so restarting the app kills every
 * running `claude`, and the only safe moment to do that is when nothing is
 * mid-turn. Waiting for that is the wait.
 *
 * But `SessionHost` is constructed at module scope in `index.ts` and outlives
 * every window — deliberately, and the reason is recorded there: it is "the
 * registry a React unmount must not be able to reach". So the renderer, which
 * is where almost every change lands, can be thrown away and rebuilt while the
 * ptys keep running. A reload costs a repaint from the replay ring; a restart
 * costs the work.
 *
 * That makes the update story two-tier, and the tiers are worth stating because
 * the second one is a real limit rather than an oversight:
 *
 *   - **The renderer changed** — `pnpm dev` has already rebuilt the bundle, so
 *     this command is the whole update. Sessions survive.
 *   - **Main, preload, core or an extension changed** — this command does
 *     nothing useful. Main's code is loaded; an extension is statically bundled
 *     into the extension-host entry (`ext-host/builtins.ts`), so even a `tasks`
 *     edit is not a renderer edit. Those need a restart until the daemon lands
 *     (§7b: "sessions in the main process for v2.0; daemon later behind the
 *     SessionHost interface"), which is exactly the seam that would make a
 *     restart cost nothing.
 *
 * **Permission: `layout`.** The same grant `window.capture` takes, for the same
 * reason: it already means "this caller may open and arrange windows on your
 * screen", and throwing one's contents away and redrawing them belongs to that
 * rather than to a new permission with one member.
 */

export interface ReloadCommandOptions {
  readonly registry: CommandRegistry;
  /**
   * Reload the window's web contents, or answer false when there is none.
   *
   * Injected rather than taking a `BrowserWindow` — the same two reasons
   * `capture` is: the window does not exist when commands are registered, and a
   * closure makes the decision here assertable without Electron.
   */
  readonly reload: () => boolean;
}

export function registerReloadCommand(options: ReloadCommandOptions): Disposable {
  const { registry, reload } = options;

  return registry.register('window.reload', {
    title: 'Reload the Window',
    permission: 'layout',
    schema: s.nothing(),
    handler: () => {
      // A throw rather than `{reloaded:false}`: on macOS the app outlives its
      // last window, so "there is no window" is reachable, and a caller that
      // asked for new UI and got a cheerful false would go looking for its
      // change on a screen that was never redrawn.
      if (!reload()) throw new Error('there is no window to reload');
      return { reloaded: true };
    },
  });
}
