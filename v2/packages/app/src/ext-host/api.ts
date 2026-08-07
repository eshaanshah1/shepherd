import {
  formatIssues,
  ok,
  err,
  toDisposable,
  type ActivateFn,
  type AttentionAPI,
  type Caller,
  type CategoryLogger,
  type Clock,
  type CommandAPI,
  type CommandError,
  type CommandErrorCode,
  type Disposable,
  type Envelope,
  type EventAPI,
  type ExtensionContext,
  type ExtensionID,
  type ExtensionsAPI,
  type KV,
  type LayoutAPI,
  type LogLevel,
  type Permission,
  type PointsAPI,
  type ProcessAPI,
  type ProposedAPI,
  type Result,
  type Schema,
  type SecretStore,
  type SessionAPI,
  type Shepherd,
  type ViewAPI,
} from '@shepherd/sdk';
import type { ApiCall, WireError, WireResult } from '../shared/ext-protocol.ts';

/**
 * The `Shepherd` object an extension is handed, assembled inside the utility
 * process out of nothing but a message port.
 *
 * **Every member is either a real dispatch to the host or a typed refusal**, and
 * a refusal is always one of exactly two kinds, each named at its call site:
 *
 *   - `LANDS_IN(milestone)` — typed in the SDK, not built yet. `ProcessAPI` and
 *     `SecretStore` were declared unimplemented in M1 by the plan itself;
 *     `sessions` and `points` arrive with M2's agents, `views` with M3's first
 *     real view contribution.
 *   - `ACROSS_A_PORT` — the signature is **synchronous** and the answer lives in
 *     another process. `KV.get`, `commands.list`, `attention.count` and every
 *     `LayoutAPI` read are in this class. The fix is a pushed mirror, which the
 *     first view contribution needs anyway; inventing one now would be building
 *     for a later milestone.
 *
 * The third option — return `undefined`, or an empty array, or silently do
 * nothing — is the one thing this file will not do. That is the `acceptBridged`
 * failure: an extension that believes it contributed, a host that never saw it,
 * and no line anywhere saying so.
 */

export class NotImplementedError extends Error {
  /**
   * Declared and assigned rather than a constructor parameter property: Electron
   * runs this on node's type stripping, which can only erase, so a parameter
   * property is a launch failure. `erasableSyntaxOnly` makes it a typecheck one.
   */
  readonly capability: string;
  readonly reason: string;

  constructor(capability: string, reason: string) {
    super(`${capability} is not available in this build — ${reason}`);
    this.name = 'NotImplementedError';
    this.capability = capability;
    this.reason = reason;
  }
}

const LANDS_IN = (milestone: string): string =>
  `it is typed in @shepherd/sdk and implemented in ${milestone}. ` +
  'Nothing was done, and this error is how you find that out at the call rather than three layers later.';

const ACROSS_A_PORT =
  'its signature is synchronous and the answer lives in the main process. ' +
  'Extension services run in a utility process (sketch §7b), so this needs a pushed mirror — ' +
  'which arrives with the first real view contribution rather than being invented here.';

/** Core's `ATTENTION_TOPIC`, as a literal: a utility process may not import `@shepherd/core`. */
const ATTENTION_TOPIC = 'attention.changed';

/** Core's `LAYOUT_COMMANDS.split`. A command id is public vocabulary, like a CLI verb. */
const LAYOUT_SPLIT = 'layout.split';

/** What the runtime gives the API object: a port, a subscription table, a command table. */
export interface ExtHostServices {
  /** Send a call and await the host's typed answer. Never throws. */
  call(call: ApiCall): Promise<WireResult>;
  /**
   * Send a call whose result only ever reaches a log.
   *
   * Used exclusively where the SDK signature returns `void`. `describe` is what
   * the log line says, because "a call failed" without naming which is the
   * silence this codebase is built to refuse.
   */
  tell(call: ApiCall, describe: string): void;
  subscribe(topic: string, fn: (payload: unknown, envelope: Envelope) => void): Disposable;
  /** Records the handler the host will call back for `commandId`. */
  defineCommand(commandId: string, handler: ExtensionCommand): Disposable;
  log(level: LogLevel, message: string): void;
}

