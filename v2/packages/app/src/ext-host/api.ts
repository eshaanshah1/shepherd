import {
  formatIssues,
  ok,
  err,
  toDisposable,
  PointRegistry,
  type AttentionAPI,
  type Caller,
  type CategoryLogger,
  type Clock,
  type CommandAPI,
  type CommandError,
  type CommandErrorCode,
  type InvokeOptions,
  type Disposable,
  type Envelope,
  type EventAPI,
  type ExtensionContext,
  type ExtensionID,
  type ExtensionPoint,
  type ExtensionsAPI,
  type KV,
  type LayoutAPI,
  type Logger,
  type LogLevel,
  type Permission,
  type PointsAPI,
  type ExecErr,
  type ExecOk,
  type ExecOptions,
  type ProcessAPI,
  type ProposedAPI,
  type Result,
  type Schema,
  type SecretStore,
  type SessionAPI,
  type Shepherd,
  type ViewAPI,
  type ViewProvider,
} from '@shepherd/sdk';
import type { ApiCall, WireError, WireResult } from '../shared/ext-protocol.ts';

/**
 * The `Shepherd` object an extension is handed, assembled inside the utility
 * process out of nothing but a message port.
 *
 * **Every member is either a real dispatch to the host or a typed refusal**, and
 * a refusal is always one of exactly four kinds, each named at its call site:
 *
 *   - `LANDS_IN(milestone)` — typed in the SDK, not built yet. `ProcessAPI` and
 *     `SecretStore` were declared unimplemented in M1 by the plan itself;
 *     `sessions` arrives with M2's agents, `views` with M3's first real view
 *     contribution.
 *   - `ACROSS_A_PORT` — the signature is **synchronous** and the answer lives in
 *     another process. `KV.get`, `commands.list`, `attention.count` and every
 *     `LayoutAPI` read are in this class. The fix is a pushed mirror, which the
 *     first view contribution needs anyway; inventing one now would be building
 *     for a later milestone.
 *   - `UndeclaredDependencyError` — the caller asked for another extension's API
 *     or point without naming its owner in the manifest's `dependencies`.
 *     Cross-extension access is **declared, not discovered** (sketch §7c), which
 *     is the whole reason it is reviewable; a caller that routed around the
 *     manifest has a manifest bug and must be told so at the call.
 *   - `ExtensionUnreachableError` — the dependency is declared and its API still
 *     cannot be handed over: nothing here hosts it, or it activated and exported
 *     nothing.
 *
 * The last two exist because **`undefined` is already spoken for**. `ExtensionsAPI
 * .get` types it as "not active", so returning it for "lives in another process"
 * or "exported nothing" would make three different facts one answer — the exact
 * ambiguity the rest of this file is built to remove.
 *
 * The other option — return `undefined` where it means nothing, or an empty
 * array, or silently do nothing — is the one thing this file will not do. That is
 * the `acceptBridged` failure: an extension that believes it contributed, a host
 * that never saw it, and no line anywhere saying so.
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

/**
 * A caller reaching for something it never declared.
 *
 * Not a `denied` from the host's authorizer: that one is about *permissions*,
 * decided in main. This is decided here, in the child, because here is where the
 * resolution happens and a judgement made in two places is a judgement two places
 * can disagree about — which is why core's unused `ExtensionRegistry.apiFor` was
 * deleted rather than joined.
 */
export class UndeclaredDependencyError extends Error {
  /** Declared and assigned: parameter properties are not erasable syntax. */
  readonly capability: string;
  readonly caller: string;
  readonly requested: string;

  constructor(capability: string, caller: string, requested: string) {
    super(
      `${capability}: ${caller} did not declare "${requested}" in its manifest \`dependencies\`, so nothing was resolved. ` +
        'Reaching another extension is declared, not discovered (sketch §7c) — that is what makes it a reviewable fact ' +
        'rather than a string a caller invents at runtime. Add it to the manifest.',
    );
    this.name = 'UndeclaredDependencyError';
    this.capability = capability;
    this.caller = caller;
    this.requested = requested;
  }
}

/** Declared, and its API still cannot be handed over. */
export class ExtensionUnreachableError extends Error {
  readonly requested: string;
  readonly reason: 'not-hosted' | 'no-export';

