// The extension-host wire vocabulary, in one file both processes import. Loaded
// in main AND in the utility process, so it may import neither electron nor
// react nor node-pty (lint) — `@shepherd/sdk` is types plus pure helpers and is
// the one dependency a frame definition needs.

import { err, manifestSchema, ok, s, type Infer, type Result, type Schema } from '@shepherd/sdk';

/**
 * What crosses the `MessagePort` between main and the extension host.
 *
 * Four rules, and each of them is a failure this project has already paid for
 * once:
 *
 *   1. **The protocol version is negotiated, not assumed.** The child announces
 *      what it speaks in `hello`; the host accepts (`hello-ok`) or refuses with
 *      a reason (`hello-refused`). Two sides that both `import` a constant agree
 *      by construction and therefore cannot detect a stale build — which is the
 *      one case a version number exists for.
 *   2. **An unknown frame is logged and skipped, never discarded with its
 *      batch.** `readFrames` accepts one frame or an array of them and returns
 *      the ones it understood *plus a reason per element it did not*. A reader
 *      that threw away the whole message because element three was from a newer
 *      build is review §Bad-2, one layer along, and this is the shape that
 *      closes it before it opens.
 *   3. **Every request carries a correlation id, and a response to an id nobody
 *      is waiting for is logged rather than thrown.** A late answer arriving
 *      after a timeout is a normal event on a process boundary; it must not be
 *      able to take main down.
 *   4. **A frame names no principal.** There is deliberately no `extensionId`
 *      field on a child→host `call`: the host derives who is asking from the
 *      opaque `handle` it minted when it asked that extension to activate. A
 *      self-declared caller is v1's `tab_id`-holding-a-pane-id lie in a new
 *      costume, and `s.object` rejecting unknown keys means a frame that tries
 *      to add one is refused outright rather than quietly ignored.
 */

/** Bumped when a frame's meaning changes. The child sends it; the host judges it. */
export const EXT_PROTOCOL_VERSION = 1;

/** Everything this host build can still talk to. */
export const SUPPORTED_EXT_PROTOCOLS: readonly number[] = [1];

/**
 * The `Shepherd.version` an extension is handed, and what its manifest's `api`
 * range is tested against. Everything in it is `proposed` (sketch §7).
 */
export const HOST_API_VERSION = '1.0.0';

// --------------------------------------------------------------------- failures

/**
 * Why a call failed. A closed set because the child branches on it — a message
 * string is for a human, a code is for a program, and an extension deciding
 * "was I denied or is the host gone?" needs the second.
 *
 * Every member is produced somewhere; a code nothing emits is a branch nothing
 * takes. In particular there is no `not-implemented` here — an M1 refusal is
 * decided *in* the child, in process, and never travels — and no
 * `protocol-refused`, because a refused handshake is its own frame
 * (`hello-refused`) carrying a sentence rather than a code.
 */
export const WIRE_ERROR_CODES = [
  /** The handle on the frame names no live extension. Nothing was dispatched. */
  'unknown-handle',
  /** The real authorizer said no. Carries its reason verbatim. */
  'denied',
  /** The other end is gone or not accepting yet. */
  'unavailable',
  'timeout',
  /** The host tried and something threw. Distinct from `denied` on purpose. */
  'host-failed',
  'duplicate-command',
  'unknown-command',
  'invalid-args',
  'handler-failed',
] as const;

export type WireErrorCode = (typeof WIRE_ERROR_CODES)[number];

export interface WireError {
  readonly code: WireErrorCode;
  readonly message: string;
}

/**
 * A `Result` that survives a structured clone.
 *
 * Its own type rather than the SDK's `Result<T, WireError>`: `value` has to be
 * *optional* here, because a void call ("I registered your command") answers
 * with a success carrying nothing, and an absent key is what a clone of
 * `undefined` reads back as.
 */
export type WireResult =
  | { readonly ok: true; readonly value?: unknown }
  | { readonly ok: false; readonly error: WireError };

export const wireOk = (value?: unknown): WireResult => ({ ok: true, value });

export const wireErr = (code: WireErrorCode, message: string): WireResult => ({
  ok: false,
  error: { code, message },
});