/** An extension's command handler, with its own schema already applied. */
export type ExtensionCommand = (args: unknown, caller: Caller) => Promise<WireResult>;

export interface ExtensionRuntimeRecord {
  readonly id: ExtensionID;
  readonly context: ExtensionContext;
  readonly api: Shepherd;
  readonly activate: ActivateFn;
}

// ------------------------------------------------------------------------ storage

/**
 * `ctx.storage`, as a write-through mirror of the host's namespace.
 *
 * The seed arrives in the `activate` ask. Reads are local because `KV.get` is
 * synchronous; writes update the mirror **and** go to the host. Sound because a
 * namespace has exactly one writer — see the `storage.set` comment in
 * `ext-protocol.ts`, which is where that argument has to be revisited if it ever
 * stops holding.
 */
export function createStorage(seed: Readonly<Record<string, unknown>>, services: ExtHostServices): KV {
  const mirror = new Map<string, unknown>(Object.entries(seed));
  return {
    get<T>(key: string, schema: Schema<T>): T | undefined {
      if (!mirror.has(key)) return undefined;
      const parsed = schema.parse(mirror.get(key));
      if (parsed.ok) return parsed.value;
      // Same discipline as core's `NamespacedKV`: a value written by an older
      // build reads as ABSENT and logs, never throws. A stored blob must not be
      // able to stop an extension from starting.
      services.log('warn', `storage/${key} does not match its schema, treating as absent: ${formatIssues(parsed.error)}`);
      return undefined;
    },
    set<T>(key: string, value: T): void {
      mirror.set(key, value);
      services.tell({ kind: 'storage.set', key, value }, `storage.set ${key}`);
    },
    delete(key: string): void {
      mirror.delete(key);
      services.tell({ kind: 'storage.delete', key }, `storage.delete ${key}`);
    },
    /** Sorted, matching the store's `ORDER BY key` so the two cannot disagree. */
    keys: () => [...mirror.keys()].sort(),
  };
}

// ------------------------------------------------------------------------ secrets

/**
 * Typed and deliberately unbuilt (M1 plan, P0): the keychain lands when
 * something needs a credential.
 *
 * Every method returns a promise, so the refusal is a **rejection carrying a
 * named error** — the closest the signature allows to a value. `get` resolving
 * `undefined` would be worse in exactly the way this whole file is about: the
 * caller would read it as "no such secret" and go quiet.
 */
function createSecrets(): SecretStore {
  const refuse = (verb: string): Promise<never> =>
    Promise.reject(new NotImplementedError(`secrets.${verb}`, LANDS_IN('a later milestone')));
  return {
    get: () => refuse('get'),
    set: () => refuse('set'),
    delete: () => refuse('delete'),
  };
}

// -------------------------------------------------------------------- the context

export interface ContextOptions {
  readonly id: ExtensionID;
  readonly source: 'builtin' | 'user';
  readonly permissions: readonly Permission[];
  readonly storage: Readonly<Record<string, unknown>>;
  readonly clock: Clock;
  readonly services: ExtHostServices;
}

export function createContext(options: ContextOptions): ExtensionContext {
  const { services } = options;
  const log: CategoryLogger = {
    debug: (message) => services.log('debug', message),
    info: (message) => services.log('info', message),
    warn: (message) => services.log('warn', message),
    error: (message) => services.log('error', message),
  };
  return {
    id: options.id,
    source: options.source,
    subscriptions: [],
    storage: createStorage(options.storage, services),
    secrets: createSecrets(),
    log,
    clock: options.clock,
    permissions: options.permissions,
  };
}

// ------------------------------------------------------------------------ the API

/**
 * `WireErrorCode` → `CommandErrorCode`.
 *
 * The four codes an extension can act on map straight across; everything else
 * (a dead host, a timeout, a bad frame, an unknown handle) collapses to
 * `unavailable`, which is the honest reading: the command exists, and this
 * caller could not reach it.
 */
function commandErrorFor(id: string, error: WireError): CommandError {
  const codes: Partial<Record<WireError['code'], CommandErrorCode>> = {
    'unknown-command': 'unknown-command',
    'invalid-args': 'invalid-args',
    denied: 'denied',
    'handler-failed': 'handler-failed',
  };
  return { code: codes[error.code] ?? 'unavailable', message: error.message, commandId: id };
}

