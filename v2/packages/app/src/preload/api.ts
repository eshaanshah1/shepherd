import {
  CONTROL_COMMANDS,
  CONTROL_TOPICS,
  EMIT,
  INVOKE,
  SETTINGS_VISIBILITY_COMMAND,
  type AgentIndicatorDTO,
  type ControlFrameMessage,
  type IpcResult,
  type LayoutSnapshots,
  type SessionDataMessage,
  type SessionExitMessage,
  type SessionResizeMessage,
  type ShepherdBridge,
} from '../shared/index.ts';

/**
 * The bridge object, built against an interface instead of against electron.
 *
 * `index.ts` supplies the real `ipcRenderer` in nine lines; everything with a
 * decision in it is here, so a test can assert `Object.keys()` against
 * `BRIDGE_SURFACE` without an Electron process. (The half a unit test genuinely
 * cannot answer — whether `window.require` exists in the page — is asserted in
 * the terminal smoke, inside a real renderer.)
 *
 * **Since Stage 2 of the core/UI isolation, the control plane is one client.**
 * `commands`, `agents`, `views` and `settings` are not four IPC surfaces any
 * more; they are four shapes over `control:invoke` and `control:subscribe`, the
 * same pair `control.sock` offers. The namespaces survive because they are what
 * keeps the page honest: a page calls `views.onChanged`, never
 * `subscribe('claude.hook')`, so the topic names live here as constants and the
 * allow-list `agent-relay.ts` used to hold in main is now the SHAPE of this
 * object. Widening it is an edit to `BRIDGE_SURFACE`, which a test reads.
 */
export interface IpcLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  off(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}

/** Frames arrive on one channel; this is what routes them back to their asker. */
interface Follower {
  onFrame(frame: ControlFrameMessage['frame']): void;
}

