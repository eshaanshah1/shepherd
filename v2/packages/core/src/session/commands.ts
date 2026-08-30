import {
  disposeAll,
  s,
  sessionId as toSessionId,
  type Caller,
  type Disposable,
  type SessionID,
} from '@shepherd/sdk';
import type { CommandRegistry } from '../commands/registry.ts';
import type { ForegroundReading, SessionInfo } from './host.ts';
import type { PrincipalKey, SessionLifetime } from './lifetime.ts';
import { reconcile, type SessionClaim } from './reconcile.ts';

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
  /**
   * The screen as bytes, without attaching — what `sessions.capture` answers.
   *
   * Callback-shaped because the host's is: the mirror captures at a point in its
   * write queue, and a synchronous getter would have to serialize a terminal
   * that may still be parsing.
   */
  snapshot(
    id: SessionInfo['id'],
    sink: (bytes: Uint8Array) => void,
    lines?: number,
  ): { ok: true } | { ok: false; error: { message: string } };
  /**
   * Text INTO the session, and the key that sends it — what `sessions.write`
   * answers.
   *
   * Both, because the pair is the verb: `paste` delivers the body (bracketed if
   * the running program asked for that) and `write` presses Enter. Splitting
   * them here rather than taking a `submit` flag keeps this interface a
   * description of the host rather than of the command.
   */
  paste(id: SessionInfo['id'], text: string): { ok: true } | { ok: false; error: { message: string } };
  write(
    id: SessionInfo['id'],
    data: string | Uint8Array,
  ): { ok: true } | { ok: false; error: { message: string } };
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
  readonly viewers?: ViewerSink;
  /**
   * What ends a session, and who is allowed to say so (ADR 0052).
   *
   * Absent = this build has no terminator, and `sessions.terminate` is not
   * registered rather than registered-and-failing: a verb that exists and
   * refuses is a verb a client has to special-case, and the self-describing
   * `/commands` list is exactly how a client is supposed to find that out.
   */
  readonly lifetime?: SessionLifetime;
  /**
   * Which live sessions somebody OTHER than this principal already holds — what
   * keeps `sessions.reconcile` from calling another client's terminal an orphan.
   *
   * Injected rather than derived here: "held" is `SessionLifetime`'s notion, and
   * this module answering it a second way is exactly the two-implementations
   * drift the one verb table exists to prevent. Absent = `sessions.reconcile`
   * is not registered.
   */
  readonly holds?: (principal: PrincipalKey) => readonly SessionID[];
}

/**
 * Who is looking at a session, aggregated over every client (ADR 0052).
 *
 * Declared here, narrowly, rather than importing `ViewerRegistry`: core's
 * session module answering a question about attention must not depend on the
 * attention module, for the same reason `ViewingLookup` was a bare function.
 */
export interface ViewerSink {
  report(principal: string, session: SessionID, viewing: boolean): boolean;
  viewersOf(session: SessionID): readonly string[];
}

/**
 * How a client is named in the viewer set. One string per client, derived from
 * the caller the dispatcher already verified — a client cannot name its own
 * principal any more than it can name its own caller kind.
 */
export function principalOf(caller: Caller): string {
  switch (caller.kind) {
    case 'user':
      return 'user';
    case 'kernel':
      return 'kernel';
    case 'device':
      return `device:${caller.deviceId}`;
    case 'extension':
      return `extension:${caller.id}`;
    case 'agent':
      return `agent:${caller.sessionId}`;
  }
}

