import { toDisposable, type Disposable } from './disposable.ts';
import type { Logger } from './log.ts';
import type { ExtensionPoint, PointsAPI } from './api-kernel.ts';

/**
 * The extension-point primitive — what makes **extensions platforms too**.
 *
 * VS Code's contribution points are core-owned, so a third-party extension
 * cannot offer a seam of its own without a fork. Here any extension defines one,
 * and the dogfood rule goes a level deeper: a built-in routes its own pluggable
 * decisions through its own points, so the stock behaviour is just the default
 * provider.
 *
 * It lives in the SDK rather than in core because a point hands back a live
 * object holding provider *functions*, which cannot cross a message port — so the
 * registry has to run where the extensions do, and §7b puts every extension
 * service in one utility process. That process may not import `@shepherd/core`
 * (`boundaries.js`: a core import there would be a second, empty kernel), and
 * this file needs nothing from core anyway. Core re-exports it, so its public
 * surface is unchanged.
 *
 * Ownership is recorded, and recorded here rather than in a table beside the
 * registry, for one reason: `get`'s answer and "who defined this" have to become
 * false at the same instant. A point is a `Disposable` an extension puts in
 * `ctx.subscriptions`; disposing it frees the id *and* the owner together, which
 * is what keeps `PointsAPI.get`'s "undefined if its owner is not active" true
 * without a second source of truth about liveness. What ownership is FOR is the
 * host's dependency gate — `get` resolves only for a caller that declared the
 * owner in its manifest (§7c: declared, not discovered) — and that gate lives in
 * the host, above this file, because a manifest is not the registry's business.
 */

export class DuplicatePointError extends Error {
  /**
   * Declared and assigned rather than a constructor parameter property — Electron
   * runs our `.ts` on node's type stripping, which can only erase, so a parameter
   * property is a *launch* failure. `erasableSyntaxOnly` makes it a typecheck error.
   */
  readonly pointId: string;
  /** Who holds the id already, when it was defined with an owner. */
  readonly owner: string | undefined;

  constructor(pointId: string, owner: string | undefined) {
    super(
      `extension point "${pointId}" is already defined${owner === undefined ? '' : ` by ${owner}`}. ` +
        'Defining over it would silently take every provider its author registered with it.',
    );
    this.name = 'DuplicatePointError';
    this.pointId = pointId;
    this.owner = owner;
  }
}

export interface PointRegistryOptions {
  readonly logger: Logger;
}

/**
 * `PointsAPI.define`'s options plus the owner the host supplies.
 *
 * An extension never writes `owner` — it does not get to name itself, or the
 * dependency gate would be a claim rather than a fact. The host's per-extension
 * facade fills it in from the `activate` ask, which is the host's own word.
 */
export interface DefinePointOptions {
  readonly order?: 'priority' | 'registration';
  readonly owner?: string;
}

interface Registration<T> {
  readonly provider: T;
  readonly priority: number;
  /**
   * Registration sequence. The tie-break is written down rather than inherited
   * from `Array.prototype.sort`'s stability: `first()` decides behaviour (which
   * agent kind runs), and a tie-break that is an engine property is one nobody
   * reading this file can see.
   */
  readonly seq: number;
}

class Point<T> implements ExtensionPoint<T> {
  readonly id: string;
  readonly owner: string | undefined;
  readonly #order: 'priority' | 'registration';
  readonly #log;
  readonly #onDispose: (id: string) => void;
  #registrations: Registration<T>[] = [];
  #seq = 0;
  #disposed = false;

  constructor(
    id: string,
    owner: string | undefined,
    order: 'priority' | 'registration',
    log: ReturnType<Logger['child']>,
    onDispose: (id: string) => void,
  ) {
    this.id = id;
    this.owner = owner;
    this.#order = order;
    this.#log = log;
    this.#onDispose = onDispose;
  }

