import {
  createLogger,
  disposeAll,
  extensionId,
  isPermission,
  type ActivateFn,
  type Caller,
  type Clock,
  type Envelope,
  type ExtensionContext,
  type LogLevel,
  type Permission,
  type ViewProvider,
} from '@shepherd/sdk';
import {
  EXT_PROTOCOL_VERSION,
  frameIds,
  hostFrameSchema,
  readFrames,
  wireErr,
  wireOk,
  type ApiCall,
  type ChildFrame,
  type HostAsk,
  type HostFrame,
  type WireResult,
} from '../shared/ext-protocol.ts';
import {
  createContext,
  createShepherd,
  ExtensionWorld,
  type ExtHostServices,
  type ExtensionCommand,
} from './api.ts';

/**
 * The extension host, as a state machine over frames — everything the utility
 * process does except owning the port.
 *
 * Kept transport-free on purpose: `receive(raw)` takes an `unknown` and `send` is
 * injected, so every decision in here is testable without forking a process. The
 * electron half is `index.ts`, and it is deliberately too small to hide anything.
 *
 * Four rules it enforces:
 *
 *   - **Nothing crosses until the host has accepted our protocol.** A call made
 *     before `hello-ok` answers `unavailable` rather than queueing into a channel
 *     that may be about to be torn down.
 *   - **One bad extension is one bad extension.** A throw inside `activate` is
 *     caught, its subscriptions are disposed, and the failure goes back with the
 *     message intact — the host marks it failed and every other extension keeps
 *     running.
 *   - **Every call has a deadline.** A host that stops answering must produce a
 *     `timeout`, not a promise nobody ever settles. Through the injected `Clock`,
 *     so the test for it does not sleep.
 *   - **An answer to an id nobody awaits is logged, never thrown.** After a
 *     timeout, a late answer is normal traffic on a process boundary.
 */

/**
 * How long a child→host call waits. Generous: the host may be mid-`git`, and the
 * cost of being wrong in this direction is a spurious failure rather than a hang.
 */
export const CHILD_CALL_TIMEOUT_MS = 15_000;

/**
 * Slack added to a call's declared timeout before the transport gives up.
 *
 * The transport must outlive the work, not race it: if the two deadlines were
 * equal, the transport would time out at the same instant the host is killing
 * the process, and the caller would get a transport failure for work that
 * completed — reproducing D1's "false failure with a real side effect" one layer
 * along.
 */
const DEADLINE_SLACK_MS = 5_000;

/**
 * How long this particular call may take.
 *
 * Only `process.*` declares one, because only it runs a program whose duration
 * is the caller's business rather than the transport's. Everything else keeps
 * the flat default — which is the property the constant exists for, and which a
 * test pins.
 */
function deadlineFor(call: ApiCall): number {
  if (call.kind === 'process.exec' || call.kind === 'process.git') {
    return call.opts.timeoutMs + DEADLINE_SLACK_MS;
  }
  return CHILD_CALL_TIMEOUT_MS;
}

export interface ExtHostRuntimeOptions {
  readonly send: (frame: ChildFrame) => void;
  readonly clock: Clock;
  /** Reported in `hello`, so a log line — and a smoke — can name the process that answered. */
  readonly childPid: number;
  /** id → its `activate`. Built-ins are compiled in; see `builtins.ts`. */
  readonly modules: ReadonlyMap<string, ActivateFn>;
  /**
   * Where a line goes when the host cannot be told: before `hello-ok`, and for a
   * frame that did not parse. Without it, a refused handshake is silent on both
   * sides at once.
   */
  readonly log: (line: string) => void;
  /** Overridable so a test can drive a version the host refuses. */
  readonly protocol?: number;
}

interface Loaded {
  readonly id: string;
  readonly handle: string;
  readonly commands: Map<string, ExtensionCommand>;
  /** Its tree providers, by view type. They cannot cross the port, so they stay. */
  readonly views: Map<string, ViewProvider>;
  context?: ExtensionContext;
  /** Its manifest's `dependencies` — the only ids its API object will resolve. */
  readonly dependencies: readonly string[];
}

interface Subscription {
  readonly owner: string;
  readonly fn: (payload: unknown, envelope: Envelope) => void;
}

export class ExtHostRuntime {
  readonly #send;
  readonly #clock;
  readonly #childPid;
  readonly #modules;
  readonly #line;
  readonly #protocol;
  readonly #nextId = frameIds('ext');
  readonly #pending = new Map<string, (result: WireResult) => void>();
  readonly #loaded = new Map<string, Loaded>();
  readonly #subscriptions = new Map<string, Subscription>();
  /**
   * Extension code runs in one address space, so the seams *between* extensions
   * are ordinary objects rather than a protocol (sketch §7b/§7c) — one point
   * registry and one table of exported APIs, shared by everything activated here.
   */
  readonly #world;
  #state: 'starting' | 'accepted' | 'refused' | 'closed' = 'starting';
  #apiVersion = '0.0.0';
  #subscriptionSeq = 0;