export const SESSION_COMMANDS = {
  list: 'sessions.list',
  capture: 'sessions.capture',
  /**
   * End a session. **The one terminator** (ADR 0052).
   *
   * It used to be `layout.close`, which was right while the layout was the only
   * thing that could point at a pty. With a second client a pane close is one
   * client's decision to stop drawing something, and killing an agent a phone is
   * watching because a window closed is the wrong answer. So closing a pane
   * detaches, and ending is a verb somebody asks for — by name, through the same
   * table `shepherd`, a device and an extension reach.
   */
  terminate: 'sessions.terminate',
  /**
   * "I am / am no longer looking at this session."
   *
   * The client half of ADR 0020's one predicate, now that there can be more than
   * one client (ADR 0052). Core aggregates; a client only ever reports its own
   * answer, and it is attributed to the caller the dispatcher verified rather
   * than to a principal the client names.
   */
  viewing: 'sessions.viewing',
  /**
   * A client's **connect ritual** (ADR 0036, generalised by ADR 0052).
   *
   * It hands over what it believes it is showing and is told which of those
   * claims the authority confirms, which have ended, and which live sessions
   * nobody at all is claiming. It used to happen once, inside the layout's
   * restore, because there was one client and one moment; a second client
   * arrives whenever it arrives.
   */
  reconcile: 'sessions.reconcile',
  /**
   * Put text into a session, as if it had been pasted.
   *
   * The verb that was missing, and its absence was load-bearing in the wrong
   * direction: `SessionHost.paste` has existed since M0 and nothing outside main
   * could reach it, so an extension with something to say to a running agent had
   * to open a SECOND agent to say it. `github`'s "Hand to agent" is the caller
   * that made that indefensible.
   *
   * **Paste rather than type**, and the distinction is the whole verb: a typed
   * newline is an Enter press (v1's recorded lesson), so multi-line text typed
   * into a TUI submits its first line and scatters the rest. `host.paste`
   * brackets iff the running program turned bracketed paste on, which it reads
   * from the mirror rather than assuming.
   *
   * `submit` is separate and defaults to false. Filling a prompt and sending it
   * are two decisions, and a verb that always sent would have no way to hand
   * somebody a draft.
   */
  write: 'sessions.write',
} as const;

/**
 * How much scrollback a capture takes when the caller does not say.
 *
 * A thousand lines is what an archived tab is worth: enough to scroll back
 * through what an agent did, and bounded so a build log that printed a hundred
 * thousand lines does not become a hundred-megabyte file nobody asked for.
 */
export const DEFAULT_CAPTURE_LINES = 1000;

