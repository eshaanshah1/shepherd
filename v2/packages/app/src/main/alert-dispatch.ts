import { USER, type AlertAction, type AlertGoto } from '@shepherd/sdk';
import type { CommandRegistry } from '@shepherd/core';
import type { NavigateMessage } from '../shared/index.ts';

/**
 * A press on a banner becomes either a move or a verb — `menuDispatcher`'s shape,
 * for the surface that reaches you when the app does not have the screen.
 *
 * Attributed to `USER`, because a button on a notification is a user gesture in
 * the way the `alerts.describe` read above it is not.
 *
 * **A `goto` raises the window and a verb does not**, and that asymmetry is the
 * design rather than an oversight: `Later today` on a banner is a way of saying
 * "not now", and a window that jumped to the task you just deferred would be the
 * exact opposite of what was pressed.
 *
 * Electron-free so a test can drive it. The window and the push are injected for
 * the reason every other decision in `main` is: a `BrowserWindow` cannot be
 * stood up in vitest, and the decision is the part worth pinning.
 */
export interface AlertDispatchOptions {
  readonly registry: CommandRegistry;
  /** Show and focus the window a teleport is about to happen in. */
  readonly raise: () => void;
  /** Tell the page where to go. */
  readonly navigate: (message: NavigateMessage) => void;
  /** A verb that reported failure. Never swallowed. */
  readonly onFailure: (command: string, message: string) => void;
}

export function alertDispatcher(
  options: AlertDispatchOptions,
): (action: AlertAction | { readonly goto: AlertGoto }) => void {
  return (action) => {
    if ('goto' in action) {
      options.raise();
      const { task, face } = action.goto;
      options.navigate({ task, ...(face === undefined ? {} : { face }) });
      return;
    }
    // `args` defaults to `{}` rather than travelling as `undefined`, for
    // `preload/api.ts`'s reason: a command whose schema is an object refuses
    // `undefined` as `invalid-args` for a gesture that simply took none.
    void options.registry.invoke(action.command, action.args ?? {}, USER).then((result) => {
      if (!result.ok) options.onFailure(action.command, result.error.message);
    });
  };
}
