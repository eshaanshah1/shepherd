import type { AlertAction, AlertGoto, AlertSpec } from '@shepherd/sdk';

/**
 * What a banner says, when somebody else gets to say it.
 *
 * The relay knows a session and a state, and that is all it will ever know: the
 * task's name, what it changed and what its last word was are an extension's
 * facts. So the kernel declares ONE command id an extension may register, and
 * this file is the defensive read of what comes back plus the wording to fall
 * back to when nothing does.
 *
 * **`resolveAlert` is a reader, not a cast.** The spec crossed an IPC port from
 * an extension this code has never seen — `ok` says the call succeeded, not that
 * the value has a shape. Every field is checked, a field it cannot read is
 * dropped rather than thrown on, and a spec with no title is treated as no spec
 * at all: the old wording is a working banner, and a banner titled `undefined`
 * is not.
 */

/**
 * The one id main will ask for. A KERNEL name, deliberately — `agent-relay`'s
 * header apologises for a table that knows an extension's topic by name, and
 * this is that deviation's replacement shape rather than a second instance of it.
 */
export const ALERTS_DESCRIBE = 'alerts.describe';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

function readGoto(value: unknown): AlertGoto | undefined {
  if (!isRecord(value)) return undefined;
  const task = str(value['task']);
  if (task === undefined) return undefined;
  const face = str(value['face']);
  return face === undefined ? { task } : { task, face };
}

function readAction(value: unknown): AlertAction | undefined {
  if (!isRecord(value)) return undefined;
  const label = str(value['label']);
  if (label === undefined) return undefined;
  const command = str(value['command']);
  if (command !== undefined) {
    return 'args' in value ? { label, command, args: value['args'] } : { label, command };
  }
  const destination = readGoto(value['goto']);
  return destination === undefined ? undefined : { label, goto: destination };
}

/**
 * What today's banner said, kept verbatim.
 *
 * This is the answer for every degradation — no describer registered, one that
 * threw, one that answered `null` because the session belongs to no task — and
 * that is the point: the old banner is a working banner, so a composer that
 * fails costs the new wording and nothing else.
 */
function fallbackTitle(state: string): string {
  switch (state) {
    case 'blocked':
      return 'Waiting on you';
    case 'error':
      return 'Turn failed';
    default:
      return 'Turn finished';
  }
}

export function resolveAlert(
  described: unknown,
  fallback: { readonly state: string; readonly reason?: string },
): AlertSpec {
  const plain: AlertSpec = {
    title: fallbackTitle(fallback.state),
    body: fallback.reason ?? fallback.state,
  };
  if (!isRecord(described)) return plain;

  const title = str(described['title']);
  const body = str(described['body']);
  if (title === undefined || body === undefined) return plain;

  const subtitle = str(described['subtitle']);
  const click = readGoto(described['click']);
  const actions = Array.isArray(described['actions'])
    ? described['actions'].map(readAction).filter((action): action is AlertAction => action !== undefined).slice(0, 2)
    : [];

  return {
    title,
    ...(subtitle === undefined ? {} : { subtitle }),
    body,
    ...(actions.length === 0 ? {} : { actions }),
    ...(click === undefined ? {} : { click }),
  };
}
