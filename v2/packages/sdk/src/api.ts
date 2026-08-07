import type { Clock } from './clock.ts';
import type { CategoryLogger } from './log.ts';
import type { Disposable } from './disposable.ts';
import type { ExtensionID } from './ids.ts';
import type { Permission, ExtensionSource } from './permission.ts';
import type { SessionAPI } from './api-sessions.ts';
import type { LayoutAPI, ViewAPI } from './api-layout.ts';
import type {
  AttentionAPI,
  CommandAPI,
  EventAPI,
  ExtensionsAPI,
  KV,
  PointsAPI,
  ProcessAPI,
  SecretStore,
} from './api-kernel.ts';

/**
 * What an extension is handed, and the API it is handed.
 *
 * ```ts
 * export function activate(ctx: ExtensionContext, api: Shepherd): void {
 *   const { commands, sessions, attention } = api.proposed;
 *   ctx.subscriptions.push(commands.register('tasks.create', { … }));
 * }
 * ```
 */
export interface ExtensionContext {
  readonly id: ExtensionID;
  readonly source: ExtensionSource;
  /** Disposed for you on deactivate, in reverse order. Put everything here. */
  readonly subscriptions: Disposable[];
  readonly storage: KV;
  readonly secrets: SecretStore;
  /** Category already bound to `extension`; the id rides the message. */
  readonly log: CategoryLogger;
  /** Injected time. Nothing an extension writes may call `Date.now()`. */
  readonly clock: Clock;
  /** What the manifest asked for and the user granted. */
  readonly permissions: readonly Permission[];
}

/**
 * Every M1 API group, gathered under `proposed`.
 *
 * §7 decided the stability process: everything lands as **proposed**, a
 * third-party extension may touch it only in a dev build, and **built-ins are
 * required to consume proposed APIs** — that requirement is the proving ground,
 * and it is why an unstable API here is a feature rather than a caveat.
 * Graduation to the root needs two built-in consumers and is a deliberate edit,
 * at which point an extension's `const { … } = api.proposed` line is the only
 * thing that changes.
 *
 * Grouped rather than prefixed per call so the churn is visible exactly once,
 * in the destructure, instead of on every line forever.
 */
export interface ProposedAPI {
  readonly commands: CommandAPI;
  readonly events: EventAPI;
  readonly sessions: SessionAPI;
  readonly layout: LayoutAPI;
  readonly views: ViewAPI;
  readonly attention: AttentionAPI;
  readonly points: PointsAPI;
  readonly extensions: ExtensionsAPI;
  /** Implemented when `tasks` needs git (M3); typed now so the shape is fixed. */
  readonly process: ProcessAPI;
}

export interface Shepherd {
  /** The host's API version, semver. An extension declares the range it tested. */
  readonly version: string;
  readonly proposed: ProposedAPI;
}

/**
 * An extension's entry point. It may **return an API**, which is how one
 * extension offers something to another.
 *
 * The returned value is what `extensions.get<T>(id)` resolves for a dependent
 * that declared this extension in its manifest's `dependencies` — declared, not
 * discovered (sketch §7c), so reaching another extension's API is a reviewable
 * fact in a manifest rather than a string somebody invents at runtime.
 *
 * Returning nothing is the common case and stays legal: an extension that only
 * registers commands and views exports no API at all.
 *
 * `T` defaults to `unknown` rather than `void`, and that is load-bearing rather
 * than lax: the host holds every built-in in one `ReadonlyMap<string,
 * ActivateFn>`, and a `void` default would make that map reject exactly the
 * extensions this type was widened for. An author who exports an API writes
 * `ActivateFn<MyApi>` and gets the checking; the host, which cannot know any
 * extension's API type, holds them all.
 */
export type ActivateFn<T = unknown> = (
  ctx: ExtensionContext,
  api: Shepherd,
) => T | void | Promise<T | void>;