export function createBridge(ipc: IpcLike): ShepherdBridge {
  const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
    ipc.invoke(channel, ...args) as Promise<T>;

  const subscribe = <T>(channel: string, listener: (message: T) => void): (() => void) => {
    // The event object is dropped deliberately: handing the renderer an
    // `IpcRendererEvent` would leak `sender`, and with it a way back out of the
    // bridge this file exists to be.
    const wrapped = (_event: unknown, ...args: unknown[]): void => listener(args[0] as T);
    ipc.on(channel, wrapped);
    return () => {
      ipc.off(channel, wrapped);
    };
  };

  const command = <T>(id: string, args?: unknown): Promise<IpcResult<T>> =>
    // `args` defaults to `{}` rather than travelling as `undefined`: every
    // layout command's schema is an object, and `s.object` on `undefined` is an
    // `invalid-args` failure for a gesture that simply took no arguments.
    invoke(INVOKE.controlInvoke, id, args ?? {});

  /**
   * A command whose answer is an envelope, unwrapped to the field this bridge
   * promised.
   *
   * `views.list` answers `{ views: [...] }` because that envelope is what a
   * paired member reads off another Mac, and a bare array would have nowhere to
   * put a later field. The page's `list()` promises the array, and a cast would
   * have typechecked while handing it the wrapper — an answer from a command is
   * `unknown`, and this is the one place that unknown is turned into a shape.
   */
  const commandField = async <T>(id: string, field: string, args?: unknown): Promise<IpcResult<T>> => {
    const answer = await command<Record<string, unknown>>(id, args);
    if (!answer.ok) return answer;
    return { ok: true, value: answer.value[field] as T };
  };

  // ------------------------------------------------------------ subscriptions

  /**
   * Every open subscription this page holds, so one channel can carry them all.
   *
   * Ids are minted here rather than in main, because the unsubscribe has to name
   * one and a round trip to learn its own id would leave a window in which
   * frames arrive addressed to nobody.
   */
  const followers = new Map<string, Follower>();
  let nextId = 0;

  subscribe<ControlFrameMessage>(EMIT.controlFrame, (message) => {
    followers.get(message.subscription)?.onFrame(message.frame);
  });

  /**
   * Follow a topic, and be handed its current value first when it has one.
   *
   * `onValue` receives the snapshot and every subsequent event alike — which is
   * the whole point: a consumer of a stateful topic writes ONE code path instead
   * of a read, a subscribe, and a merge rule for the race between them.
   */
  const follow = <T>(topic: string, onValue: (value: T) => void): (() => void) => {
    const id = `s${(nextId += 1)}`;
    followers.set(id, {
      onFrame: (frame) => {
        if (frame.kind === 'snapshot') onValue(frame.value as T);
        else if (frame.kind === 'event') onValue(frame.payload as T);
      },
    });
    void invoke(INVOKE.controlSubscribe, id, topic);
    return () => {
      followers.delete(id);
      void invoke(INVOKE.controlUnsubscribe, id);
    };
  };

  /**
   * Follow a NUDGE topic: no data ever arrives, only "there is something to
   * read", and the reader says when it has read (ADR 0031).
   *
   * `onNudge` receives the subjects that changed, or `undefined` for "re-read
   * what you hold" — either because the topic names no subjects or because too
   * many changed to be worth listing. The pull happens after the handler
   * returns, so a handler that reads synchronously cannot nudge itself.
   */
  const followNudges = (topic: string, onNudge: (keys: readonly string[] | undefined) => void): (() => void) => {
    const id = `s${(nextId += 1)}`;
    followers.set(id, {
      onFrame: (frame) => {
        if (frame.kind !== 'nudge') return;
        onNudge(frame.keys);
        void invoke(INVOKE.controlPull, id);
      },
    });
    void invoke(INVOKE.controlSubscribe, id, topic);
    return () => {
      followers.delete(id);
      void invoke(INVOKE.controlUnsubscribe, id);
    };
  };

  return {
    session: {
      create: (request) => invoke(INVOKE.sessionCreate, request),
      attach: (id) => invoke(INVOKE.sessionAttach, id),
      detach: (id) => invoke(INVOKE.sessionDetach, id),
      write: (id, data) => invoke(INVOKE.sessionWrite, id, data),
      paste: (id, text) => invoke(INVOKE.sessionPaste, id, text),
      resize: (id, cols, rows) => invoke(INVOKE.sessionResize, id, cols, rows),
      setViewport: (id, viewerId, viewport) =>
        invoke(INVOKE.sessionViewport, id, viewerId, viewport),
      onData: (listener) => subscribe<SessionDataMessage>(EMIT.sessionData, listener),
      onExit: (listener) => subscribe<SessionExitMessage>(EMIT.sessionExit, listener),
      onResize: (listener) => subscribe<SessionResizeMessage>(EMIT.sessionReshaped, listener),
    },
    commands: {
      invoke: (id, args) => command(id, args),
      list: () => invoke(INVOKE.controlList),
    },
    layout: {
      get: () => invoke(INVOKE.layoutGet),
      onChanged: (listener) => subscribe<LayoutSnapshots>(EMIT.layoutChanged, listener),
      setViewport: (rect) => invoke(INVOKE.layoutViewport, rect),
      snapshot: (paneId) => invoke(INVOKE.layoutSnapshot, paneId),
    },
    /**
     * Agent state, as ONE subscription that starts with the current set.
     *
     * There is no `get()` any more and that is the Stage 2 win rather than a
     * tidy-up: the page used to follow, then pull, then merge the snapshot
     * *under* whatever had already arrived — because a transition landing
     * between the two calls would otherwise be overwritten by a snapshot taken
     * before it. Snapshot-and-register are one step now, so the race has no
     * window to happen in and the merge rule has nothing to be right about.
     */
    agents: {
      onChanged: (listener) => follow<readonly AgentIndicatorDTO[]>(CONTROL_TOPICS.agents, listener),
    },
    /**
     * Contributed views. Note what the page can ask for: WHICH views exist, a
     * named view's rows, and "the user clicked this row". It cannot name a bus
     * topic or a caller — the same refusal `bridge.ts` makes for `invoke`, and
     * the reason a compromised page cannot promote itself here either. Who a
     * click is attributed to is decided in main (D14).
     */
    views: {
      list: () => commandField(CONTROL_COMMANDS.viewsList, 'views'),
      children: (type: string, parent?: string) =>
        command(CONTROL_COMMANDS.viewsChildren, parent === undefined ? { type } : { type, parent }),
      activate: (type: string, verb: { id: string; args?: unknown }) =>
        command(CONTROL_COMMANDS.viewsActivate, { type, command: verb.id, args: verb.args }),
      invoke: (type: string, verb: string, args?: unknown) =>
        command(CONTROL_COMMANDS.viewsInvoke, { type, command: verb, args }),
      present: (type: string, presents: { id: string; args?: unknown }) =>
        command(CONTROL_COMMANDS.viewsPresent, { type, command: presents.id, args: presents.args }),
      /**
       * ADR 0031's nudge, now literally one: no rows cross here, only the types
       * that changed. An empty type has always meant "the SET moved", and it
       * survives as `keys === undefined` — the frame's way of saying "re-read
       * what you hold".
       */
      onChanged: (listener: (type: string) => void) =>
        followNudges(CONTROL_TOPICS.views, (keys) => {
          if (keys === undefined) listener('');
          else for (const type of keys) listener(type);
        }),
    },
    /**
     * Settings. What the page may ask for: which pages exist, a write, a reset,
     * to be told when a value or the screen's visibility changed, and to ask that
     * the screen be raised or dropped.
     *
     * It cannot name a bus topic, cannot name a caller, and cannot DECIDE whether
     * the screen is up — main owns that, because the same answer feeds
     * `presence.overlay` and ADR 0020 allows exactly one writer of it.
     */
    settings: {
      list: () => command(CONTROL_COMMANDS.settingsList),
      set: (key, value) => command(CONTROL_COMMANDS.settingsSet, { key, value }),
      reset: (key) => command(CONTROL_COMMANDS.settingsReset, { key }),
      setOpen: (open) => command(SETTINGS_VISIBILITY_COMMAND, { open }),
      invoke: (page, verb, args) =>
        command(CONTROL_COMMANDS.settingsInvoke, { page, command: verb, args }),
      // The payload's type comes from `SettingsApi`, which this object is checked
      // against — never from an `@shepherd/sdk` import. The preload bundle is
      // sandboxed, and a value imported here fails to load the whole script.
      onChanged: (listener) => follow(CONTROL_TOPICS.settingsChanged, listener),
      /**
       * Stateful, so a page that mounted late is told at once rather than at the
       * next change. Before this it could sit for the life of the window
       * believing the screen was down while it was up.
       */
      onVisibility: (listener) =>
        follow<{ open: boolean }>(CONTROL_TOPICS.settingsVisibility, (value) =>
          listener(value.open),
        ),
    },
    window: {
      close: () => invoke(INVOKE.windowClose),
    },
  };
}