const wireErrorSchema: Schema<WireError> = s.object({
  code: s.enumOf(WIRE_ERROR_CODES),
  message: s.string(),
});

const wireResultSchema: Schema<WireResult> = s.union(
  s.object({ ok: s.literal(true), value: s.optional(s.unknown()) }),
  s.object({ ok: s.literal(false), error: wireErrorSchema }),
);

// ------------------------------------------------------- child -> host: the API

/**
 * The API surface the child may reach, one variant per call.
 *
 * Note what is NOT here, and why each absence is a decision rather than an
 * oversight:
 *
 *   - `points.define` and `sessions.*` hand back live objects and take
 *     callbacks, neither of which crosses a port. The child answers those with a
 *     `not-implemented` refusal naming the milestone that lands them — a proxy
 *     that silently returned an empty list would be the silent no-op this whole
 *     file exists to refuse.
 *   - **There is no `layout.*` call.** Every `LayoutAPI` read is synchronous and
 *     so cannot cross a port at all, and every `LayoutAPI` mutation is already a
 *     registered command — so an extension reaches the real `LayoutStore`
 *     through `command.invoke('layout.split')`, authorized by the same
 *     dispatcher as every other transport. A second frame wrapping the same
 *     invocation would be a second authorization path, which is exactly what the
 *     one verb table exists to prevent.
 */
/**
 * `ExecOptions` minus the parts that cannot cross a structured clone.
 *
 * `signal` is an `AbortSignal` — not clonable, and meaningless in another
 * process — so it is honoured on the child's side of the API and never sent.
 */
const execOptionsSchema = s.object({
  cwd: s.string(),
  env: s.optional(s.record(s.string())),
  stdin: s.optional(s.string()),
  timeoutMs: s.int(),
});

