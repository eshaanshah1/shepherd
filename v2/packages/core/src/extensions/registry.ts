import {
  err,
  extensionId,
  ok,
  type ExtensionID,
  type ExtensionSource,
  type Logger,
  type Manifest,
  type Result,
} from '@shepherd/sdk';
import { parseManifest, type ManifestError } from './manifest.ts';
import type { PermissionStore } from './permissions.ts';

/**
 * Who is loaded, what state they are in, and when they should activate.
 *
 * This is the **pure model of the lifecycle**: it decides what should happen and
 * calls an injected `activator`. It does not fork a process, own a message port,
 * or know that one exists — that is the next phase, and keeping the decisions
 * here is what lets them be tested without one.
 *
 * The rule the whole file serves: **an extension that silently did not load is
 * v1's `acceptBridged` no-op reborn** — a phone that completed its TLS handshake
 * and was answered by nobody, with no error, no log line, and nothing to
 * distinguish it from a firewall block. So every refusal is a `Result` with a
 * reason, the reason is kept on the record, and a failure logs at `error`.
 */

export type ExtensionState = 'installed' | 'activating' | 'active' | 'failed';

export interface ExtensionRecord {
  readonly manifest: Manifest;
  readonly source: ExtensionSource;
  readonly state: ExtensionState;
  /** Present only while `failed`, and it is the whole point of that state. */
  readonly reason?: string;
}

/**
 * Why the host is asking. Mirrors `ActivationEvent` one-for-one, as data, so the
 * matching is a pure function rather than string surgery at each call site.
 */
export type ActivationTrigger =
  | { readonly kind: 'startup' }
  | { readonly kind: 'command'; readonly id: string }
  | { readonly kind: 'view'; readonly type: string };

/**
 * Whether this manifest asked to be woken by this trigger.
 *
 * Matching is **exact**, never by prefix: `onCommand:tasks.create` firing for
 * `tasks.createBranch` would activate extensions on commands they never declared,
 * which is the opposite of "lazy activation by declaration".
 */
export function shouldActivate(manifest: Manifest, trigger: ActivationTrigger): boolean {
  return manifest.activation.some((event) => {
    switch (trigger.kind) {
      case 'startup':
        return event === 'onStartup';
      case 'command':
        return event === `onCommand:${trigger.id}`;
      case 'view':
        return event === `onView:${trigger.type}`;
    }
  });
}

/**
 * Running the extension's own `activate()`. In this phase it is injected; in the
 * next it is a call across the utility process. A `Result` rather than a throw for
 * the same reason every other boundary here is: a failure has to be a value the
 * registry can record and log.
 */
export type Activator = (manifest: Manifest) => Promise<Result<void, string>>;

export interface ExtensionRegistryOptions {
  readonly permissions: PermissionStore;
  readonly activator: Activator;
  readonly logger: Logger;
}

interface Entry {
  manifest: Manifest;
  source: ExtensionSource;
  state: ExtensionState;
  reason?: string;
  /** The in-flight activation, so two triggers in one tick share one run. */
  pending?: Promise<Result<void, string>>;
}