function createCommands(services: ExtHostServices): CommandAPI {
  return {
    register(id, spec) {
      const local = services.defineCommand(id, async (args, caller) => {
        // The extension's OWN schema, run before its handler — see the
        // `command.register` comment in `ext-protocol.ts`. The registry's
        // "arguments are validated before any handler" guarantee holds; it is
        // executed here because here is where the schema exists.
        const parsed = spec.schema.parse(args);
        if (!parsed.ok) {
          return { ok: false, error: { code: 'invalid-args', message: formatIssues(parsed.error) } };
        }
        const value = await spec.handler(parsed.value, caller);
        return { ok: true, value };
      });
      services.tell(
        {
          kind: 'command.register',
          commandId: id,
          ...(spec.title === undefined ? {} : { title: spec.title }),
          ...(spec.permission === undefined ? {} : { permission: spec.permission }),
        },
        `command.register ${id}`,
      );
      return toDisposable(() => {
        local.dispose();
        services.tell({ kind: 'command.unregister', commandId: id }, `command.unregister ${id}`);
      });
    },

    async invoke<R>(id: string, args?: unknown): Promise<Result<R, CommandError>> {
      const answer = await services.call({ kind: 'command.invoke', commandId: id, args });
      return answer.ok ? ok(answer.value as R) : err(commandErrorFor(id, answer.error));
    },

    list() {
      throw new NotImplementedError('commands.list', ACROSS_A_PORT);
    },
  };
}

function createEvents(services: ExtHostServices): EventAPI {
  return {
    emit<T>(topic: string, payload: T): void {
      services.tell({ kind: 'event.emit', topic, payload }, `event.emit ${topic}`);
    },
    on<T>(topic: string, fn: (payload: T, envelope: Envelope) => void): Disposable {
      return services.subscribe(topic, fn as (payload: unknown, envelope: Envelope) => void);
    },
  };
}

/**
 * Attention, routed through the **`attention.set` / `attention.clear` commands**
 * rather than a channel of its own.
 *
 * Both declare `permission: 'attention'`, so an extension that never asked for it
 * is refused by the one authorizer in the dispatcher — no second check anywhere.
 * `set` and `clear` return `void`, so a refusal reaches the extension only as a
 * log line; an extension that wants to *see* the verdict invokes the command
 * itself and reads the typed error, which is exactly what
 * `diagnostics.probeDenied` does.
 */
function createAttention(services: ExtHostServices): AttentionAPI {
  return {
    set(target, state) {
      services.tell(
        {
          kind: 'command.invoke',
          commandId: 'attention.set',
          args: {
            target,
            level: state.level,
            reason: state.reason,
            ...(state.color === undefined ? {} : { color: state.color }),
          },
        },
        `attention.set ${target}`,
      );
    },
    clear(target) {
      services.tell(
        { kind: 'command.invoke', commandId: 'attention.clear', args: { target } },
        `attention.clear ${target}`,
      );
    },
    get() {
      throw new NotImplementedError('attention.get', ACROSS_A_PORT);
    },
    count() {
      throw new NotImplementedError('attention.count', ACROSS_A_PORT);
    },
    /** The one observer that IS implementable: the store already emits on the bus. */
    onDidChange(fn) {
      return services.subscribe(ATTENTION_TOPIC, () => fn());
    },
  };
}

/**
 * Layout: every member refuses, and the refusal points at the command.
 *
 * Reads are synchronous (`roots`, `node`, `isViewing`) so they cannot cross a
 * port; mutations are already registered commands, so `commands.invoke` reaches
 * the real `LayoutStore` through the real authorizer. `open(view, target)` needs
 * a registered view type, and `views.registerViewType` is itself M3 — so an
 * `open` that appeared to work would be the emptiest promise in the file.
 */
