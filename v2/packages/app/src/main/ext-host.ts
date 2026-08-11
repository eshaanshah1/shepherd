import { randomUUID } from 'node:crypto';
import {
  DuplicateCommandError,
  authorize,
  type CommandRegistry,
  type EventBus,
  type ExtensionRegistry,
  type GrantSet,
  type PermissionStore,
  type SettingsRegistry,
} from '@shepherd/core';
import {
  CORE_NAMESPACE,
  extensionId,
  isPermission,
  namespaceOf,
  type Permission,
  s,
  err,
  ok,
  type Caller,
  type Clock,
  type Disposable,
  type ExtensionID,
  type ExtensionSource,
  type KV,
  type Logger,
  type Manifest,
  type Result,
} from '@shepherd/sdk';
import {
  HOST_API_VERSION,
  childFrameSchema,
  frameIds,
  negotiate,
  readFrames,
  wireErr,
  wireOk,
  type ApiCall,
  type ChildFrame,
  type HostAsk,
  type HostFrame,
  type WireResult,
} from '../shared/ext-protocol.ts';
import { extensionDataDir } from './ext-data-dir.ts';


/**
 * The main-process half of the extension host.
 *
 * It owns one utility process, hands `ExtensionRegistry` its `Activator`, and
 * serves the child's API calls by dispatching into the **real** kernel that
 * `main/index.ts` already built. Deliberately electron-free — the `utilityProcess`
 * fork lives in `ext-host-process.ts` behind `ExtChildProcess` — so every decision
 * below is driven by a test rather than by a screenshot.
 *
 * Five things it is responsible for, each of which is a failure it prevents:
 *
 *   - **The caller is derived, never declared.** When the host asks the child to
 *     activate an extension it mints an opaque `handle` and remembers which
 *     extension it belongs to. Every later frame carries that handle and nothing
 *     else identifying, so `caller: {kind:'extension', id}` is the host's own
 *     bookkeeping. An unknown handle dispatches nothing. This is v1's
 *     `tab_id`-holding-a-pane-id lesson applied before the lie can be told.
 *   - **There is exactly one authorizer.** Commands go through
 *     `CommandRegistry.invoke`, whose dispatcher authorizes before any handler
 *     runs — which is also how attention and layout are reached, because both are
 *     already commands. The two groups that are not commands (`events`,
 *     `storage`) call core's own pure `authorize` with the same `GrantSet`. One
 *     function, four call sites, no second path.
 *   - **A dead host says so** (M1 plan, module 8). The exit code is logged, there
 *     is exactly ONE restart, every proxy command is torn down so nothing
 *     forwards into a corpse, and the extensions that were running are put back
 *     through `ExtensionRegistry` — which either re-activates them or records
 *     them `failed` with the reason. Silently absent is the one outcome that is
 *     not available.
 *   - **Nothing waits forever.** Every host→child ask has a `Clock` deadline, so
 *     a wedged `activate()` fails with a reason instead of hanging the startup
 *     path that awaits it.
 *   - **The `proposed` gate.** A `builtin` always gets `api.proposed` (§7 requires
 *     built-ins to consume it — that requirement is the proving ground); a `user`
 *     extension gets it only in a dev build, and in a production build its
 *     activation is refused with a reason rather than being handed an API object
 *     whose every member throws.
 */

/**
 * One deadline for every host→child ask, handshake included.
 *
 * Generous, because the thing on the other side is running somebody's
 * `activate()`, and short enough that a wedged extension does not hold the app's
 * startup path. One number rather than three: a per-verb table would be three
 * numbers nobody can justify individually.
 */
export const ASK_TIMEOUT_MS = 10_000;

/**
 * Added to a stated deadline, for the reason ADR 0030 gives in the other
 * direction: equal deadlines make the transport give up at the instant the work
 * is legitimately finishing, so a call that succeeded is reported as a timeout.
 */
export const ASK_DEADLINE_SLACK_MS = 5_000;

/**
 * How many times a crashed host is restarted. **One.**
 *
 * A host that dies twice is dying because of something a third fork will not fix
 * — a bad built-in, an OOM, a broken build — and an unbounded restart loop turns
 * that into a spinning fork bomb with a log nobody can read. After this, the
 * extensions are marked `failed` and stay that way until the app is relaunched.
 */
export const MAX_HOST_RESTARTS = 1;

/** The KV namespace an extension's `ctx.storage` is served from. */
export const storageNamespace = (id: string): string => `extension:${id}`;

/** Registered by the host; how an extension (and later a CLI) reads the host's facts. */
export const EXTENSIONS_LIST_COMMAND = 'extensions.list';

/**
 * The child, as this file needs it. `ext-host-process.ts` implements it over
 * `utilityProcess.fork` + `MessageChannelMain`; a test implements it over two
 * arrays.
 */
export interface ExtChildProcess {
  post(frame: HostFrame): void;
  /** Raw, because what arrives is untrusted until `readFrames` has read it. */
  onFrame(fn: (raw: unknown) => void): void;
  onExit(fn: (code: number) => void): void;
  kill(): void;
}

/** What `process.*` carries across the port — `ExecOptions` minus its `AbortSignal`. */
export interface ExecRunOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs: number;
}