const apiCallSchema = s.union(
  /**
   * The host registers a **proxy** in the real `CommandRegistry` that forwards
   * back here.
   *
   * No schema crosses — a `Schema<T>` is an object carrying a `parse` function —
   * so the host registers a pass-through and the **child** runs the extension's
   * own schema before its handler. The registry's guarantee is intact (arguments
   * are validated before a handler ever sees them, and the failure is a typed
   * `invalid-args`); it is simply executed one process along, which is the only
   * place the schema exists.
   */
  s.object({
    kind: s.literal('command.register'),
    commandId: s.string(),
    title: s.optional(s.string()),
    permission: s.optional(s.string()),
  }),
  s.object({ kind: s.literal('command.unregister'), commandId: s.string() }),
  /**
   * `timeoutMs` is the caller's patience, and it has to travel because a command
   * invocation has TWO transport legs — child→host, then host→child for a command
   * an extension owns — and neither leg can read it out of `args`, which is
   * `unknown` by design. Absent means both legs keep their flat defaults.
   */
  s.object({
    kind: s.literal('command.invoke'),
    commandId: s.string(),
    args: s.optional(s.unknown()),
    timeoutMs: s.optional(s.int()),
  }),

  s.object({ kind: s.literal('event.emit'), topic: s.string(), payload: s.optional(s.unknown()) }),
  /** `subscription` is minted by the CHILD: it is the key its own callback table is under. */
  s.object({ kind: s.literal('event.on'), topic: s.string(), subscription: s.string() }),
  s.object({ kind: s.literal('event.off'), subscription: s.string() }),

  /**
   * Writes only. `ctx.storage` is a **synchronous** `KV`, so a read cannot cross
   * a port: the child is handed its whole namespace in the `activate` ask and
   * keeps a write-through mirror of it. That is sound because a namespace has
   * exactly one writer — the extension it belongs to — and it is the reason the
   * mirror needs no invalidation. The day a second writer exists (a settings UI
   * editing an extension's keys), this grows a push frame and that argument has
   * to be revisited rather than assumed.
   */
  s.object({ kind: s.literal('storage.set'), key: s.string(), value: s.optional(s.unknown()) }),
  s.object({ kind: s.literal('storage.delete'), key: s.string() }),

  /**
   * Running a program — the one call whose duration is the CALLER's business.
   *
   * `opts.timeoutMs` is required by `ExecOptions` and is what the transport
   * derives this call's deadline from (`deadlineFor`), because a cold `git
   * fetch` outlives the flat 15s and a `git worktree add` on a large repo can.
   * `signal` and the promise-shaped result stay on the API's side of the port —
   * an `AbortSignal` is not clonable, so cancellation is the caller's own
   * timeout here.
   *
   * `git` is its own kind rather than an `exec` of `['git', …]` so the
   * read/write distinction survives the crossing: the host applies
   * `GIT_OPTIONAL_LOCKS=0` to a read and merges (never replaces) the environment
   * for a write. Structural, per the Rebuild checklist — a child that had to
   * remember to ask for those would eventually not.
   */
  s.object({
    kind: s.literal('process.exec'),
    cmd: s.array(s.string()),
    opts: execOptionsSchema,
  }),
  s.object({
    kind: s.literal('process.git'),
    mode: s.enumOf(['read', 'write'] as const),
    args: s.array(s.string()),
    opts: execOptionsSchema,
  }),

  /**
   * A contributed view — M3's first, and what retires main's one-topic relay
   * allow-list.
   *
   * Only the DECLARATION crosses here. A `TreeDataProvider` is functions, which
   * a port cannot carry, so the host asks for children by `view.children` and
   * the child answers from the provider it kept. `view.changed` is the child
   * saying the provider fired — the host then re-asks. Push the DATA and the
   * host would have to trust a snapshot it did not request; this way the host
   * decides when to read, which is also what keeps a chatty extension from
   * flooding the renderer.
   */
  /**
   * `component` (ADR 0033) crosses the same way, and for the same reason: a
   * React component is functions. What travels is the NAME of a UI module the
   * renderer resolves — so the declaration is still the only thing on the wire,
   * and the child still never sends a rendered anything.
   */
  s.object({
    kind: s.literal('view.register'),
    type: s.string(),
    viewKind: s.enumOf(['tree', 'component'] as const),
    /** Present iff `viewKind` is `component`. Meaningless for a tree. */
    component: s.optional(s.string()),
    /** Where the shell draws it, and what raises it. Components only. */
    surface: s.optional(s.enumOf(['dock', 'overlay', 'pane'] as const)),
    key: s.optional(s.string()),
    title: s.optional(s.string()),
    /** The glyph on the control that raises an overlay. A NAME, resolved in the renderer. */
    icon: s.optional(s.string()),
    /**
     * This tree wants a search field, and the verb that receives each query.
     *
     * Trees only. The query is answered by the extension rather than filtered in
     * the page — see `ViewProvider`'s `search` for why it has to be.
     */
    search: s.optional(s.stored({ command: s.string(), placeholder: s.optional(s.string()) })),
  }),
  s.object({ kind: s.literal('view.unregister'), type: s.string() }),
  s.object({ kind: s.literal('view.changed'), type: s.string() }),

  s.object({
    kind: s.literal('log'),
    level: s.enumOf(['debug', 'info', 'warn', 'error'] as const),
    message: s.string(),
  }),
);

export type ApiCall = Infer<typeof apiCallSchema>;

// ------------------------------------------------------- host -> child: the asks

/**
 * The attributed caller, as it reaches an extension's own command handler.
 *
 * Its own schema rather than the SDK's `externalCallerSchema`, which
 * deliberately has no `user` or `kernel` variant because a socket client may not
 * claim to be the human at the keyboard. Here the *host* is the writer, and the
 * whole union is legitimate — `CommandSpec.handler(args, caller)` promises the
 * real one, and substituting `USER` for a device would be the attribution lie
 * `Caller` was introduced to end.
 */
const wireCallerSchema = s.union(
  s.object({ kind: s.literal('user') }),
  s.object({ kind: s.literal('kernel') }),
  s.object({ kind: s.literal('extension'), id: s.string() }),
  s.object({ kind: s.literal('device'), deviceId: s.string() }),
  s.object({ kind: s.literal('agent'), sessionId: s.string() }),
);

/** Structurally `Caller`, minus the SDK's branded id types (a brand is compile-time). */
export type WireCaller = Infer<typeof wireCallerSchema>;