function createLayout(): LayoutAPI {
  const readAcrossAPort = (member: string): never => {
    throw new NotImplementedError(`layout.${member}`, ACROSS_A_PORT);
  };
  return {
    roots: () => readAcrossAPort('roots'),
    root: () => readAcrossAPort('root'),
    node: () => readAcrossAPort('node'),
    nodeForSession: () => readAcrossAPort('nodeForSession'),
    isViewing: () => readAcrossAPort('isViewing'),
    onDidChangeViewing: () => readAcrossAPort('onDidChangeViewing'),
    onDidChangeLayout: () => readAcrossAPort('onDidChangeLayout'),
    open: () =>
      Promise.reject(
        new NotImplementedError(
          'layout.open',
          `it needs a registered view type (views.registerViewType lands in M3). ` +
            `To mutate the pane tree today, invoke the command: commands.invoke('${LAYOUT_SPLIT}', { axis: 'row' }).`,
        ),
      ),
  };
}

function createSessions(): SessionAPI {
  const refuse = (member: string): never => {
    throw new NotImplementedError(`sessions.${member}`, LANDS_IN('M2 (agents-core)'));
  };
  return {
    create: () => Promise.reject(new NotImplementedError('sessions.create', LANDS_IN('M2 (agents-core)'))),
    get: () => refuse('get'),
    list: () => refuse('list'),
    onWillCreate: () => refuse('onWillCreate'),
    onDidCreate: () => refuse('onDidCreate'),
    onDidExit: () => refuse('onDidExit'),
  };
}

function createViews(): ViewAPI {
  const refuse = (member: string): never => {
    throw new NotImplementedError(`views.${member}`, LANDS_IN('M3 (the first real view contribution)'));
  };
  return {
    registerViewType: () => refuse('registerViewType'),
    registerStatusItem: () => refuse('registerStatusItem'),
  };
}

function createPoints(): PointsAPI {
  const refuse = (member: string): never => {
    throw new NotImplementedError(
      `points.${member}`,
      'a point hands back a live object holding provider functions, which cannot cross a port. ' +
        "Core's PointRegistry is built and tested; wiring it to a utility-process extension lands with M2, " +
        'its first real consumer.',
    );
  };
  return { define: () => refuse('define'), get: () => refuse('get') };
}

function createExtensions(): ExtensionsAPI {
  const refuse = (member: string): never => {
    throw new NotImplementedError(`extensions.${member}`, ACROSS_A_PORT);
  };
  return { get: () => refuse('get'), isActive: () => refuse('isActive') };
}

function createProcess(): ProcessAPI {
  const refuse = (member: string): Promise<never> =>
    Promise.reject(new NotImplementedError(`process.${member}`, LANDS_IN('M3, when tasks needs git')));
  return { exec: () => refuse('exec'), gitRead: () => refuse('gitRead'), gitWrite: () => refuse('gitWrite') };
}

export interface ShepherdOptions {
  readonly apiVersion: string;
  /**
   * Whether `api.proposed` is assembled at all — the host's decision, per §7:
   * always for a `builtin`, and for a `user` extension only in a dev build. False
   * here means the object exists but every group refuses, so an extension that
   * ignored the refusal at activation still cannot reach anything.
   */
  readonly proposed: boolean;
  readonly services: ExtHostServices;
}

export function createShepherd(options: ShepherdOptions): Shepherd {
  const { services } = options;
  const gated = <T extends object>(group: string, build: () => T): T =>
    options.proposed ? build() : (refuseGroup(group) as T);

  const proposed: ProposedAPI = {
    commands: gated('commands', () => createCommands(services)),
    events: gated('events', () => createEvents(services)),
    sessions: createSessions(),
    layout: createLayout(),
    views: createViews(),
    attention: gated('attention', () => createAttention(services)),
    points: createPoints(),
    extensions: createExtensions(),
    process: createProcess(),
  };
  return { version: options.apiVersion, proposed };
}

/**
 * What a group looks like when `proposed` was refused.
 *
 * A `Proxy` rather than a hand-written stub per group: the point is that
 * *whatever* member is touched says the same thing, and a stub table would drift
 * from the interface the day a member is added. The host refuses the activation
 * outright in this case (see `ext-host.ts`), so this is the second line of
 * defence rather than the first.
 */
function refuseGroup(group: string): object {
  return new Proxy(
    {},
    {
      get(_target, member) {
        return () => {
          throw new NotImplementedError(
            `${group}.${String(member)}`,
            'every M1 API is proposed, and a `user` extension may only touch proposed APIs in a dev build (sketch §7)',
          );
        };
      },
    },
  );
}