export interface ExtensionHostOptions {
  readonly registry: CommandRegistry;
  /**
   * A getter, not a value: the registry is constructed *with* this host's
   * activator, so one of the two has to be resolved late. A getter makes that
   * explicit rather than leaving a mutable field somebody can forget to set.
   */
  readonly extensions: () => ExtensionRegistry;
  readonly permissions: PermissionStore;
  readonly bus: EventBus;
  /** `SqliteStore.namespace`. One namespace per extension, never re-derived. */
  readonly kv: (namespace: string) => KV;
  /**
   * Where a manifest's `contributes.settings` lands, and where the seed comes
   * from.
   *
   * Optional so a test can omit it — and its absence means an extension is seeded
   * with an empty settings map, which is honest for a manifest that declares
   * none. A manifest that DOES declare pages with no registry here is refused,
   * rather than activated with settings that silently go nowhere.
   */
  readonly settings?: SettingsRegistry;
  /**
   * The app's support directory — where each extension's own data dir hangs off
   * (D1b). Passed in rather than resolved here: `packages/app/src/main` may
   * import the platform package, but the path is a boot-time fact and this class
   * should not re-derive one.
   */
  readonly support: string;
  /**
   * The user's home directory, for the same reason `support` is passed in: a
   * boot-time fact resolved once at the platform boundary, not re-derived here.
   * It reaches an extension as `ctx.homeDir`.
   */
  readonly homeDir: string;
  /**
   * The account name the app runs as, resolved at the platform boundary for the
   * same reason `homeDir` is. It reaches an extension as `ctx.userName`, and what
   * needs it is `ProcessAPI.exec` replacing rather than merging a child's
   * environment — see `ExtensionContext.userName`.
   */
  readonly userName: string;
  /** Where contributed views are recorded. Optional so a test can omit it. */
  readonly views?: {
    register(
      extension: string,
      type: string,
      kind: 'tree' | 'component',
      component?: string,
      declaration?: { surface?: 'dock' | 'overlay'; key?: string; title?: string },
    ): void;
    unregister(type: string): void;
    changed(type: string): void;
    forget(extension: string): void;
  };
  /**
   * How a program gets run, injected from `packages/platform/darwin`.
   *
   * Injected for the same reason the pty spawn is: `child_process` lives behind
   * the platform boundary, and a test that a denial denies must not need a real
   * subprocess. Optional so a test can omit it — and its absence is a refusal
   * with a reason, not a quiet success.
   */
  readonly run?: {
    exec(cmd: readonly string[], opts: ExecRunOptions): Promise<unknown>;
    git(mode: 'read' | 'write', args: readonly string[], opts: ExecRunOptions): Promise<unknown>;
  };
  readonly logger: Logger;
  readonly clock: Clock;
  /**
   * Which build this is. Passed in rather than imported from `build-flags.ts`:
   * a textual substitution cannot be varied by a test, and the thing it gates
   * here is whether a third-party extension runs at all.
   */
  readonly isDev: boolean;
  /**
   * Whether extensions may contribute developer-facing surfaces — what an
   * extension reads as `ctx.isDev`.
   *
   * Deliberately NOT `isDev`. The dev build is the app being dogfooded every
   * day, and a sidebar full of instruments for the app's own internals is what
   * makes it read as its own test harness. A smoke turns this on (it drives the
   * production bundle and asserts on those contributions), and so does
   * `--shepherd-dev-views`.
   */
  readonly devSurfaces?: boolean;
  readonly spawn: () => ExtChildProcess;
  /** Injectable so a test's handles are readable; production uses a UUID. */
  /**
   * The child is gone and is not coming back in this state.
   *
   * There is deliberately no general state-change event: the only transition
   * anything outside needs to act on is "stop believing what the extensions told
   * you", and a callback for exactly that cannot be subscribed to for the wrong
   * reason. Fires for a clean shutdown and for an exhausted restart budget — in
   * both cases every fact an extension published is now unowned.
   */
  readonly onHostGone?: (reason: string) => void;
  readonly mintHandle?: () => string;
  readonly apiVersion?: string;
}

interface HostedExtension {
  readonly id: ExtensionID;
  readonly handle: string;
  readonly source: ExtensionSource;
  /** Proxy registrations in the REAL registry, so they can all be torn down. */
  readonly commands: Map<string, Disposable>;
  /** Bus subscriptions this extension asked for, keyed by its own subscription id. */
  readonly subscriptions: Map<string, Disposable>;
  /**
   * Its contributed settings pages, so a teardown takes them with it.
   *
   * Held here rather than left to the registry's own bookkeeping because the
   * pages are contributed from the MANIFEST, before `activate` — so a rollback
   * has to undo something the extension never did itself.
   */
  settings?: Disposable;
  active: boolean;
}

type HostState = 'stopped' | 'starting' | 'ready' | 'refused' | 'exhausted';

