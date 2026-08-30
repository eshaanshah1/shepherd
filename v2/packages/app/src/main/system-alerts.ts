import { Notification } from 'electron';
import type { Logger } from '@shepherd/sdk';
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
  on(event: 'failed' | 'show', handler: (event: unknown, error?: Error) => void): void;
  show(): void;
}

export interface SystemAlertOptions {
  readonly logger: Logger;
  readonly isSupported?: () => boolean;
  readonly create?: (alert: { title: string; body: string }) => NotificationHandle;
}

export function createSystemAlerts(options: SystemAlertOptions): AlertSink {
  const log = options.logger.child('app');
  const isSupported = options.isSupported ?? (() => Notification.isSupported());
  // Adapted rather than cast: Electron's `on` is a set of per-event overloads,
  // so the two events this cares about do not structurally match one signature.
  const create =
    options.create ??
    ((alert): NotificationHandle => {
      const notification = new Notification(alert);
      return {
        on: (event, handler) => {
          if (event === 'failed') {
            // Electron hands the reason over as a plain string, not an Error.
            notification.on('failed', (raw, error) => handler(raw, new Error(error)));
          } else {
            notification.on('show', (raw) => handler(raw));
          }
        },
        show: () => notification.show(),
      };
    });

  return {
    notify: ({ title, body, sessionId }) => {
      if (!isSupported()) {
        log.warn(`notification for ${sessionId} dropped: this platform reports notifications not supported`);
        return;
      }
      const notification = create({ title, body });
      notification.on('failed', (_event, error) => {
        log.warn(
          `notification for ${sessionId} was refused by the OS: ${error?.message ?? 'no reason given'} ` +
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
