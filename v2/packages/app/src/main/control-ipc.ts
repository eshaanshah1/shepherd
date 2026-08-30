import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { USER, toDisposable, type Disposable, type Logger } from '@shepherd/sdk';
import type { ControlSurface, Subscription } from '@shepherd/core';
import { EMIT, INVOKE, type ControlFrameMessage, type IpcResult } from '../shared/index.ts';

/**
 * The renderer as a **client of the control plane**, over the same surface
 * `control.sock` serves.
 *
 * This replaces nine bespoke `ipcMain.handle` channels — `command:invoke`,
 * `command:list`, `agents:get`, `views:*`, `settings:*` — each of which had its
 * own validation, its own error mapping and its own push. They were not wrong
 * individually; collectively they were a second control protocol, tested by
 * nobody against anything but itself, while the socket's protocol had exactly
 * one consumer that never asked it for a snapshot or pushed back on it.
 *
 * Five channels now, and none of them names a feature: invoke, list, subscribe,
 * pull, unsubscribe. Adding a command or a topic adds nothing here.
 *
 * **The page still cannot name a topic.** The preload passes constants — the
 * page calls `settings.onChanged`, not `subscribe('claude.hook')` — so the
 * allow-list `agent-relay.ts` was protecting survives as the shape of the
 * bridge rather than as a table in main. What changed is that the table is no
 * longer a deviation with a comment apologising for itself.
 *
 * **`USER` is asserted here and never sent by the page**, exactly as
 * `layout-ipc.ts` asserted it: a renderer that could name its own caller kind
 * could name `{kind:'agent'}` and inherit an agent's grants. That the app is
 * `user` at all is the one privilege it still has over a socket client, and it
 * is the thing Stage 3 removes (design section 3).
 */

export interface ControlIpcOptions {
  readonly surface: ControlSurface;
  readonly logger: Logger;
}

/** A subscription, keyed by the page that opened it and the id it chose. */
function key(contents: number, id: string): string {
  return `${contents} ${id}`;
}

export function registerControlIpc(options: ControlIpcOptions): Disposable {
  const log = options.logger.child('ingress');
  const open = new Map<string, Subscription>();
  const watched = new Set<number>();

  /**
   * A page that goes away takes its subscriptions with it.
   *
   * Without this every HMR reload leaks one listener per topic into a dead
   * `WebContents`, and the sink then throws on `send` for the life of the
   * process — the same teardown `ipc.ts` owes the session bridge.
   */
  const watch = (contents: WebContents): void => {
    if (watched.has(contents.id)) return;
    watched.add(contents.id);
    contents.once('destroyed', () => {
      watched.delete(contents.id);
      for (const [id, subscription] of [...open]) {
        if (!id.startsWith(`${contents.id} `)) continue;
        subscription.dispose();
        open.delete(id);
      }
    });
  };

  ipcMain.handle(
    INVOKE.controlInvoke,
    async (event, command: unknown, args: unknown): Promise<IpcResult<unknown>> => {
      watch(event.sender);
      if (typeof command !== 'string' || command.length === 0) {
        return fail('invalid-argument', 'command must be a non-empty string');
      }
      const result = await options.surface.invoke(command, args, USER);
      return result.ok
        ? { ok: true, value: result.value }
        : { ok: false, error: { code: result.error.code, message: result.error.message } };
    },
  );

  ipcMain.handle(INVOKE.controlList, (event): IpcResult<readonly { id: string; title: string }[]> => {
    watch(event.sender);
    /*
     * The FILTER IS HERE, not in the page, and it is not this handler's policy:
     * the SDK documents `title` as "shown in the palette ... Absent = not
     * user-facing", so an untitled command is one whose author said it is
     * plumbing. Doing it in main means the page is never handed a list it has to
     * remember not to draw, and the narrowed type carries the guarantee across
     * the port instead of a comment asking for it.
     *
     * Deliberately NOT filtered by permission: every command reached from here
     * is invoked as `USER`, which `authorize` allows unconditionally, so
     * pre-filtering would be a second authorization model that could disagree
     * with the real one.
     */
    return {
      ok: true,
      value: options.surface
        .list()
        .flatMap((command) => (command.title === undefined ? [] : [{ id: command.id, title: command.title }])),
    };
  });

  ipcMain.handle(
    INVOKE.controlSubscribe,
    (event: IpcMainInvokeEvent, id: unknown, topic: unknown): IpcResult<void> => {
      watch(event.sender);
      if (typeof id !== 'string' || id === '' || typeof topic !== 'string' || topic === '') {
        return fail('invalid-argument', 'subscribe expects a subscription id and a topic');
      }
      const mapKey = key(event.sender.id, id);
      if (open.has(mapKey)) return fail('duplicate-subscription', `subscription ${id} is already open`);

      const sender = event.sender;
      const subscription = options.surface.subscribe(topic, (frame) => {
        // A destroyed `WebContents` throws on `send`, and the frame arrives from
        // a bus listener — so an unguarded send takes down whatever emitted.
        if (sender.isDestroyed()) return;
        sender.send(EMIT.controlFrame, { subscription: id, frame } satisfies ControlFrameMessage);
      });
      open.set(mapKey, subscription);
      log.debug(`page ${sender.id} subscribed to ${topic} as ${id}`);
      return { ok: true, value: undefined };
    },
  );

  ipcMain.handle(INVOKE.controlPull, (event, id: unknown): IpcResult<void> => {
    if (typeof id !== 'string') return fail('invalid-argument', 'pull expects a subscription id');
    const subscription = open.get(key(event.sender.id, id));
    if (subscription === undefined) {
      // Reported rather than silently ignored: a reader pulling a subscription
      // that has gone waits forever for a nudge nobody can send, and it has to
      // be able to tell that from "you are caught up".
      return fail('unknown-subscription', `no subscription ${id}`);
    }
    subscription.pull();
    return { ok: true, value: undefined };
  });

  ipcMain.handle(INVOKE.controlUnsubscribe, (event, id: unknown): IpcResult<void> => {
    if (typeof id !== 'string') return fail('invalid-argument', 'unsubscribe expects a subscription id');
    const mapKey = key(event.sender.id, id);
    open.get(mapKey)?.dispose();
    open.delete(mapKey);
    return { ok: true, value: undefined };
  });

  return toDisposable(() => {
    for (const subscription of open.values()) subscription.dispose();
    open.clear();
    watched.clear();
    for (const channel of [
      INVOKE.controlInvoke,
      INVOKE.controlList,
      INVOKE.controlSubscribe,
      INVOKE.controlPull,
      INVOKE.controlUnsubscribe,
    ]) {
      ipcMain.removeHandler(channel);
    }
  });
}

function fail(code: string, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } };
}