  constructor(capability: string, requested: string, reason: 'not-hosted' | 'no-export') {
    super(
      `${capability}: ${
        reason === 'not-hosted'
          ? `no module for "${requested}" runs in this extension host. It is either absent from this build or ` +
            'running in another process — the child cannot tell those two apart, and either way its API is not ' +
            'reachable from here'
          : `"${requested}" is active but its activate() returned no API, so there is nothing to hand over`
      }. Deliberately not \`undefined\`, which already means "hosted here and not active".`,
    );
    this.name = 'ExtensionUnreachableError';
    this.requested = requested;
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
  /** Resolved by the host: the child cannot reach `node:os` (D1b). */
  readonly dataDir: string;
  /** Resolved by the host for the same reason. See `ExtensionContext.homeDir`. */
  readonly homeDir: string;
  /** Likewise, and see `ExtensionContext.userName` for what needs it. */
  readonly userName: string;
  readonly clock: Clock;
  readonly services: ExtHostServices;
  /** Whether developer surfaces are on. See `ExtensionContext.isDev`. */
  readonly isDev: boolean;
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
    dataDir: options.dataDir,
    homeDir: options.homeDir,
    userName: options.userName,
    secrets: createSecrets(),
    log,
    clock: options.clock,
    permissions: options.permissions,
    isDev: options.isDev,
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

    async invoke<R>(id: string, args?: unknown, opts?: InvokeOptions): Promise<Result<R, CommandError>> {
      const answer = await services.call({
        kind: 'command.invoke',
        commandId: id,
        args,
        // Stated, not inferred: both legs of this call derive their deadline from
        // it, and a log line on either side can name the same number.
        ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      });
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

/**
 * The env-injection seam an extension does NOT get, and why.
 *
 * `SessionHost.onWillCreate` is **synchronous**: `create` returns a `SessionID`
 * the layout needs in the same tick, so an async hook would make session creation
 * a promise and every caller a state machine. A port is asynchronous by
 * construction, so this callback cannot cross one — not "not yet", but not ever
 * in this shape.
 *
 * The correlation env it existed to inject (`SHEPHERD_SESSION_ID` and the socket
 * paths) is a kernel fact rather than a vendor one, so the kernel injects it into
 * every session and no extension has to ask.
 */
const SYNCHRONOUS_HOOK =
  'its callback is synchronous and the pty is spawned in the same tick, so it cannot cross a port. ' +
  'The correlation env it would inject (SHEPHERD_SESSION_ID, SHEPHERD_EVENTS_SOCK) is a kernel fact ' +
  'and the kernel injects it into every session already — there is nothing here for an extension to do.';

function createSessions(): SessionAPI {
  const refuse = (member: string): never => {
    throw new NotImplementedError(`sessions.${member}`, LANDS_IN('a later milestone'));
  };
  return {
    create: () => Promise.reject(new NotImplementedError('sessions.create', LANDS_IN('a later milestone'))),
    get: () => refuse('get'),
    // Reachable today through `commands.invoke('sessions.list')`, which is where
    // the child-side subset is served from; these object-returning shapes are not.
    list: () => refuse('list'),
    onWillCreate: () => {
      throw new NotImplementedError('sessions.onWillCreate', SYNCHRONOUS_HOOK);
    },
    onDidCreate: () => refuse('onDidCreate'),
    onDidExit: () => refuse('onDidExit'),
  };
}

/**
 * Contributed views — M3's first, and what retires main's relay allow-list.
 *
 * The provider stays HERE. A `TreeDataProvider` is functions, which a message
 * port cannot carry, so what crosses is a declaration; the host then asks for
 * children by `view.children` and this answers from the provider it kept. That
 * direction is deliberate: the host decides when to read, so a chatty extension
 * cannot flood the renderer, and the host never renders a snapshot it did not
 * request.
 *
 * `onDidChange` becomes a `view.changed` nudge — "there is something new to
 * ask for" — rather than a push of the data itself.
 */
function createViews(services: ExtHostServices, providers: Map<string, ViewProvider>): ViewAPI {
  return {
    registerViewType: (type, provider) => {
      if (provider.kind === 'panel') {
        throw new NotImplementedError(`views.registerViewType("${type}")`, LANDS_IN('a later milestone (panel views)'));
      }

      /**
       * A component contributes a NAME and keeps no provider here.
       *
       * Nothing in this process can render it — there is no DOM in a utility
       * process and `boundaries.js` denies react to it — so there is nothing to
       * hold and nothing to ask for. The renderer resolves the name against its
       * own table, which is also what stops an extension from naming a module
       * that does not exist and getting anything but an empty slot.
       */
      if (provider.kind === 'component') {
        services.tell(
          {
            kind: 'view.register',
            type,
            viewKind: 'component',
            component: provider.component,
            ...(provider.surface === undefined ? {} : { surface: provider.surface }),
            ...(provider.key === undefined ? {} : { key: provider.key }),
            ...(provider.title === undefined ? {} : { title: provider.title }),
            ...(provider.icon === undefined ? {} : { icon: provider.icon }),
          },
          `view.register ${type}`,
        );
        return toDisposable(() => {
          services.tell({ kind: 'view.unregister', type }, `view.unregister ${type}`);
        });
      }

      providers.set(type, provider);
      services.tell(
        {
          kind: 'view.register',
          type,
          viewKind: 'tree',
          ...(provider.title === undefined ? {} : { title: provider.title }),
        },
        `view.register ${type}`,
      );
      const changed = provider.data.onDidChange?.(() => {
        services.tell({ kind: 'view.changed', type }, `view.changed ${type}`);
      });
      return toDisposable(() => {
        changed?.dispose();
        providers.delete(type);
        services.tell({ kind: 'view.unregister', type }, `view.unregister ${type}`);
      });
    },
    registerStatusItem: () => {
      throw new NotImplementedError('views.registerStatusItem', LANDS_IN('a later milestone'));
    },
  };
}

// ------------------------------------------------------ what the process shares

export interface ExtensionWorldOptions {
  /**
   * Every extension id this process has a module for. It is the discriminator
   * behind `not-hosted`: an id outside this set cannot be resolved here whatever
   * its state elsewhere, and saying so beats a `false` that reads like knowledge.
   */
  readonly hosted: ReadonlySet<string>;
  /**
   * For the point registry. `info`, not `debug`: the line that must never be lost
   * is its warning about a provider registered into a disposed seam, and a define
   * or a register per activation is not worth the stderr.
   */
  readonly logger: Logger;
}

/**
 * The one address space every extension in this utility process shares — the
 * point registry and the table of exported APIs.
 *
 * Held by the runtime and handed to each extension's API object, so `agents-core`
 * defining a point and `claude-code` registering into it are two calls into the
 * same `PointRegistry` rather than two registries agreeing about nothing.
 */
export class ExtensionWorld {
  readonly #hosted: ReadonlySet<string>;
  readonly #logger: Logger;
  readonly #exports = new Map<string, { readonly api: unknown }>();
  #points: PointRegistry | undefined;

  constructor(options: ExtensionWorldOptions) {
    this.#hosted = options.hosted;
    this.#logger = options.logger;
  }

  /** Built on first use, so a process whose extensions define no point pays nothing. */
  points(): PointRegistry {
    this.#points ??= new PointRegistry({ logger: this.#logger });
    return this.#points;
  }

  hosts(id: string): boolean {
    return this.#hosted.has(id);
  }

  /**
   * What `id` returned from `activate`, wrapped — because the wrapper is present
   * for an extension that is active and exported nothing, and absent for one that
   * is not active, and those are different answers.
   */
  exportOf(id: string): { readonly api: unknown } | undefined {
    return this.#exports.get(id);
  }

  recordExport(id: string, api: unknown): void {
    this.#exports.set(id, { api });
  }

  /** Teardown: the extension is gone, so its export and its seams go with it. */
  forget(id: string): void {
    this.#exports.delete(id);
    this.#points?.disposeOwnedBy(id);
  }
}

/**
 * `points` and `extensions`, per calling extension.
 *
 * `id` is the host's word for who is asking (it comes off the `activate` ask, not
 * off anything the extension says), and `dependencies` is that extension's
 * declared manifest list. Both gates below read exactly those two.
 */
interface CallerOptions {
  readonly id: string;
  readonly dependencies: readonly string[];
  readonly world: ExtensionWorld;
  /** So a legitimate `undefined` can still say why — see `createPoints.get`. */
  readonly services: ExtHostServices;
}

/**
 * Points, for real — one registry shared by every extension in this process.
 *
 * That sharing is the substance of §7b rather than a shortcut: `registerAgentKind`
 * carries `detect` and a state machine, which are **functions**, and a function
 * cannot cross a message port. Putting every extension service in one utility
 * process is what makes an in-process registry the correct implementation instead
 * of a compromise.
 */
function createPoints(options: CallerOptions): PointsAPI {
  const { id, dependencies, world, services } = options;
  return {
    define<T>(pointId: string, opts?: { readonly order?: 'priority' | 'registration' }): ExtensionPoint<T> {
      // The owner is supplied here, never by the caller: an extension that could
      // name itself could name somebody else, and the gate below would be a claim
      // rather than a fact. A collision throws `DuplicatePointError` naming the
      // first owner — a second registry under one id would silently orphan every
      // provider the first owner's dependents registered.
      return world.points().define<T>(pointId, { ...opts, owner: id });
    },

    get<T>(pointId: string): ExtensionPoint<T> | undefined {
      const registry = world.points();
      const owner = registry.ownerOf(pointId);

      // The gate runs FIRST, matching `extensions.get` — and the order is the
      // point, not tidiness. Looking up before gating means the commonest real
      // mistake (forgetting the manifest `dependencies` entry, so the owner has
      // not been activated and the point does not exist yet) returns `undefined`
      // and reads as "nobody offers this seam". The author then debugs the seam
      // instead of the one line that is actually wrong.
      if (owner !== undefined && owner !== id && !dependencies.includes(owner)) {
        throw new UndeclaredDependencyError(`points.get("${pointId}")`, id, owner);
      }

      const point = registry.get<T>(pointId);
      if (point === undefined) {
        // `undefined` is the documented answer for "nobody defines this seam" and
        // for "its owner is not active", which the registry collapses by freeing
        // the id on dispose. It is legitimate — and it is still logged, because a
        // consumer silently taking its fallback path forever is indistinguishable
        // from one whose dependency failed to activate.
        services.log(
          'debug',
          `points.get("${pointId}") found no such point — either nothing defines it or its owner is not active`,
        );
        return undefined;
      }
      return point;
    },
  };
}

/**
 * Cross-extension APIs, for real — the sketch's §3 dependency arrows, made
 * callable.
 *
 * An extension's `activate` may return an object; the runtime records it, and
 * this resolves it for callers that declared the exporter. Three outcomes, kept
 * distinguishable on purpose (see the header): a typed refusal for undeclared, a
 * typed refusal for unreachable, and `undefined` for the one thing `undefined`
 * means — hosted here, not active.
 */
function createExtensions(options: CallerOptions): ExtensionsAPI {
  const { id, dependencies, world } = options;
  const declared = (capability: string, requested: string): void => {
    if (!dependencies.includes(requested)) throw new UndeclaredDependencyError(capability, id, requested);
  };
  return {
    get<T>(requested: string): T | undefined {
      const capability = `extensions.get("${requested}")`;
      declared(capability, requested);
      const record = world.exportOf(requested);
      if (record === undefined) {
        if (!world.hosts(requested)) throw new ExtensionUnreachableError(capability, requested, 'not-hosted');
        return undefined;
      }
      if (record.api === undefined) throw new ExtensionUnreachableError(capability, requested, 'no-export');
      return record.api as T;
    },

    isActive(requested: string): boolean {
      const capability = `extensions.isActive("${requested}")`;
      declared(capability, requested);
      // `false` would be a guess about a process we cannot see, and a guess that
      // reads exactly like a fact is worse than a refusal.
      if (!world.hosts(requested)) throw new ExtensionUnreachableError(capability, requested, 'not-hosted');
      return world.exportOf(requested) !== undefined;
    },
  };
}

/**
 * Running a program, from a process that is forbidden to spawn one.
 *
 * `boundaries.js` denies `child_process` here and in `extensions/**`, and points
 * OS APIs at `packages/platform/darwin` — so this is a proxy, and the runner is
 * over the port in main. That is the boundary working: an extension asking the
 * host to run something is reviewable, gated and testable; an extension calling
 * `spawn` is none of those.
 *
 * Three things are decided on this side rather than the host's:
 *
 *   - **`signal`** never crosses. An `AbortSignal` is not clonable, so it is
 *     honoured here: an already-aborted call fails without sending anything.
 *     (Aborting a call already in flight is not yet expressible — there is no
 *     cancel frame — and failing fast on the common case is better than pretending.)
 *   - **`gitRead`/`gitWrite` collapse into one frame with a `mode`**, so the
 *     read/write distinction survives the crossing as data. The host applies
 *     `GIT_OPTIONAL_LOCKS=0` to a read and merges the environment for a write;
 *     a child that had to remember to ask for those would eventually not.
 *   - **A transport failure is an `ExecErr`, not a throw.** The declared API
 *     returns `ExecOk | ExecErr` and a caller that has to catch as well as branch
 *     will do one of the two badly. `code: -1` marks "never ran".
 */
function createProcess(services: ExtHostServices): ProcessAPI {
  const answer = async (call: ApiCall, opts: ExecOptions, what: string): Promise<ExecOk | ExecErr> => {
    if (opts.signal?.aborted === true) {
      return { ok: false, code: -1, stdout: '', stderr: `${what} was aborted before it started` };
    }
    const result = await services.call(call);
    if (result.ok) return result.value as ExecOk | ExecErr;
    return { ok: false, code: -1, stdout: '', stderr: `${what}: ${result.error.message}` };
  };

  const wire = (opts: ExecOptions) => ({
    cwd: opts.cwd,
    ...(opts.env === undefined ? {} : { env: opts.env }),
    ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
    timeoutMs: opts.timeoutMs,
  });

  return {
    exec: (cmd, opts) => answer({ kind: 'process.exec', cmd: [...cmd], opts: wire(opts) }, opts, cmd[0] ?? 'exec'),
    gitRead: (args, opts) =>
      answer({ kind: 'process.git', mode: 'read', args: [...args], opts: wire(opts) }, opts, 'git'),
    gitWrite: (args, opts) =>
      answer({ kind: 'process.git', mode: 'write', args: [...args], opts: wire(opts) }, opts, 'git'),
  };
}

export interface ShepherdOptions {
  /**
   * Where this extension's tree providers live, so the runtime can answer a
   * `view.children` ask. Owned by the runtime rather than this factory: the ask
   * arrives on a frame, not through the API object.
   */
  readonly viewProviders: Map<string, ViewProvider>;
  readonly apiVersion: string;
  /**
   * Whether `api.proposed` is assembled at all — the host's decision, per §7:
   * always for a `builtin`, and for a `user` extension only in a dev build. False
   * here means the object exists but every group refuses, so an extension that
   * ignored the refusal at activation still cannot reach anything.
   */
  readonly proposed: boolean;
  readonly services: ExtHostServices;
  /** Whose API object this is — the host's word, from the `activate` ask. */
  readonly id: string;
  /** That extension's declared `dependencies`, the only ids it may reach. */
  readonly dependencies: readonly string[];
  readonly world: ExtensionWorld;
}

export function createShepherd(options: ShepherdOptions): Shepherd {
  const { services, id, dependencies, world } = options;
  const gated = <T extends object>(group: string, build: () => T): T =>
    options.proposed ? build() : (refuseGroup(group) as T);
  const caller: CallerOptions = { id, dependencies, world, services };

  const proposed: ProposedAPI = {
    commands: gated('commands', () => createCommands(services)),
    events: gated('events', () => createEvents(services)),
    sessions: createSessions(),
    layout: createLayout(),
    views: gated('views', () => createViews(services, options.viewProviders)),
    attention: gated('attention', () => createAttention(services)),
    points: gated('points', () => createPoints(caller)),
    extensions: gated('extensions', () => createExtensions(caller)),
    // Gated like every other group on whether `proposed` is assembled at all;
    // the `process.exec` PERMISSION is enforced host-side by the one authorizer,
    // not re-checked here (a judgement made in two places is one two places can
    // disagree about).
    process: gated('process', () => createProcess(services)),
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
