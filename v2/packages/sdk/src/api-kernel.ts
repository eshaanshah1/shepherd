import type { Caller } from './caller.ts';
import type { Disposable } from './disposable.ts';
import type { Envelope } from './envelope.ts';
import type { NodeID, SessionID } from './ids.ts';
import type { Permission } from './permission.ts';
import type { Result } from './result.ts';
import type { Schema, SchemaIssue } from './schema.ts';

/**
 * Commands, events, attention, storage, process — the kernel's remaining
 * groups (core-design §4.3–4.7).
 */

// --------------------------------------------------------------------- commands

export type CommandErrorCode =
  | 'unknown-command'
  | 'invalid-args'
  | 'denied'
  | 'handler-failed'
  /** The command exists but its owning extension is not active/loaded. */
  | 'unavailable';

export interface CommandError {
  readonly code: CommandErrorCode;
  readonly message: string;
  readonly commandId: string;
  /** Present only for `invalid-args`, so a CLI can point at the bad field. */
  readonly issues?: readonly SchemaIssue[];
}

/**
 * How long the caller will wait for this one invocation (ADR 0030, in the
 * host→child direction this time).
 *
 * A command may legitimately take longer than any constant a transport could
 * pick: asking a model is seconds of network, and the transport knows nothing
 * about that. Absent means the flat default, which is the property that default
 * exists for.
 */
export interface InvokeOptions {
  readonly timeoutMs?: number;
}

/**
 * What a handler is told about the call it is serving, beyond its arguments.
 *
 * Only the deadline so far, and only because a proxy handler — one that forwards
 * the invocation somewhere with a transport of its own — has to know it. A
 * handler that ignores this parameter is the normal case.
 */
export interface Invocation {
  readonly timeoutMs?: number;
}

export interface CommandSpec<A, R> {
  readonly schema: Schema<A>;
  /**
   * The permission a non-`user` caller must hold. Absent means any caller may
   * invoke it — which is a decision, so write it deliberately.
   */
  readonly permission?: Permission;
  /** Shown in the palette and in `shepherd help`. Absent = not user-facing. */
  readonly title?: string;
  handler(args: A, caller: Caller, invocation?: Invocation): Promise<R> | R;
}

export interface CommandAPI {
  register<A, R>(id: string, spec: CommandSpec<A, R>): Disposable;
  /**
   * Never throws and never silently does nothing: an unknown id, a schema
   * failure and a denial are all typed errors that get logged on the way out.
   * That sentence is the entire reason this registry exists (review §Bad-2).
   */
  invoke<R = unknown>(id: string, args?: unknown, opts?: InvokeOptions): Promise<Result<R, CommandError>>;
  list(): readonly { readonly id: string; readonly title?: string }[];
}

// ----------------------------------------------------------------------- events

export interface EventAPI {
  emit<T>(topic: string, payload: T): void;
  on<T>(topic: string, fn: (payload: T, envelope: Envelope) => void): Disposable;
}

// -------------------------------------------------------------------- attention

/**
 * `attention` is a generic channel: an extension says *how much* it needs you
 * and *why*, and core owns every consequence — dot colour, dock badge, ⌘⇧A
 * order, and whether a banner/chime/push happens.
 *
 * Core deliberately does not know what "blocked" means. That meaning is
 * `claude-code`'s, and keeping it there is what lets a second agent kind exist
 * without touching the kernel.
 */
export type AttentionLevel = 'none' | 'info' | 'attention' | 'urgent';

export interface AttentionState {
  readonly level: AttentionLevel;
  /** Shown to the user. "answer needed", not "state 3". */
  readonly reason: string;
  /** A design-token name. Never a hex string — the theme owns colour. */
  readonly color?: string;
}

export interface AttentionAPI {
  set(target: SessionID | NodeID, state: AttentionState): void;
  clear(target: SessionID | NodeID): void;
  get(target: SessionID | NodeID): AttentionState | undefined;
  /** Total across every root, which is what the dock badge shows. */
  count(): number;
  onDidChange(fn: () => void): Disposable;
}

// ---------------------------------------------------------------------- storage