  register(provider: T, opts?: { readonly priority?: number }): Disposable {
    if (this.#disposed) {
      // A provider registered into a dead seam is the silent-no-op class: the
      // extension believes it contributed, the owner never sees it, and nothing
      // says so. Reachable in the real host when an extension activates while its
      // dependency is being torn down.
      this.#log.warn(`ignoring a provider registered into disposed point "${this.id}"`);
      return toDisposable(() => {});
    }
    const registration: Registration<T> = { provider, priority: opts?.priority ?? 0, seq: this.#seq++ };
    this.#registrations.push(registration);
    this.#log.debug(`point ${this.id}: +1 provider (priority ${registration.priority})`);
    return toDisposable(() => {
      // Identity-checked, because the same provider VALUE may be registered twice
      // and a late dispose must not take the other one's registration.
      this.#registrations = this.#registrations.filter((candidate) => candidate !== registration);
    });
  }

  all(): readonly T[] {
    const ordered =
      this.#order === 'registration'
        ? // An explicit contract by the point's author ("these run in the order they
          // were added" — a middleware chain), so priority is ignored rather than
          // quietly reordering somebody's pipeline.
          [...this.#registrations]
        : [...this.#registrations].sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    return ordered.map((registration) => registration.provider);
  }

  first(): T | undefined {
    return this.all()[0];
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#registrations = [];
    this.#onDispose(this.id);
  }
}

export class PointRegistry implements PointsAPI {
  readonly #points = new Map<string, Point<unknown>>();
  readonly #log;

  constructor(options: PointRegistryOptions) {
    this.#log = options.logger.child('extension');
  }

  define<T>(id: string, opts?: DefinePointOptions): ExtensionPoint<T> {
    const existing = this.#points.get(id);
    if (existing !== undefined) throw new DuplicatePointError(id, existing.owner);
    const point = new Point<T>(id, opts?.owner, opts?.order ?? 'priority', this.#log, (disposedId) => {
      // Frees the id, which is what lets a dev-build reload re-define its points
      // instead of needing a restart.
      if (this.#points.get(disposedId) === (point as unknown as Point<unknown>)) this.#points.delete(disposedId);
    });
    this.#points.set(id, point as unknown as Point<unknown>);
    this.#log.debug(
      `defined extension point ${id} (order ${opts?.order ?? 'priority'}, owner ${opts?.owner ?? 'none'})`,
    );
    return point;
  }

  /**
   * Undefined rather than an empty point: "nobody defines this seam" and "nobody
   * has registered into it" are different facts, and the first one is a typo.
   */
  get<T>(id: string): ExtensionPoint<T> | undefined {
    return this.#points.get(id) as ExtensionPoint<T> | undefined;
  }

  /**
   * Who defined `id`, for a caller deciding whether it is allowed to see it.
   *
   * Undefined covers two cases on purpose — no such point, and a point defined
   * with no owner (the kernel's own, a test's) — because both mean the same thing
   * to the gate: there is no declared dependency that could authorize this.
   */
  ownerOf(id: string): string | undefined {
    return this.#points.get(id)?.owner;
  }

  ids(): readonly string[] {
    return [...this.#points.keys()];
  }

  /**
   * Every point an extension defined, gone.
   *
   * The host calls this when it tears an extension down, and it is not
   * belt-and-braces over `ctx.subscriptions`: an `activate` that defines a point
   * and *then* throws never reached the line that would have put it there, so
   * without this the rollback leaves the id taken and the retry dies on
   * `DuplicatePointError` — a failure whose message blames the wrong thing.
   */
  disposeOwnedBy(owner: string): void {
    // Snapshot: `dispose` deletes from the map we would otherwise be walking.
    for (const point of [...this.#points.values()]) {
      if (point.owner === owner) point.dispose();
    }
  }

  dispose(): void {
    for (const point of [...this.#points.values()]) point.dispose();
    this.#points.clear();
  }
}