export function registerSessionCommands(options: SessionCommandsOptions): Disposable {
  const { host, registry, viewers, lifetime, holds } = options;

  /** The aggregate — the ONE place "is anybody looking at this" is answered. */
  const viewedBy = (session: SessionID): readonly string[] => viewers?.viewersOf(session) ?? [];

  const subscriptions: Disposable[] = [
    registry.register(SESSION_COMMANDS.capture, {
      // No title: not a palette verb — its whole effect is a return value, and
      // that value is a screenful of bytes.
      permission: 'sessions',
      schema: s.object({ session: s.string(), lines: s.optional(s.int()) }),
      /**
       * This session's screen, scrollback included — without attaching to it.
       *
       * `SessionHost.snapshot` has done this since remote landed: it is how a
       * viewer arriving mid-stream is shown what it missed. It had no verb, so
       * the only thing that could ask was a viewer. Archiving a task is the
       * second caller and wants exactly the same bytes for exactly the same
       * reason — something will have to be shown this screen later, having never
       * seen it live.
       *
       * **Base64**, because the answer crosses an IPC port inside a JSON
       * envelope and these are a terminal's own bytes, not text.
       *
       * Refuses an unknown session rather than answering with an empty screen:
       * "nothing was on it" and "there is no such session" are different facts,
       * and a caller archiving a pane has to tell them apart.
       */
      handler: async (args) => {
        /*
         * AWAITED, and that is the whole reason `snapshot` is callback-shaped
         * rather than a getter: the mirror captures at a point in its WRITE
         * QUEUE, so the sink fires after this turn. A handler that read a local
         * straight after calling it would answer an empty screen every time —
         * and answer it successfully, which is the shape that gets archived as a
         * blank tab and reports no fault.
         */
        const captured = await new Promise<Uint8Array<ArrayBufferLike>>((resolve, reject) => {
          const taken = host.snapshot(
            toSessionId(args.session),
            (bytes) => resolve(bytes),
            args.lines ?? DEFAULT_CAPTURE_LINES,
          );
          // The sink never fires for a session that is not there, so the refusal
          // has to come from the call's own answer.
          if (!taken.ok) reject(new Error(taken.error.message));
        });
        // A copy through a plain array rather than `Buffer.from(view)`: these
        // bytes may sit on a `SharedArrayBuffer`, which `Buffer.from`'s type
        // will not accept.
        return { bytes: Buffer.from(Array.from(captured)).toString('base64') };
      },
    }),

    registry.register(SESSION_COMMANDS.write, {
      // No title: it takes a session id and a body of text, so there is nothing
      // for a person to pick out of a palette.
      permission: 'sessions',
      schema: s.object({
        session: s.string(),
        text: s.string(),
        /** Press Enter after. Default false — see the verb's own comment. */
        submit: s.optional(s.boolean()),
      }),
      /**
       * Refuses an EXITED session rather than writing into a dead pty.
       *
       * `host.write` would answer `unknown-session` for one that has been
       * reaped, but a session whose screen is retained is not in that map either
       * — and "the agent finished while you were reading its PR" is the ordinary
       * case here, not an edge one. A caller that is told gets to say so; one
       * that is not sees its text vanish.
       */
      handler: (args) => {
        const session = toSessionId(args.session);
        const pasted = host.paste(session, args.text);
        if (!pasted.ok) throw new Error(pasted.error.message);
        if (args.submit === true) {
          // A separate write, and AFTER the paste closes: a `\r` inside the
          // brackets is part of the pasted text, not a key press.
          const sent = host.write(session, '\r');
          if (!sent.ok) throw new Error(sent.error.message);
        }
        return { ok: true, submitted: args.submit === true };
      },
    }),

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
              // `SessionCommandsOptions.viewers`. `null` is "not known" (no
              // registry wired) and is deliberately not `false`, which would read
              // as "they are definitely not looking".
              //
              // It is now the AGGREGATE over every client (ADR 0052), and it is
              // still one predicate: a turn that finished under a phone's eyes
              // has been seen, whatever this Mac's window is showing.
              viewing: viewers === undefined ? null : viewedBy(info.id).length > 0,
              // The set behind that boolean, so a client can say WHO — and so
              // "why did I get no banner" has an answer that is not a guess.
              viewers: viewers === undefined ? null : [...viewedBy(info.id)],
            };
          }),
        ),
    }),
  ];

  if (lifetime !== undefined) {
    subscriptions.push(
      registry.register(SESSION_COMMANDS.terminate, {
        title: 'End Session',
        permission: 'sessions',
        schema: s.object({ session: s.string() }),
        /**
         * Unconditional, deliberately. `SessionLifetime.release` is the one that
         * asks whether anybody else is holding it, and it is called by a gesture
         * about a *view*. Somebody naming a session and saying "end it" is not
         * asking whether their phone happens to be showing it.
         */
        handler: (args) => {
          lifetime.terminate(toSessionId(args.session));
          return { session: args.session, terminated: true };
        },
      }),
    );
  }

  if (holds !== undefined) {
    subscriptions.push(
      registry.register(SESSION_COMMANDS.reconcile, {
        title: 'Reconcile Sessions',
        permission: 'sessions',
        schema: s.object({
          claims: s.optional(s.array(s.object({ pane: s.string(), session: s.string() }))),
        }),
        /**
         * Answers, and binds nothing. What a client does with an adopted claim
         * is the client's — this app reattaches its pane, a phone opens a
         * viewer — and a kernel that mutated somebody's layout from here would
         * be deciding for a client it cannot see.
         */
        handler: async (args, caller) => {
          const principal = principalOf(caller);
          const claims: readonly SessionClaim[] = (args.claims ?? []).map((claim) => ({
            pane: claim.pane,
            session: toSessionId(claim.session),
          }));
          return reconcile({
            claims,
            live: host.list().map((info) => info.id),
            held: holds(principal),
          });
        },
      }),
    );
  }

  if (viewers !== undefined) {
    subscriptions.push(
      registry.register(SESSION_COMMANDS.viewing, {
        // No title: it is a client reporting its own state, not a verb a person
        // picks out of a palette.
        permission: 'sessions',
        schema: s.object({ session: s.string(), viewing: s.boolean() }),
        /**
         * The principal comes from the CALLER, never from the arguments. A client
         * that could name the principal could report on another client's behalf
         * — and suppress its notifications, or resurrect a session it does not
         * hold. Same rule as `externalCallerSchema` refusing `user`.
         */
        handler: (args, caller) => {
          const session = toSessionId(args.session);
          const principal = principalOf(caller);
          viewers.report(principal, session, args.viewing);
          return { session: args.session, viewers: [...viewers.viewersOf(session)] };
        },
      }),
    );
  }

  return { dispose: () => disposeAll(subscriptions) };
}