/**
 * Namespaced, schema-validated key/value. One store, versioned migrations.
 *
 * v1 accumulated 34 string-literal UserDefaults keys and a `save()` on every
 * `cd`; the discipline that replaces it is: a namespace is a value, keys are
 * declared with their schema, and writes are debounced by the store rather than
 * by each caller remembering to.
 */
export interface KV {
  get<T>(key: string, schema: Schema<T>): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
  keys(): readonly string[];
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------- process

export interface ExecOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ExecOk {
  readonly ok: true;
  readonly stdout: string;
  readonly stderr: string;
}
export interface ExecErr {
  readonly ok: false;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * One runner, so the fixes are structural rather than remembered.
 *
 * `gitRead` always passes `GIT_OPTIONAL_LOCKS=0` — a plain `git status`
 * **rewrites `.git/index`**, which in v1 woke the watcher that had just run it
 * and the two sustained each other with nothing happening in the repo.
 * `gitWrite` MERGES into the inherited environment rather than replacing it:
 * replacing loses `HOME`, and with it git's config. Both were v1 bugs; here they
 * are the only way to call git.
 *
 * Arguments are arrays, never interpolated strings — `GIT_EDITOR`-style
 * substitutions included.
 */
export interface ProcessAPI {
  exec(cmd: readonly string[], opts: ExecOptions): Promise<ExecOk | ExecErr>;
  gitRead(args: readonly string[], opts: ExecOptions): Promise<ExecOk | ExecErr>;
  gitWrite(args: readonly string[], opts: ExecOptions): Promise<ExecOk | ExecErr>;
}

// ------------------------------------------------------------- extension points

/**
 * The primitive that makes **extensions platforms too**, not just the core.
 *
 * VS Code's contribution points are core-owned, so a third-party extension
 * cannot offer a seam of its own without a fork. Here any extension can define
 * one, and the rule that follows is the dogfood rule one level deeper: a
 * built-in routes its own pluggable decisions through its own points, so the
 * stock behaviour is just the default provider.
 *
 * The cost, accepted knowingly: a point is public API under the same
 * proposed→stable process as everything else, which is why they should be few
 * and coarse.
 */
export interface ExtensionPoint<T> extends Disposable {
  readonly id: string;
  register(provider: T, opts?: { readonly priority?: number }): Disposable;
  /** Highest priority first; registration order breaks a tie. */
  all(): readonly T[];
  first(): T | undefined;
}

export interface PointsAPI {
  define<T>(id: string, opts?: { readonly order?: 'priority' | 'registration' }): ExtensionPoint<T>;
  /**
   * Another extension's point, by id.
   *
   * `undefined` when nothing defines that id, or when its owner is not active —
   * the registry frees an id on dispose, so those collapse into one honest
   * answer. **Reaching a point whose owner the caller never declared in its
   * manifest `dependencies` throws instead**, because that is a manifest bug and
   * an author who got `undefined` for it would debug the seam rather than the one
   * line that is wrong.
   */
  get<T>(id: string): ExtensionPoint<T> | undefined;
}

// -------------------------------------------------------- cross-extension APIs

/**
 * Reaching another extension's exported API — the dependency arrows from the
 * sketch's §3 table, made callable.
 *
 * `get` resolves **only ids the caller declared** in its manifest's
 * `dependencies`, so this is not a way to discover and poke at whatever happens
 * to be installed. The headless-agent seam is the motivating consumer: an
 * extension that wants to ask a model something calls
 * `get<AgentsAPI>('shepherd.agents-core')`, which keeps the *vendor* out of the
 * kernel while still making "ask Claude" one line for an extension author.
 */
export interface ExtensionsAPI {
  /**
   * The API the named extension returned from its `activate`.
   *
   * Resolves **only ids the caller declared** in its manifest's `dependencies`;
   * an undeclared id is a typed refusal, not `undefined`. `undefined` means one
   * thing and one thing only — the extension is hosted here and is not active —
   * so an extension in another process and one that exported nothing are their
   * own errors rather than three facts wearing one answer.
   *
   * Not semver-checked: `Manifest.dependencies` carries bare ids with no ranges,
   * so there is nothing to check against. (An earlier version of this comment
   * promised a check that never existed, which was harmless only while `get`
   * refused everything.) If ranges are ever wanted they go in the manifest first.
   */
  get<T>(id: string): T | undefined;
  isActive(id: string): boolean;
}