  constructor(options: ExtHostRuntimeOptions) {
    this.#send = options.send;
    this.#clock = options.clock;
    this.#childPid = options.childPid;
    this.#modules = options.modules;
    this.#line = options.log;
    this.#protocol = options.protocol ?? EXT_PROTOCOL_VERSION;
    this.#world = new ExtensionWorld({
      hosted: new Set(options.modules.keys()),
      // Our own stderr, not `#log`: a point registry is shared by every extension
      // here, so there is no handle to attribute its lines to and inventing one
      // would put a warning under the wrong extension's name.
      logger: createLogger({ clock: options.clock, level: 'info', sink: (line) => options.log(line) }),
    });
  }

  /** Announce ourselves. The host judges the version and answers. */
  start(): void {
    this.#send({ kind: 'hello', id: this.#nextId(), protocol: this.#protocol, childPid: this.#childPid });
  }

  get state(): 'starting' | 'accepted' | 'refused' | 'closed' {
    return this.#state;
  }

  /** Every extension currently holding a live `activate`. For a test and for a log. */
  get active(): readonly string[] {
    return [...this.#loaded.keys()];
  }

  /**
   * One message off the port. `raw` is untrusted: it may be a frame, an array of
   * frames, or something from a build that does not exist yet.
   */
  receive(raw: unknown): void {
    const read = readFrames(raw, hostFrameSchema);
    // Skipped, never fatal, and never silent — the whole point of `readFrames`
    // returning both halves.
    for (const reason of read.skipped) this.#line(`extension host skipped an unreadable frame: ${reason}`);
    for (const frame of read.frames) void this.#dispatch(frame);
  }

  async #dispatch(frame: HostFrame): Promise<void> {
    switch (frame.kind) {
      case 'hello-ok': {
        this.#state = 'accepted';
        this.#apiVersion = frame.apiVersion;
        this.#line(`extension host accepted: protocol ${frame.protocol}, api ${frame.apiVersion}`);
        return;
      }
      case 'hello-refused': {
        this.#state = 'refused';
        // The host owns our lifetime and will kill us; saying why on our own
        // stderr is what makes the two halves' accounts of it agree.
        this.#line(`extension host refused by the main process: ${frame.reason}`);
        return;
      }
      case 'ask': {
        const result = await this.#runAsk(frame.ask);
        this.#send({ kind: 'answer', id: frame.id, result });
        return;
      }
      case 'result': {
        const settle = this.#pending.get(frame.id);
        if (settle === undefined) {
          // Normal after a timeout. Logged, because a *pattern* of these is a real
          // fault and nothing else would show it.
          this.#line(`extension host got an answer for ${frame.id}, which nothing is waiting for`);
          return;
        }
        this.#pending.delete(frame.id);
        settle(frame.result);
        return;
      }
      case 'event': {
        const subscription = this.#subscriptions.get(frame.subscription);
        if (subscription === undefined) {
          this.#line(`extension host got ${frame.topic} for unknown subscription ${frame.subscription}`);
          return;
        }
        try {
          subscription.fn(frame.payload, {
            seq: frame.seq,
            ts: frame.ts,
            // Structurally identical; the SDK's branded ids are compile-time only.
            source: frame.source as Caller,
          });
        } catch (error) {
          // Same rule as the bus: one bad subscriber must not stop the process,
          // and must not be silent.
          this.#line(`${subscription.owner}'s listener for ${frame.topic} threw: ${messageOf(error)}`);
        }
        return;
      }
    }
  }

  // ------------------------------------------------------------------- the asks

  async #runAsk(ask: HostAsk): Promise<WireResult> {
    if (this.#state !== 'accepted') {
      return wireErr('unavailable', `the extension host is ${this.#state}, not accepted — nothing was run`);
    }
    switch (ask.kind) {
      case 'activate':
        return this.#activate(ask);
      case 'view.children': {
        // The provider lives here because functions cannot cross a port. The
        // host asks; this answers. An unknown type is a NAMED failure, never an
        // empty list — "there are no rows" and "nobody registered that" are
        // different facts and a renderer drawing the first for the second is how
        // a contribution silently does not exist.
        const owner = this.#loaded.get(ask.extension);
        const provider = owner?.views.get(ask.type);
        if (provider === undefined || provider.kind !== 'tree') {
          return wireErr('unknown-command', `no tree view "${ask.type}" is registered by ${ask.extension}`);
        }
        try {
          return wireOk(await provider.data.children(ask.parent));
        } catch (error) {
          return wireErr('handler-failed', error instanceof Error ? error.message : String(error));
        }
      }

      case 'deactivate':
        return this.#deactivate(ask.extension);
      case 'command':
        return this.#runCommand(ask);
    }
  }

  async #activate(ask: Extract<HostAsk, { kind: 'activate' }>): Promise<WireResult> {
    const module = this.#modules.get(ask.extension);
    if (module === undefined) {
      return wireErr(
        'unavailable',
        `no built-in module for ${ask.extension} in this build — the registry knows about it and the host does not`,
      );
    }
    // Idempotent: the registry shares one in-flight activation, but a restart
    // re-asks, and re-running `activate` would register everything twice.
    if (this.#loaded.has(ask.extension)) return wireOk();

    // The `activate` ask has always carried the manifest and nothing read it. This
    // is its first reader: `dependencies` is what `extensions.get` and
    // `points.get` gate on, and it must come from the HOST's copy of the manifest
    // — an extension that could name its own dependencies would be authorizing
    // itself.
    const dependencies = ask.manifest.dependencies ?? [];
    const record: Loaded = {
      id: ask.extension,
      handle: ask.handle,
      commands: new Map(),
      views: new Map(),
      dependencies,
    };
    const services = this.#servicesFor(record);
    const context = createContext({
      id: extensionId(ask.extension),
      source: ask.source,
      dataDir: ask.dataDir,
      homeDir: ask.homeDir,
      // The wire carries strings (mirroring `manifestSchema`'s looseness); this is
      // where they become the closed union, and an unknown one is dropped rather
      // than handed on as a `Permission` it is not.
      permissions: knownPermissions(ask.permissions),
      // Absent on the wire means false: an old host that does not send it is a
      // host whose build we cannot vouch for, and the safe answer to "show
      // developer UI" is no.
      isDev: ask.isDev ?? false,
      storage: ask.storage,
      clock: this.#clock,
      services,
    });
    record.context = context;
    // Recorded BEFORE `activate` runs, because `activate` immediately makes calls
    // and every one of them is attributed through this record's handle.
    this.#loaded.set(ask.extension, record);

    try {
      const exported = await module(
        context,
        createShepherd({
          apiVersion: this.#apiVersion,
          proposed: ask.proposed,
          services,
          id: ask.extension,
          dependencies,
          world: this.#world,
          viewProviders: record.views,
        }),
      );
      // Recorded only on success, and after the await: an extension whose
      // `activate` rejected has no API, and handing a half-built one to a
      // dependent is worse than telling it nothing is there.
      this.#world.recordExport(ask.extension, exported);
    } catch (error) {
      // One bad extension is one bad extension. Roll back what it managed to
      // register so a later retry starts clean, and hand the message back intact.
      this.#teardown(record);
      return wireErr('handler-failed', `${ask.extension} threw while activating: ${messageOf(error)}`);
    }
    return wireOk();
  }

  #deactivate(id: string): WireResult {
    const record = this.#loaded.get(id);
    if (record === undefined) {
      this.#line(`extension host was asked to deactivate ${id}, which is not active here`);
      return wireOk();
    }
    this.#teardown(record);
    return wireOk();
  }

  async #runCommand(ask: Extract<HostAsk, { kind: 'command' }>): Promise<WireResult> {
    const record = this.#loaded.get(ask.extension);
    if (record === undefined) {
      return wireErr('unavailable', `${ask.extension} is not active in the extension host`);
    }
    const handler = record.commands.get(ask.commandId);
    if (handler === undefined) {
      return wireErr('unknown-command', `${ask.extension} has no handler for "${ask.commandId}"`);
    }
    try {
      return await handler(ask.args, ask.caller as Caller);
    } catch (error) {
      return wireErr('handler-failed', `"${ask.commandId}" failed: ${messageOf(error)}`);
    }
  }

  /**
   * Disposes an extension's subscriptions, then forgets it.
   *
   * `disposeAll` runs in reverse order and rethrows the first failure once it has
   * disposed the rest; catching that here is what keeps a badly-written
   * `dispose()` from stranding the whole host.
   */
  #teardown(record: Loaded): void {
    const context = record.context;
    if (context !== undefined) {
      try {
        disposeAll(context.subscriptions);
      } catch (error) {
        this.#line(`${record.id} threw while disposing its subscriptions: ${messageOf(error)}`);
      }
    }
    for (const [key, subscription] of [...this.#subscriptions]) {
      if (subscription.owner === record.id) this.#subscriptions.delete(key);
    }
    record.commands.clear();
    // Its exported API and any point it defined go with it. The points matter
    // even though a well-behaved extension puts them in `ctx.subscriptions`: an
    // `activate` that defines a point and *then* throws never reached that line,
    // so without this the rolled-back extension leaves its point id taken and the
    // retry fails with a duplicate-point error that blames the wrong thing.
    this.#world.forget(record.id);
    this.#loaded.delete(record.id);
  }

  // -------------------------------------------------------------- the API's port

  #servicesFor(record: Loaded): ExtHostServices {
    const services: ExtHostServices = {
      call: (call) => this.#call(record.handle, call),
      tell: (call, describe) => {
        void this.#call(record.handle, call).then((result) => {
          if (result.ok) return;
          // The rule this whole codebase is built on: a branch that ends in "and
          // then nothing happens" says why. These are the `void`-returning SDK
          // signatures, where a log line is the only channel there is.
          this.#log(record.handle, 'warn', `${record.id}: ${describe} failed: ${result.error.code}: ${result.error.message}`);
        });
      },
      subscribe: (topic, fn) => {
        this.#subscriptionSeq += 1;
        const key = `${record.handle}:${this.#subscriptionSeq}`;
        this.#subscriptions.set(key, { owner: record.id, fn });
        services.tell({ kind: 'event.on', topic, subscription: key }, `event.on ${topic}`);
        return {
          dispose: () => {
            if (!this.#subscriptions.delete(key)) return;
            services.tell({ kind: 'event.off', subscription: key }, `event.off ${topic}`);
          },
        };
      },
      defineCommand: (commandId, handler) => {
        record.commands.set(commandId, handler);
        return {
          dispose: () => {
            if (record.commands.get(commandId) === handler) record.commands.delete(commandId);
          },
        };
      },
      log: (level, message) => this.#log(record.handle, level, `${record.id}: ${message}`),
    };
    return services;
  }

  /**
   * Tell the runtime the channel is gone.
   *
   * Main has done this since M1 (`ext-host.ts`'s `#failPending`); the child had
   * no equivalent, and its only escape from a dead host was the flat deadline.
   * That was survivable while every call shared a 15s ceiling. It stopped being
   * survivable when a call could name ten minutes (D1) — a dead main process
   * would have meant a ten-minute hang — so the two halves land together.
   *
   * Idempotent: a port can report `close` alongside an error, and settling twice
   * must not throw.
   */
  channelClosed(reason: string): void {
    this.#state = 'closed';
    for (const [id, settle] of [...this.#pending]) {
      this.#pending.delete(id);
      settle(wireErr('unavailable', `the frame channel closed before an answer arrived: ${reason}`));
    }
  }

  #call(handle: string, call: ApiCall): Promise<WireResult> {
    if (this.#state !== 'accepted') {
      return Promise.resolve(
        wireErr('unavailable', `the extension host is ${this.#state}; ${call.kind} was not sent`),
      );
    }
    return new Promise<WireResult>((resolve) => {
      const id = this.#nextId();
      // A call may declare how long its work legitimately takes; the flat
      // constant is the default for everything that does not. Without this, a
      // cold `git fetch` reports failure while git is still working — and then
      // succeeds anyway, which is a false failure with a real side effect.
      const deadline = deadlineFor(call);
      // One settle, whichever comes first. Without the delete-before-resolve the
      // late answer path below would settle a promise that already has a value —
      // harmless for a Promise, but it would also hide the timeout in the log.
      const timer = this.#clock.setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        resolve(wireErr('timeout', `${call.kind} got no answer in ${deadline}ms`));
      }, deadline);
      this.#pending.set(id, (result) => {
        timer.dispose();
        resolve(result);
      });
      this.#send({ kind: 'call', id, handle, call, deadlineMs: deadline });
    });
  }

  /**
   * A log line, to the host's logger when it is listening and to our own stderr
   * when it is not.
   *
   * Deliberately does NOT go through `tell`: a failed log would log its own
   * failure, and the loop that produces is worse than the line that was lost.
   * This is the same single swallow `createLogger` makes, for the same reason.
   */
  #log(handle: string, level: LogLevel, message: string): void {
    if (this.#state !== 'accepted') {
      this.#line(`[${level}] ${message}`);
      return;
    }
    // A real correlated call whose answer is then DISCARDED — not a bare `send`.
    // Sending without registering a pending entry made the host's perfectly
    // correct reply arrive at "an answer nothing is waiting for", so every log
    // line produced a second line saying it was unexpected, and the genuine
    // late-answer signal was buried under it. Measured in `smoke:m1`.
    //
    // The discard is deliberate and is the same single swallow `createLogger`
    // makes: a failed log that logged its failure would loop, and the loop is
    // worse than the line that was lost.
    void this.#call(handle, { kind: 'log', level, message });
  }
}

function knownPermissions(raw: readonly string[]): readonly Permission[] {
  return raw.filter((value): value is Permission => isPermission(value));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