export class ExtensionHost {
  readonly #options: ExtensionHostOptions;
  readonly #log;
  readonly #apiVersion: string;
  readonly #mintHandle: () => string;
  readonly #nextId = frameIds('host');
  readonly #pending = new Map<string, (result: WireResult) => void>();
  readonly #byHandle = new Map<string, HostedExtension>();
  readonly #byId = new Map<string, HostedExtension>();
  /** In-flight activations, so a crash reconcile can wait for them to settle. */
  readonly #activations = new Map<string, Promise<Result<void, string>>>();
  #child: ExtChildProcess | undefined;
  #state: HostState = 'stopped';
  #ready: Promise<Result<void, string>> | undefined;
  #settleReady: ((result: Result<void, string>) => void) | undefined;
  #childPid = 0;
  #restarts = 0;
  #disposed = false;

  constructor(options: ExtensionHostOptions) {
    this.#options = options;
    this.#log = options.logger.child('extension');
    this.#apiVersion = options.apiVersion ?? HOST_API_VERSION;
    this.#mintHandle = options.mintHandle ?? randomUUID;
  }

  /** The pid of the process extensions are running in. `0` until it has said hello. */
  get childPid(): number {
    return this.#childPid;
  }

  get state(): HostState {
    return this.#state;
  }

  /**
   * What `ExtensionRegistry` calls. Bound as a property so it can be handed over
   * as a value without anybody remembering to bind `this`.
   */
  readonly activator = (manifest: Manifest): Promise<Result<void, string>> => {
    const running = this.#activate(manifest);
    this.#activations.set(manifest.id, running);
    void running.finally(() => void this.#activations.delete(manifest.id));
    return running;
  };

  /**
   * `extensions.list` — the host's own facts, as a command.
   *
   * A command rather than a bespoke API member, so it is reachable from
   * everywhere the one verb table is: an extension, `shepherd`, a paired device.
   * `childPid` is in it because that field is the only part of the answer a
   * healthy-looking main process cannot fabricate.
   */
  registerCommands(): Disposable {
    return this.#options.registry.register(EXTENSIONS_LIST_COMMAND, {
      title: 'List Extensions',
      schema: s.nothing(),
      handler: () => {
        const records = this.#options.extensions().list();
        return {
          extensions: records.length,
          commands: this.#options.registry.list().length,
          childPid: this.#childPid,
          hostState: this.#state,
          records: records.map((record) => ({
            id: record.manifest.id,
            version: record.manifest.version,
            source: record.source,
            state: record.state,
            ...(record.reason === undefined ? {} : { reason: record.reason }),
          })),
        };
      },
    });
  }

  /**
   * Tear the child down for good.
   *
   * `#disposed` first, and that ordering is the feature: without it the `exit`
   * listener treats a deliberate kill as a crash, logs an error, spends the one
   * restart, and marks every extension `failed` — during quit.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#failPending('the extension host is shutting down');
    for (const record of [...this.#byId.values()]) this.#forget(record);
    this.#child?.kill();
    this.#child = undefined;
    this.#state = 'stopped';
    this.#log.info('extension host stopped');
  }

  // ------------------------------------------------------------------ activation

  async #activate(manifest: Manifest): Promise<Result<void, string>> {
    if (this.#disposed) return err('the extension host is shutting down');
    const id = extensionId(manifest.id);
    const source = this.#sourceOf(manifest.id);
    if (source === undefined) {
      // Only reachable if something activated a manifest the registry never
      // recorded, which would mean two sources of truth about what is installed.
      return err(`${id} is not recorded in the extension registry; refusing to activate it`);
    }

    // The §7 gate. A refusal, not a degraded API: handing a `user` extension an
    // object whose every member throws would make the failure show up wherever it
    // happened to call first, with no line saying the build was the reason.
    const proposed = source === 'builtin' || this.#options.isDev;
    if (!proposed) {
      const reason =
        `${id} is a user extension and every M1 API is proposed, ` +
        'which a third-party extension may only touch in a dev build (sketch §7)';
      this.#log.warn(reason);
      return err(reason);
    }

    const ready = await this.#ensureReady();
    if (!ready.ok) return err(`${id} cannot activate: ${ready.error}`);

    const handle = this.#mintHandle();
    const record: HostedExtension = {
      id,
      handle,
      source,
      commands: new Map(),
      subscriptions: new Map(),
      active: false,
    };
    // Registered BEFORE the ask, because the child starts calling back the moment
    // `activate()` runs and every one of those frames resolves through this table.
    this.#byHandle.set(handle, record);
    this.#byId.set(id, record);

    /**
     * Settings pages come off the MANIFEST, before `activate` runs — that is what
     * makes the settings screen readable with nothing activated (`Manifest`'s own
     * comment says why).
     *
     * A bad page refuses the activation and names the extension: half a page
     * drawn is worse than a page refused, because the missing rows read as a
     * missing feature rather than as the manifest error they are.
     */
    const pages = manifest.contributes?.settings ?? [];
    if (pages.length > 0) {
      const settings = this.#options.settings;
      if (settings === undefined) {
        this.#forget(record);
        return err(
          `${id} declares contributes.settings and this host has no settings registry, ` +
            'so its pages would go nowhere. Refusing rather than activating an extension whose settings do not exist.',
        );
      }
      try {
        record.settings = settings.contribute(manifest.id, pages);
      } catch (error) {
        this.#forget(record);
        return err(`${id} has an invalid settings contribution: ${messageOf(error)}`);
      }
    }

    const answer = await this.#ask({
      kind: 'activate',
      extension: id,
      handle,
      manifest: wireManifest(manifest),
      source,
      proposed,
      apiVersion: this.#apiVersion,
      // What the user actually GRANTED, not what the manifest asked for. The two
      // differ for a `user` extension whose update added a capability, and the
      // extension's own `ctx.permissions` must describe the former.
      permissions: [...this.#options.permissions.granted(id)],
      storage: this.#snapshotStorage(id),
      settings: this.#seedSettings(manifest.id),
      // Resolved here because the child cannot: it may not reach `node:os`
      // (D1b). Every hosted id is passed so the name can fall back to the full
      // id when two extensions want the same last segment.
      // NOT `isDev`: see `devSurfaces` — a dev build is the app being dogfooded,
      // and its sidebar should look like the product.
      isDev: this.#options.devSurfaces === true,
      dataDir: extensionDataDir(id, this.#options.extensions().list().map((record) => record.manifest.id), this.#options.support),
      homeDir: this.#options.homeDir,
      userName: this.#options.userName,
    });

    if (!answer.ok) {
      // Whatever it managed to register on the way to failing goes with it.
      this.#forget(record);
      return err(answer.error.message);
    }
    record.active = true;
    this.#log.info(`${id} activated in the extension host (pid ${this.#childPid})`);
    return ok(undefined);
  }

  #sourceOf(id: string): ExtensionSource | undefined {
    return this.#options.extensions().list().find((record) => record.manifest.id === id)?.source;
  }

  /** An extension's whole namespace, for the child's write-through mirror. */
  #snapshotStorage(id: ExtensionID): Record<string, unknown> {
    const kv = this.#options.kv(storageNamespace(id));
    const out: Record<string, unknown> = {};
    // `s.unknown()` because the READER owns the schema (core's `NamespacedKV` says
    // why) and the reader here is the extension, one process along.
    for (const key of kv.keys()) out[key] = kv.get(key, s.unknown());
    return out;
  }

  /**
   * The settings an extension may see: its own namespace, plus the kernel's.
   *
   * Two calls rather than one merged read, because the second is a different
   * fact — `shepherd.*` is readable by everybody and writable by nobody but the
   * user, and an extension reading the theme is not an extension reading its
   * neighbour's configuration (D11).
   */
  #seedSettings(manifestId: string): Record<string, unknown> {
    const settings = this.#options.settings;
    if (settings === undefined) return {};
    return { ...settings.values(namespaceOf(manifestId)), ...settings.values(CORE_NAMESPACE) };
  }

  // ------------------------------------------------------------------ the process

  #ensureReady(): Promise<Result<void, string>> {
    if (this.#disposed) return Promise.resolve(err('the extension host is shutting down'));
    if (this.#state === 'ready') return Promise.resolve(ok(undefined));
    if (this.#state === 'refused') {
      // Never retried: a protocol mismatch is a build-skew fact, and a second
      // fork of the same binary announces the same version.
      return Promise.resolve(err('the extension host announced a protocol this build refuses'));
    }
    if (this.#state === 'exhausted') {
      return Promise.resolve(
        err(`the extension host has crashed and its ${MAX_HOST_RESTARTS} restart is spent; not forking another`),
      );
    }
    if (this.#ready !== undefined) return this.#ready;

    this.#state = 'starting';
    let cancelTimer = (): void => {};
    const attempt = new Promise<Result<void, string>>((resolve) => {
      let settled = false;
      const settle = (result: Result<void, string>): void => {
        if (settled) return;
        settled = true;
        cancelTimer();
        resolve(result);
      };
      this.#settleReady = settle;
      // The same deadline as every ask, covering the one case a per-request
      // timeout cannot: a child that starts and never says hello at all.
      const timer = this.#options.clock.setTimeout(() => {
        this.#log.error(`the extension host did not say hello within ${ASK_TIMEOUT_MS}ms`);
        // Killed, not abandoned: a silent child left running is memory held by a
        // process answering nobody, and the next attempt would fork a second one.
        this.#child?.kill();
        this.#child = undefined;
        settle(err(`no hello from the extension host within ${ASK_TIMEOUT_MS}ms`));
      }, ASK_TIMEOUT_MS);
      cancelTimer = () => timer.dispose();

      try {
        const child = this.#options.spawn();
        this.#child = child;
        child.onFrame((raw) => this.#onFrame(raw));
        child.onExit((code) => this.#onExit(code));
        this.#log.info('forked the extension host');
      } catch (error) {
        const reason = `could not fork the extension host: ${messageOf(error)}`;
        this.#log.error(reason);
        settle(err(reason));
      }
    });
    this.#ready = attempt;
    // A FAILED handshake is not cached: the next activation should get a fresh
    // attempt rather than an instant replay of this one's error. `#state` is what
    // says when there must not be a next attempt (`refused`, `exhausted`).
    void attempt.then((result) => {
      if (result.ok) return;
      this.#ready = undefined;
      this.#settleReady = undefined;
      if (this.#state === 'starting') this.#state = 'stopped';
    });
    return attempt;
  }

  /**
   * The child is gone.
   *
   * Order matters: say so, stop anything that could still reach into it, then put
   * the extensions back through the registry. The registry's own answer decides
   * whether they come back `active` or land `failed` — there is no third path in
   * which they are quietly absent, which is the whole point (review §Bad-5).
   */
  #onExit(code: number): void {
    if (this.#disposed) {
      this.#log.info(`extension host exited with code ${code} during shutdown`);
      return;
    }
    this.#child = undefined;
    this.#ready = undefined;
    this.#settleReady?.(err(`the extension host exited with code ${code}`));
    this.#settleReady = undefined;
    this.#failPending(`the extension host exited with code ${code}`);

    const wasActive = [...this.#byId.values()].filter((record) => record.active).map((record) => record.id);
    // Every proxy command goes NOW. A registered command that forwards into a
    // dead process is `acceptBridged` reborn: it answers, it looks wired, and
    // nothing happens.
    for (const record of [...this.#byId.values()]) this.#forget(record);

    /**
     * **Code 0 is not a crash.**
     *
     * The child's entry never returns — it parks on a message port — so it cannot
     * exit cleanly of its own accord. A zero therefore means something outside
     * killed it: either we did (handled above, by the `#disposed` flag) or the
     * parent is going away and took the process tree with it. `app.exit()` is that
     * second case, and it emits neither `before-quit` nor `will-quit`, so no
     * teardown hook can get ahead of it: shipped without this branch, every
     * `app.exit` forked a replacement extension host on the way out the door, and
     * `smoke:m1` printed the restart after it had already reported OK.
     *
     * So: say it, stop claiming the extensions are running, and do not fork. The
     * registry lands them back on `installed`, which is the truth — installed,
     * not running — and the line above says why. That is the difference between
     * this and being silently absent.
     */
    if (code === 0) {
      this.#state = 'stopped';
      this.#log.warn(
        `extension host exited cleanly (code 0) without being asked to — treating it as a shutdown, not a crash` +
          `${wasActive.length === 0 ? '' : `; no longer running: ${wasActive.join(', ')}`}`,
      );
      const registry = this.#options.extensions();
      for (const id of wasActive) if (registry.state(id) === 'active') registry.deactivate(id);
      this.#options.onHostGone?.(`the extension host exited cleanly (code ${code})`);
      return;
    }

    this.#log.error(`extension host exited with code ${code}`);

    if (this.#restarts >= MAX_HOST_RESTARTS) {
      this.#state = 'exhausted';
      this.#log.error(
        `not forking another extension host (${this.#restarts} restart already spent) — ` +
          `${wasActive.length === 0 ? 'nothing was active' : `marking ${wasActive.join(', ')} failed`}`,
      );
      this.#options.onHostGone?.(`the extension host crashed and its restart budget is spent`);
    } else {
      this.#restarts += 1;
      this.#state = 'stopped';
      this.#log.warn(`restarting the extension host (attempt ${this.#restarts} of ${MAX_HOST_RESTARTS})`);
    }
    void this.#reconcile(wasActive);
  }

  /**
   * Put every extension that was running back through `ExtensionRegistry`.
   *
   * This is the one path, whether the host is about to be restarted or is out of
   * restarts, because the outcome is decided by `#ensureReady` rather than by a
   * second copy of that judgement here: a live host re-activates them, a spent
   * one makes the activator return `err`, and the registry marks them `failed`
   * with that reason on its record. Marking `failed` "through the registry" is
   * exactly this — the registry owns the state, and nothing reaches around it.
   */
  async #reconcile(ids: readonly ExtensionID[]): Promise<void> {
    // In-flight activations first. Their `await this.#activator(...)` continuation
    // was attached before ours, so by the time this resumes the registry has
    // already recorded each failure and no entry is still `activating` — which is
    // what `deactivate` refuses to touch.
    await Promise.allSettled([...this.#activations.values()]);
    if (this.#disposed || ids.length === 0) return;

    const registry = this.#options.extensions();
    for (const id of ids) {
      if (registry.state(id) === 'active') registry.deactivate(id);
      const result = await registry.activate(id);
      if (result.ok) this.#log.info(`${id} came back after the extension host restarted`);
      // A failure is already logged by the registry, with the reason on its record.
    }
  }

  #failPending(reason: string): void {
    for (const [id, settle] of [...this.#pending]) {
      this.#pending.delete(id);
      settle(wireErr('unavailable', reason));
    }
  }

  /** Drops every trace of an extension from this host. Idempotent. */
  #forget(record: HostedExtension): void {
    this.#options.views?.forget(record.id);
    record.settings?.dispose();
    record.settings = undefined;
    for (const registration of record.commands.values()) registration.dispose();
    record.commands.clear();
    for (const subscription of record.subscriptions.values()) subscription.dispose();
    record.subscriptions.clear();
    record.active = false;
    this.#byHandle.delete(record.handle);
    this.#byId.delete(record.id);
  }

  // -------------------------------------------------------------------- the frames

  #post(frame: HostFrame): void {
    const child = this.#child;
    if (child === undefined) {
      this.#log.warn(`dropping a ${frame.kind} frame: there is no extension host to send it to`);
      return;
    }
    child.post(frame);
  }

  #onFrame(raw: unknown): void {
    const read = readFrames(raw, childFrameSchema);
    for (const reason of read.skipped) {
      // Skipped, not fatal. A frame from a newer child must not cost the frames
      // beside it, and must not be silent either.
      this.#log.warn(`skipped an unreadable frame from the extension host: ${reason}`);
    }
    for (const frame of read.frames) void this.#handle(frame);
  }

  async #handle(frame: ChildFrame): Promise<void> {
    switch (frame.kind) {
      case 'hello': {
        if (this.#state === 'ready') {
          this.#log.warn('the extension host said hello twice; ignoring the second');
          return;
        }
        const verdict = negotiate(frame.protocol);
        if (!verdict.ok) {
          this.#state = 'refused';
          this.#log.error(verdict.error);
          this.#post({ kind: 'hello-refused', id: frame.id, reason: verdict.error });
          this.#settleReady?.(err(verdict.error));
          this.#settleReady = undefined;
          // Killed rather than left running: a child speaking a protocol we refuse
          // is a process holding memory and answering nobody.
          this.#child?.kill();
          this.#child = undefined;
          return;
        }
        this.#childPid = frame.childPid;
        this.#state = 'ready';
        this.#post({ kind: 'hello-ok', id: frame.id, protocol: verdict.value, apiVersion: this.#apiVersion });
        this.#log.info(`extension host ready: pid ${frame.childPid}, protocol ${verdict.value}`);
        this.#settleReady?.(ok(undefined));
        this.#settleReady = undefined;
        return;
      }
      case 'call': {
        const result = await this.#serve(frame.handle, frame.call);
        this.#post({ kind: 'result', id: frame.id, result });
        return;
      }
      case 'answer': {
        const settle = this.#pending.get(frame.id);
        if (settle === undefined) {
          // A late answer after a timeout. Logged rather than thrown: a frame off a
          // process boundary must never be able to take main down.
          this.#log.warn(`the extension host answered ${frame.id}, which nothing is waiting for`);
          return;
        }
        this.#pending.delete(frame.id);
        settle(frame.result);
        return;
      }
    }
  }

  /**
   * Read a contributed tree from the extension that owns it.
   *
   * Public because `ViewRegistry` holds ownership and this holds the port; the
   * two halves meet at `main/index.ts` rather than either importing the other.
   */
  async readTree(extension: string, type: string, parent: string | undefined): Promise<unknown> {
    const answer = await this.#ask({
      kind: 'view.children',
      extension,
      type,
      ...(parent === undefined ? {} : { parent }),
    });
    return answer.ok ? answer.value : [];
  }

  /**
   * `deadlineMs` is the CALLER's, and defaulting it is what the constant is for.
   *
   * The flat 10s was the whole of it, and it is shorter than things the app
   * legitimately runs through a command: `agents.complete` asks a model, which is
   * 10–16s of network, so every naming call over 10s came back to its caller as
   * `timeout` while the child was still working — and then the answer arrived and
   * was dropped. ADR 0030 settled this for child→host calls; this is the same
   * decision in the direction it was not applied to.
   */
  #ask(ask: HostAsk, deadlineMs: number = ASK_TIMEOUT_MS): Promise<WireResult> {
    if (this.#child === undefined) {
      return Promise.resolve(wireErr('unavailable', `there is no extension host to ask (${ask.kind})`));
    }
    return new Promise<WireResult>((resolve) => {
      const id = this.#nextId();
      const timer = this.#options.clock.setTimeout(() => {
        // The delete IS the double-settle guard: a late answer then finds no
        // entry, takes the "nothing is waiting for it" branch, and logs.
        if (!this.#pending.delete(id)) return;
        this.#log.error(`the extension host did not answer ${ask.kind} within ${deadlineMs}ms`);
        resolve(wireErr('timeout', `the extension host did not answer ${ask.kind} within ${deadlineMs}ms`));
      }, deadlineMs);
      this.#pending.set(id, (result) => {
        timer.dispose();
        resolve(result);
      });
      this.#post({ kind: 'ask', id, ask });
    });
  }

  // --------------------------------------------------------------- serving a call

  /**
   * A child→host call, served against the real kernel.
   *
   * **The first two lines are the security model.** The frame carries a `handle`
   * and nothing else identifying; the handle resolves to the extension the host
   * itself asked to activate; the caller is built from that. Nothing anywhere
   * below reads an identity off the frame, so there is no field an extension
   * could set to become another one.
   */
  async #serve(handle: string, call: ApiCall): Promise<WireResult> {
    const record = this.#byHandle.get(handle);
    if (record === undefined) {
      this.#log.warn(`refusing ${call.kind}: handle ${handle} names no live extension`);
      return wireErr('unknown-handle', `${call.kind} arrived on a handle that names no live extension`);
    }
    const caller: Caller = { kind: 'extension', id: record.id };

    switch (call.kind) {
      case 'log': {
        this.#log[call.level](call.message);
        return wireOk();
      }

      case 'command.register':
        return this.#registerProxy(record, call);

      case 'command.unregister': {
        const registration = record.commands.get(call.commandId);
        if (registration === undefined) {
          return wireErr('unknown-command', `${record.id} has not registered "${call.commandId}"`);
        }
        registration.dispose();
        record.commands.delete(call.commandId);
        return wireOk();
      }

      case 'command.invoke': {
        // The one verb table, with the derived caller — so the dispatcher's
        // authorizer decides, exactly as it does for a keystroke or the CLI.
        const result = await this.#options.registry.invoke(
          call.commandId,
          call.args,
          caller,
          call.timeoutMs === undefined ? undefined : { timeoutMs: call.timeoutMs },
        );
        return result.ok ? wireOk(result.value) : wireErr(result.error.code, result.error.message);
      }

      case 'event.emit': {
        const verdict = this.#membership(caller);
        if (verdict !== undefined) return verdict;
        this.#options.bus.emit(call.topic, call.payload, caller);
        return wireOk();
      }

      case 'event.on': {
        const verdict = this.#membership(caller);
        if (verdict !== undefined) return verdict;
        const existing = record.subscriptions.get(call.subscription);
        // The child mints these; a repeat means its own table has gone wrong, and
        // leaking the previous subscription would double-deliver forever.
        if (existing !== undefined) existing.dispose();
        record.subscriptions.set(
          call.subscription,
          this.#options.bus.on(call.topic, (payload, envelope) =>
            this.#post({
              kind: 'event',
              subscription: call.subscription,
              topic: call.topic,
              payload,
              seq: envelope.seq,
              ts: envelope.ts,
              source: envelope.source,
            }),
          ),
        );
        return wireOk();
      }

      case 'event.off': {
        const subscription = record.subscriptions.get(call.subscription);
        if (subscription === undefined) {
          return wireErr('unknown-handle', `${record.id} holds no subscription ${call.subscription}`);
        }
        subscription.dispose();
        record.subscriptions.delete(call.subscription);
        return wireOk();
      }

      case 'storage.set': {
        const verdict = this.#permitted(caller, 'storage');
        if (verdict !== undefined) return verdict;
        this.#options.kv(storageNamespace(record.id)).set(call.key, call.value);
        return wireOk();
      }

      /**
       * Contributed views, gated on `views`.
       *
       * Only the DECLARATION crosses; the provider stays in the child. So this
       * records ownership and nothing else — which is exactly what D14 needs, and
       * why a row click can be attributed at all.
       */
      case 'view.register': {
        const verdict = this.#permitted(caller, 'views');
        if (verdict !== undefined) return verdict;
        this.#options.views?.register(record.id, call.type, call.viewKind, call.component, {
          ...(call.surface === undefined ? {} : { surface: call.surface }),
          ...(call.key === undefined ? {} : { key: call.key }),
          ...(call.title === undefined ? {} : { title: call.title }),
          ...(call.icon === undefined ? {} : { icon: call.icon }),
        });
        this.#log.info(`${record.id} contributed the ${call.viewKind} view "${call.type}"`);
        return wireOk();
      }

      case 'view.unregister': {
        const verdict = this.#permitted(caller, 'views');
        if (verdict !== undefined) return verdict;
        this.#options.views?.unregister(call.type);
        return wireOk();
      }

      case 'view.changed': {
        const verdict = this.#permitted(caller, 'views');
        if (verdict !== undefined) return verdict;
        // A NUDGE, not the data: the host re-reads when it is ready, so a chatty
        // extension cannot flood the renderer and the host never draws a
        // snapshot it did not ask for.
        this.#options.views?.changed(call.type);
        return wireOk();
      }

      case 'storage.delete': {
        const verdict = this.#permitted(caller, 'storage');
        if (verdict !== undefined) return verdict;
        this.#options.kv(storageNamespace(record.id)).delete(call.key);
        return wireOk();
      }

      /**
       * Running a program, gated on `process.exec` — the heaviest grant there is.
       *
       * The runner is injected rather than imported, for the same reason the pty
       * spawn is: `child_process` lives behind the platform boundary, and a test
       * for this dispatch must not need a subprocess to prove that a denial
       * denies. An absent runner is a **refusal with a reason**, never a silent
       * success — this build simply has no way to run anything.
       */
      case 'process.exec':
      case 'process.git': {
        const verdict = this.#permitted(caller, 'process.exec');
        if (verdict !== undefined) return verdict;
        const run = this.#options.run;
        if (run === undefined) {
          return wireErr('host-failed', `${call.kind}: this build has no process runner wired`);
        }
        const result =
          call.kind === 'process.exec'
            ? await run.exec(call.cmd, call.opts)
            : await run.git(call.mode, call.args, call.opts);
        // The API's own shape: a non-zero exit is a VALUE, not a wire failure.
        // `git` exiting 1 for "no differences" is not an error in the transport,
        // and collapsing the two would make every caller unable to tell a repo
        // state from a broken host.
        return wireOk(result);
      }
    }
  }

  #registerProxy(record: HostedExtension, call: Extract<ApiCall, { kind: 'command.register' }>): WireResult {
    if (record.commands.has(call.commandId)) {
      return wireErr('duplicate-command', `${record.id} has already registered "${call.commandId}"`);
    }
    if (call.permission !== undefined && !isPermission(call.permission)) {
      // Refused rather than dropped: a command registered with an unknown
      // permission would be a command with NO permission, which is the opposite
      // of what its author wrote.
      return wireErr('invalid-args', `unknown permission ${JSON.stringify(call.permission)} on "${call.commandId}"`);
    }
    try {
      const registration = this.#options.registry.register(call.commandId, {
        // A pass-through: the extension's real schema lives in the child and runs
        // there, before its handler. See `ext-protocol.ts`'s `command.register`.
        schema: s.unknown(),
        ...(call.title === undefined ? {} : { title: call.title }),
        ...(call.permission === undefined ? {} : { permission: call.permission }),
        // The invocation's deadline is forwarded, because this handler has a
        // transport under it and the caller is the only party that knows how long
        // its own call may take.
        handler: (args, invoker, invocation) =>
          this.#runInChild(record, call.commandId, args, invoker, invocation?.timeoutMs),
      });
      record.commands.set(call.commandId, registration);
      return wireOk();
    } catch (error) {
      // `register` throws on a duplicate id, and a frame must not be able to throw
      // in main. An extension colliding with `layout.split` gets a typed refusal.
      const code = error instanceof DuplicateCommandError ? 'duplicate-command' : 'host-failed';
      this.#log.warn(`${record.id} could not register "${call.commandId}": ${messageOf(error)}`);
      return wireErr(code, messageOf(error));
    }
  }

  /**
   * The proxy handler: forward an invocation to the extension that owns it.
   *
   * It **throws** on failure, because that is how `CommandRegistry` turns a
   * handler failure into a typed `handler-failed` carrying the message. The wire
   * code is prefixed onto that message rather than lost: an extension's own
   * `invalid-args` arrives at the CLI as `handler-failed: invalid-args: …`, which
   * is one indirection but keeps every fact.
   */
  async #runInChild(
    record: HostedExtension,
    commandId: string,
    args: unknown,
    invoker: Caller,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.#child === undefined || this.#state !== 'ready') {
      throw new Error(`unavailable: the extension host is ${this.#state}, so "${commandId}" cannot run`);
    }
    const answer = await this.#ask(
      {
        kind: 'command',
        extension: record.id,
        commandId,
        args,
        // The REAL caller, not this host's. `CommandSpec.handler(args, caller)`
        // promises an extension the attributed principal; substituting our own
        // would be the attribution lie `Caller` exists to end.
        caller: invoker,
      },
      timeoutMs === undefined ? undefined : timeoutMs + ASK_DEADLINE_SLACK_MS,
    );
    if (answer.ok) return answer.value;
    throw new Error(`${answer.error.code}: ${answer.error.message}`);
  }

  /** Membership only — the check `authorize` runs for a command with no permission. */
  #membership(caller: Caller): WireResult | undefined {
    const verdict = authorize(caller, undefined, this.#grants());
    return verdict.allowed ? undefined : wireErr('denied', verdict.reason);
  }

  /**
   * A permission check for the two groups that are not commands.
   *
   * Core's own `authorize`, with the same `GrantSet` the dispatcher reads — one
   * authorizer, reused, rather than a second implementation of the same
   * judgement. That distinction is the whole reason `authorize` is pure and takes
   * its grants as a value.
   */
  #permitted(caller: Caller, permission: Permission): WireResult | undefined {
    const verdict = authorize(caller, permission, this.#grants());
    return verdict.allowed ? undefined : wireErr('denied', verdict.reason);
  }

  #grants(): GrantSet {
    return this.#options.permissions.grantSet();
  }
}

