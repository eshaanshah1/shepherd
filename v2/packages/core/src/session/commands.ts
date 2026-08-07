import { disposeAll, s, type Disposable } from '@shepherd/sdk';
import type { CommandRegistry } from '../commands/registry.ts';
import type { SessionHost } from './host.ts';

/**
 * Sessions as commands, so the reconciliation sweep — which lives in an
 * extension, in another process — asks the same table a keystroke does rather
 * than getting a private channel of its own.
 *
 * `sessions` is the permission because this answer is more than an inventory:
 * the cwd of every terminal and what is running in each of them is exactly what
 * an extension has to be trusted with before it can drive them.
 */

export interface SessionCommandsOptions {
  readonly host: SessionHost;
  readonly registry: CommandRegistry;
}

export const SESSION_COMMANDS = {
  list: 'sessions.list',
} as const;

export function registerSessionCommands(options: SessionCommandsOptions): Disposable {
  const { host, registry } = options;

  const subscriptions: Disposable[] = [
    registry.register(SESSION_COMMANDS.list, {
      title: 'List Sessions',
      permission: 'sessions',
      schema: s.nothing(),
      handler: () =>
        host.list().map((info) => {
          // Both fields come from the host, including the derived one: the
          // predicate is a judgement about what a session's command means, and
          // re-deriving it here from `foregroundProcess` would be a second copy
          // of it that drifts the first time either side is corrected.
          const foregroundProcess = host.foregroundProcess(info.id);
          return {
            id: info.id,
            cwd: info.cwd,
            command: info.command,
            args: info.args,
            cols: info.cols,
            rows: info.rows,
            ...(info.paneId === undefined ? {} : { paneId: info.paneId }),
            ...(foregroundProcess === undefined ? {} : { foregroundProcess }),
            hasForegroundProcess: host.hasForegroundProcess(info.id),
          };
        }),
    }),
  ];

  return { dispose: () => disposeAll(subscriptions) };
}