const hostAskSchema = s.union(
  s.object({
    kind: s.literal('activate'),
    /**
     * The extension to run. It is the host's word, not the child's: everything
     * the child later says about itself is attributed through `handle`, which
     * this frame is the only source of.
     */
    extension: s.string(),
    handle: s.string(),
    manifest: manifestSchema,
    source: s.enumOf(['builtin', 'user'] as const),
    /**
     * Whether `api.proposed` is assembled at all. A built-in always gets it
     * (§7: built-ins are *required* to consume proposed APIs — that requirement
     * is the proving ground); a `user` extension only in a dev build.
     */
    proposed: s.boolean(),
    apiVersion: s.string(),
    permissions: s.array(s.string()),
    /** This extension's whole `KV` namespace — see the `storage.set` comment. */
    storage: s.record(s.unknown()),
    /**
     * This extension's EFFECTIVE settings: its own namespace, plus the kernel's
     * `shepherd.*`.
     *
     * A seed for `storage`'s reason — `SettingsAPI.get` is synchronous and the
     * values live in main — but with the second half of that comment's warning
     * now true. A setting has more than one writer (the screen, the CLI, the
     * extension itself), so this mirror is not write-through-and-trust: it is
     * corrected by the `settings.changed` bus event, which every writer's change
     * passes through.
     *
     * Required rather than optional, for `homeDir`'s reason: an extension seeded
     * with nothing reads defaults that are not the user's, and a fixture that
     * builds an `activate` frame should have to say so.
     */
    settings: s.record(s.unknown()),
    /**
     * A directory of its own, under the app's support dir (D1b).
     *
     * The host resolves it because the child cannot: `boundaries.js` denies
     * `node:os` here, so `homedir()` is unreachable and a path is not something
     * an extension can compute. It arrives with `activate` rather than through a
     * call because it is a fact about this extension, fixed for its lifetime.
     */
    dataDir: s.string(),
    /**
     * The user's home directory — see `ExtensionContext.homeDir`.
     *
     * Required rather than optional, unlike `isDev` below: there is no honest
     * default for where a user's home is, and an extension that got the wrong
     * one would write into a path that exists on nobody's machine. A fixture
     * that builds an `activate` frame has to say, which is the right cost.
     */
    homeDir: s.string(),
    /**
     * The account name — see `ExtensionContext.userName`.
     *
     * Required for the same reason `homeDir` is, and with less room for a
     * default than it has: an extension that guessed this would build an
     * environment in which a program reports itself logged out, which is a
     * failure that reads like a user's problem rather than ours.
     */
    userName: s.string(),
    /**
     * Whether developer surfaces are on (a dev build, or a smoke driving one).
     *
     * Optional on the wire, defaulting to false: a required field here breaks
     * every test fixture that builds an `activate` frame, and the honest default
     * for "should I show developer UI" is no.
     */
    isDev: s.optional(s.boolean()),
  }),
  s.object({ kind: s.literal('deactivate'), extension: s.string() }),
  /** Read a contributed tree. The provider lives in the child; this is the read. */
  s.object({
    kind: s.literal('view.children'),
    extension: s.string(),
    type: s.string(),
    parent: s.optional(s.string()),
  }),
  /** Run the handler this extension registered for `commandId`. */
  s.object({
    kind: s.literal('command'),
    extension: s.string(),
    commandId: s.string(),
    args: s.optional(s.unknown()),
    caller: wireCallerSchema,
  }),
);

export type HostAsk = Infer<typeof hostAskSchema>;

// ------------------------------------------------------------------- the frames

export const childFrameSchema = s.union(
  s.object({
    kind: s.literal('hello'),
    id: s.string(),
    protocol: s.int(),
    /** So the host can log which OS process answered — and a smoke can prove it. */
    childPid: s.int(),
  }),
  s.object({
    kind: s.literal('call'),
    id: s.string(),
    handle: s.string(),
    call: apiCallSchema,
    /**
     * How long the CHILD will wait for this call's answer. A transport property,
     * so it rides the frame rather than every `ApiCall` variant — and it is here
     * rather than inferred by the host so a log line on either side can say the
     * same number.
     */
    deadlineMs: s.optional(s.int()),
  }),
  /** The child's answer to a host `ask`, correlated by the ask's own id. */
  s.object({ kind: s.literal('answer'), id: s.string(), result: wireResultSchema }),
);