export class ExtensionRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #permissions: PermissionStore;
  readonly #activator: Activator;
  readonly #log;

  constructor(options: ExtensionRegistryOptions) {
    this.#permissions = options.permissions;
    this.#activator = options.activator;
    this.#log = options.logger.child('extension');
  }

  /**
   * Validate a discovered manifest and record it as `installed`.
   *
   * Also the moment permissions are reviewed — `PermissionStore.review` owns the
   * policy (a built-in is pre-granted, a user extension is not), and this is the
   * *when*. Splitting it that way keeps one answer to "why does this extension
   * hold that permission".
   */
  add(raw: unknown, source: ExtensionSource): Result<Manifest, ManifestError[]> {
    const parsed = parseManifest(raw, source);
    if (!parsed.ok) {
      // Nothing is recorded: a half-registered extension whose manifest we could
      // not read is worse than an absent one, because something later reads a
      // record it cannot trust.
      for (const problem of parsed.error) {
        this.#log.error(`manifest for ${problem.id} (${problem.source}): ${problem.field}: ${problem.message}`);
      }
      return parsed;
    }

    const manifest = parsed.value;
    const existing = this.#entries.get(manifest.id);
    if (existing?.state === 'active' || existing?.state === 'activating') {
      // Its `activate` already ran against the old manifest — the commands, points
      // and permissions in play belong to that version. Swapping the record
      // underneath would make `list()` describe something that is not running.
      const message =
        `${manifest.id} is ${existing.state}; deactivate it before replacing its manifest`;
      this.#log.warn(message);
      return err([{ id: manifest.id, field: '<root>', message, source }]);
    }

    this.#entries.set(manifest.id, { manifest, source, state: 'installed' });
    this.#permissions.review(manifest, source);
    this.#log.info(`installed ${manifest.id} ${manifest.version} (${source})`);
    return ok(manifest);
  }

  state(id: ExtensionID): ExtensionState | undefined {
    return this.#entries.get(id)?.state;
  }

  list(): readonly ExtensionRecord[] {
    return [...this.#entries.values()].map((entry) => ({
      manifest: entry.manifest,
      source: entry.source,
      state: entry.state,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    }));
  }

  /**
   * The ids this extension may reach through `extensions.get` — its **declared**
   * dependencies, and nothing else (§7c: cross-extension calls are declared, not
   * discovered, so reaching another extension's API is a reviewable fact in the
   * manifest rather than a string a caller invents at runtime).
   *
   * Liveness is not folded in. Whether a declared id resolves to a live API is
   * `extensions.get`'s answer at the moment of the call; deciding it twice, in two
   * places, is how the two disagree.
   */
  apiFor(id: ExtensionID): readonly string[] {
    return this.#entries.get(id)?.manifest.dependencies ?? [];
  }

  activate(id: ExtensionID): Promise<Result<void, string>> {
    return this.#activate(id, []);
  }

  /** Every extension this trigger wakes. Each result is reported, so one failure does not hide the rest. */
  async activateFor(
    trigger: ActivationTrigger,
  ): Promise<readonly { readonly id: string; readonly result: Result<void, string> }[]> {
    const out: { id: string; result: Result<void, string> }[] = [];
    for (const entry of [...this.#entries.values()]) {
      if (!shouldActivate(entry.manifest, trigger)) continue;
      out.push({ id: entry.manifest.id, result: await this.activate(extensionId(entry.manifest.id)) });
    }
    return out;
  }

  /**
   * Back to `installed`, which is also a reset of a `failed` record.
   *
   * It deliberately does **not** cascade to active dependents: shutdown would then
   * depend on the order the host tears extensions down in. It does say what it
   * left holding a dead API, because a dependent whose dependency vanished with no
   * line anywhere is exactly the silent failure this class exists to prevent.
   */
  deactivate(id: ExtensionID): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) {
      this.#log.warn(`deactivate: no extension "${id}" is installed`);
      return;
    }
    if (entry.state === 'activating') {
      // The in-flight `#run` still holds this entry and would mark it `active` when
      // the activator resolves — a deactivated extension that resurrects itself.
      // Clearing `pending` here is worse: the next trigger starts a SECOND
      // concurrent run, which is the double-registration the in-flight share exists
      // to prevent. Real cancellation needs the process host, so this refuses.
      this.#log.warn(`refusing to deactivate ${id} while it is still activating`);
      return;
    }
    if (entry.state === 'active') {
      const dependents = this.#activeDependentsOf(id);
      if (dependents.length > 0) {
        this.#log.warn(`deactivating ${id} while ${dependents.join(', ')} still depend on it and stay active`);
      }
    }
    entry.state = 'installed';
    delete entry.reason;
    delete entry.pending;
    this.#log.info(`deactivated ${id}`);
  }

  // ------------------------------------------------------------------- internals

  #activate(id: ExtensionID, path: readonly string[]): Promise<Result<void, string>> {
    // Without this the recursion below is unbounded: a→b→a overflows the stack at
    // startup. It reads the PATH rather than the state, so a diamond (two dependents
    // on one dependency) is not mistaken for a cycle.
    //
    // It sits before the in-flight share on purpose, though today it would still fire
    // after it: `#run`'s synchronous prefix reaches the dependency loop before
    // `entry.pending` is assigned, so a re-entrant call inside one chain sees no
    // pending promise. Add an `await` anywhere ahead of that loop and the order starts
    // mattering — a→b→a would await the promise `a` is inside, and a deadlock has no
    // stack trace to read. Measured, not assumed: moving this below the share leaves
    // the cycle tests green, which is why the ordering is written down here instead of
    // being defended by a test that cannot see it.
    if (path.includes(id)) {
      const cycle = [...path, id].join(' -> ');
      return Promise.resolve(this.#fail(id, `dependency cycle: ${cycle}`));
    }

    const entry = this.#entries.get(id);
    if (entry === undefined) {
      const message = `no extension "${id}" is installed`;
      this.#log.warn(`activate: ${message}`);
      return Promise.resolve(err(message));
    }
    // Idempotent: an `onCommand` trigger fires every time the command is invoked.
    if (entry.state === 'active') return Promise.resolve(ok(undefined));
    // Two transports can invoke the same `onCommand` in one tick. Activating twice
    // would register every contributed command twice, and the second registration
    // THROWS (`DuplicateCommandError`) — so this is not a tidiness point.
    if (entry.pending !== undefined) return entry.pending;

    const run = this.#run(entry, id, path);
    entry.pending = run;
    return run.finally(() => {
      delete entry.pending;
    });
  }

  async #run(entry: Entry, id: ExtensionID, path: readonly string[]): Promise<Result<void, string>> {
    const missing = this.#permissions.missing(entry.manifest);
    if (missing.length > 0) {
      // The gate is the store, not the source: `builtin` earns its grant at install
      // time and is then read like anybody else, so a revoked built-in is denied.
      return this.#fail(id, `${id} was not granted: ${missing.join(', ')} (declared but never granted)`);
    }

    entry.state = 'activating';
    for (const dependency of entry.manifest.dependencies ?? []) {
      const depId = extensionId(dependency);
      if (!this.#entries.has(dependency)) {
        return this.#fail(id, `${id} depends on ${dependency}, which is not installed`);
      }
      const result = await this.#activate(depId, [...path, id]);
      if (!result.ok) return this.#fail(id, `${id} depends on ${dependency}, which failed: ${result.error}`);
    }

    try {
      const result = await this.#activator(entry.manifest);
      if (!result.ok) return this.#fail(id, result.error);
    } catch (error) {
      // The activator is the process boundary in the next phase. A throw crossing it
      // must not take the registry — or the app — down with it.
      return this.#fail(id, `${id} threw while activating: ${messageOf(error)}`);
    }

    entry.state = 'active';
    delete entry.reason;
    this.#log.info(`activated ${id}`);
    return ok(undefined);
  }

  /** One place marks `failed`, keeps the reason, and logs it. */
  #fail(id: ExtensionID, reason: string): Result<never, string> {
    const entry = this.#entries.get(id);
    if (entry !== undefined) {
      // Not sticky, deliberately: the realistic causes (a permission not yet
      // reviewed, a host that just crashed) are recoverable, and the next trigger is
      // the natural retry.
      entry.state = 'failed';
      entry.reason = reason;
    }
    this.#log.error(`activation failed: ${reason}`);
    return err(reason);
  }

  #activeDependentsOf(id: ExtensionID): readonly string[] {
    return [...this.#entries.values()]
      .filter((entry) => entry.state === 'active' && (entry.manifest.dependencies ?? []).includes(id))
      .map((entry) => entry.manifest.id);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
