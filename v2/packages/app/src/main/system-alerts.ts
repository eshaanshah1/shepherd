import { Notification } from 'electron';
import type { AlertAction, AlertGoto, AlertSpec, Logger } from '@shepherd/sdk';
import type { AlertSink } from './agent-relay.ts';

/**
 * The production `AlertSink` — a real banner, and a LOUD failure.
 *
 * Split out of `agent-ipc.ts` for one reason: delivery can fail for reasons that
 * are nothing to do with our decision to alert, and until 2026-08-07 it failed
 * in total silence. A real Claude session drove the router to
 * `banner=true chime=true badge=true`, and macOS then dropped the banner with
 * `UNErrorDomain error 1` — not authorized, because `pnpm dev` runs the unsigned
 * `Electron.app` from node_modules, which has no bundle identity to authorize.
 * Diagnosing that took a standalone probe, because neither branch here said a
 * word.
 *
 * So both failure paths are now injected and tested: whether the platform offers
 * notifications at all, and whether the one we handed over was actually shown.
 * The `failed` event is the only channel Electron has for the second — `show()`
 * itself returns void and throws nothing.
 *
 * A refusal is `warn`, not `error`: an unsigned dev build hitting this every
 * time is expected, and the state indicator plus the dock badge are unaffected.
 */

/** The slice of Electron's `Notification` this needs, so a test can stand in. */
export interface NotificationHandle {
  on(
    event: 'failed' | 'show' | 'click' | 'action',
    handler: (event: unknown, arg?: Error | number) => void,
  ): void;
  show(): void;
}

/** What Electron is handed. `actions` is its own shape, not ours. */
export interface NotificationOptions {
  readonly title: string;
  readonly subtitle?: string;
  readonly body: string;
  readonly actions?: readonly { readonly type: 'button'; readonly text: string }[];
}

export interface SystemAlertOptions {
  readonly logger: Logger;
  readonly isSupported?: () => boolean;
  readonly create?: (alert: NotificationOptions) => NotificationHandle;
  /**
   * Where a press goes — the click on the body, and each button.
   *
   * Optional, and its absence is load-bearing rather than a default: with
   * nothing to dispatch to, the buttons are not drawn at all. A button that
   * cannot fire is worse than no button, because the user reads it as a feature
   * and learns the app ignores them.
   */
  readonly dispatch?: (action: AlertAction | { readonly goto: AlertGoto }) => void;
}

export function createSystemAlerts(options: SystemAlertOptions): AlertSink {
  const log = options.logger.child('app');
  const isSupported = options.isSupported ?? (() => Notification.isSupported());
  // Adapted rather than cast: Electron's `on` is a set of per-event overloads,
  // so the two events this cares about do not structurally match one signature.
  const create =
    options.create ??
    ((alert): NotificationHandle => {
      const notification = new Notification({ ...alert, actions: [...(alert.actions ?? [])] });
      return {
        on: (event, handler) => {
          if (event === 'failed') {
            // Electron hands the reason over as a plain string, not an Error.
            notification.on('failed', (raw, error) => handler(raw, new Error(error)));
          } else if (event === 'action') {
            notification.on('action', (raw, index) => handler(raw, index));
          } else if (event === 'click') {
            notification.on('click', (raw) => handler(raw));
          } else {
            notification.on('show', (raw) => handler(raw));
          }
        },
        show: () => notification.show(),
      };
    });

  const dispatch = options.dispatch;

  return {
    notify: (alert) => {
      const { sessionId, title, subtitle, body, click } = alert;
      if (!isSupported()) {
        log.warn(`notification for ${sessionId} dropped: this platform reports notifications not supported`);
        return;
      }
      /*
       * The buttons exist only if something can answer them — see `dispatch`.
       * Capped at two here as well as where they are composed, because the cap
       * is a fact about macOS and this is the file that knows about macOS.
       */
      const actions = dispatch === undefined ? [] : (alert.actions ?? []).slice(0, 2);
      const notification = create({
        title,
        ...(subtitle === undefined ? {} : { subtitle }),
        body,
        ...(actions.length === 0 ? {} : { actions: actions.map((action) => ({ type: 'button' as const, text: action.label })) }),
      });
      if (dispatch !== undefined) {
        if (click !== undefined) notification.on('click', () => dispatch({ goto: click }));
        notification.on('action', (_event, index) => {
          const action = typeof index === 'number' ? actions[index] : undefined;
          if (action === undefined) {
            // Reported rather than ignored: an index we have no button for means
            // our idea of the notification and the OS's have come apart.
            log.warn(`notification for ${sessionId} fired action ${String(index)}, which it does not have`);
            return;
          }
          dispatch(action);
        });
      }
      notification.on('failed', (_event, error) => {
        // `on` is one signature over four events now, so the reason arrives as
        // `Error | number | undefined` and is narrowed rather than asserted.
        const why = error instanceof Error ? error.message : 'no reason given';
        log.warn(
          `notification for ${sessionId} was refused by the OS: ${why} ` +
            `(an unsigned dev build has no bundle identity macOS will authorize — expected under \`pnpm dev\`)`,
        );
      });
      notification.on('show', () => {
        log.debug(`notification shown for ${sessionId}`);
      });
      notification.show();
    },
  };
}