export type ChildFrame = Infer<typeof childFrameSchema>;

export const hostFrameSchema = s.union(
  s.object({ kind: s.literal('hello-ok'), id: s.string(), protocol: s.int(), apiVersion: s.string() }),
  s.object({ kind: s.literal('hello-refused'), id: s.string(), reason: s.string() }),
  s.object({ kind: s.literal('ask'), id: s.string(), ask: hostAskSchema }),
  /** The host's answer to a child `call`. */
  s.object({ kind: s.literal('result'), id: s.string(), result: wireResultSchema }),
  /**
   * A bus event reaching a subscription the child asked for. Fire-and-forget, so
   * it carries the subscription key rather than a correlation id — there is no
   * answer to correlate, and giving it a request id would imply one.
   */
  s.object({
    kind: s.literal('event'),
    subscription: s.string(),
    topic: s.string(),
    payload: s.optional(s.unknown()),
    /** The bus `Envelope`, whole. An event stripped of its source or its sequence
     * loses exactly the evidence those fields exist to carry. */
    seq: s.int(),
    ts: s.number(),
    source: wireCallerSchema,
  }),
);

export type HostFrame = Infer<typeof hostFrameSchema>;

// -------------------------------------------------------------------- the reader

export interface FrameRead<F> {
  readonly frames: readonly F[];
  /** One sentence per element that did not parse, ready for a log line. */
  readonly skipped: readonly string[];
}

/**
 * Everything in `raw` this build understands, plus a reason for everything it
 * did not.
 *
 * A message may be one frame or an array of them, and **a bad element costs
 * only itself**. That is the whole point: the batch shape exists so that a host
 * and a child at different versions degrade one frame at a time instead of
 * going mutually silent, and a reader that returned `[]` on the first bad
 * element would make the batch the unit of failure again.
 *
 * Nothing here throws. An `unknown` off a message port is untrusted input.
 */
export function readFrames<F>(raw: unknown, schema: Schema<F>): FrameRead<F> {
  const elements = Array.isArray(raw) ? (raw as unknown[]) : [raw];
  const frames: F[] = [];
  const skipped: string[] = [];
  elements.forEach((element, index) => {
    const parsed = schema.parse(element);
    if (parsed.ok) frames.push(parsed.value);
    else skipped.push(`frame[${index}] ${describeKind(element)}: ${parsed.error.map((i) => i.message).join('; ')}`);
  });
  return { frames, skipped };
}

/**
 * Version negotiation, as one pure decision.
 *
 * The refusal names both numbers. "protocol mismatch" sends somebody to read
 * two files; "child speaks 2, this host speaks 1" is a build-skew diagnosis on
 * sight.
 */
export function negotiate(claimed: unknown): Result<number, string> {
  if (typeof claimed !== 'number' || !Number.isInteger(claimed)) {
    return err(`extension host announced a non-integer protocol version (${describeKind(claimed)})`);
  }
  if (!SUPPORTED_EXT_PROTOCOLS.includes(claimed)) {
    return err(
      `extension host speaks protocol ${claimed}; this build speaks ` +
        `${SUPPORTED_EXT_PROTOCOLS.join(', ')} — the two halves are from different builds`,
    );
  }
  return ok(claimed);
}

/**
 * Correlation ids, per process, with a prefix so a log line says which side
 * minted one. Sequential rather than random: these are matched against a local
 * table, never used as a secret (that is `handle`'s job), and a counter makes an
 * out-of-order log readable.
 */
export function frameIds(prefix: string): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}-${next}`;
  };
}

/** For a skip reason: enough to recognise the frame without dumping a payload. */
function describeKind(element: unknown): string {
  if (typeof element !== 'object' || element === null) return typeof element;
  const kind = (element as { kind?: unknown }).kind;
  return typeof kind === 'string' ? `kind=${JSON.stringify(kind)}` : 'no kind';
}