/**
 * `Manifest` → the shape `manifestSchema` validates.
 *
 * Field by field, and its arrays copied into mutable ones, for the same reason
 * `channels.ts` refuses to alias core's DTOs across a process boundary: what
 * reaches the wire reaches it because somebody wrote it here. `s.object` also
 * rejects unknown keys, so a spread of a future `Manifest` field would fail the
 * child's own parse — an explicit copy makes that a typecheck error instead.
 */
function wireManifest(manifest: Manifest): {
  id: string;
  name: string;
  version: string;
  api: string;
  activation: string[];
  permissions: string[];
  dependencies?: string[];
  contributes?: {
    commands?: { id: string; title?: string; key?: string }[];
    views?: { id: string; type: string; title: string; region?: string }[];
  };
} {
  const contributes = manifest.contributes;
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    api: manifest.api,
    activation: [...manifest.activation],
    permissions: [...manifest.permissions],
    ...(manifest.dependencies === undefined ? {} : { dependencies: [...manifest.dependencies] }),
    ...(contributes === undefined
      ? {}
      : {
          contributes: {
            ...(contributes.commands === undefined
              ? {}
              : {
                  commands: contributes.commands.map((command) => ({
                    id: command.id,
                    // Absent = not user-facing, and it must stay absent rather
                    // than become an empty string: the palette filters on the
                    // field's presence.
                    ...(command.title === undefined ? {} : { title: command.title }),
                    ...(command.key === undefined ? {} : { key: command.key }),
                  })),
                }),
            ...(contributes.views === undefined
              ? {}
              : {
                  views: contributes.views.map((view) => ({
                    id: view.id,
                    type: view.type,
                    title: view.title,
                    ...(view.region === undefined ? {} : { region: view.region }),
                  })),
                }),
          },
        }),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
