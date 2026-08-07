import { toDisposable, type Disposable, type ExtensionPoint, type Logger, type PointsAPI } from '@shepherd/sdk';

/**
 * The extension-point primitive — what makes **extensions platforms too**.
 *
 * VS Code's contribution points are core-owned, so a third-party extension
 * cannot offer a seam of its own without a fork. Here any extension defines one,
 * and the dogfood rule goes a level deeper: a built-in routes its own pluggable
 * decisions through its own points, so the stock behaviour is just the default
 * provider.
 *
 * Its first real consumer is **M2, not M3** (spec §7c): `agents-core` registers
 * vendor agent kinds through a point it defines, which is why `codex` and
 * `opencode` are extensions rather than a fork. So this ships as the primitive
 * plus its unit tests and **no artificial consumer** — building a fake one to
 * "prove" it would be building for a later milestone.
 *
 * Ownership is deliberately not tracked. `PointsAPI.get`'s doc says a point is
 * undefined when its owner is not active, and that holds because a point is a
 * `Disposable` an extension puts in `ctx.subscriptions`: the host disposes it on
 * deactivate, and `get` stops resolving. A second owner table here would be a
 * second source of truth about liveness.
 */

export class DuplicatePointError extends Error {
  /**
   * Declared and assigned rather than a constructor parameter property — Electron
   * runs our `.ts` on node's type stripping, which can only erase, so a parameter
   * property is a *launch* failure. `erasableSyntaxOnly` makes it a typecheck error.
   */
  readonly pointId: string;

  constructor(pointId: string) {
    super(
      `extension point "${pointId}" is already defined. ` +
        'Defining over it would silently take every provider its author registered with it.',
    );
    this.name = 'DuplicatePointError';
    this.pointId = pointId;
  }
}

export interface PointRegistryOptions {
  readonly logger: Logger;
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
  readonly #order: 'priority' | 'registration';
  readonly #log;
  readonly #onDispose: (id: string) => void;
  #registrations: Registration<T>[] = [];
  #seq = 0;
  #disposed = false;

  constructor(
    id: string,
    order: 'priority' | 'registration',
    log: ReturnType<Logger['child']>,
    onDispose: (id: string) => void,
  ) {
    this.id = id;
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

  define<T>(id: string, opts?: { readonly order?: 'priority' | 'registration' }): ExtensionPoint<T> {
    if (this.#points.has(id)) throw new DuplicatePointError(id);
    const point = new Point<T>(id, opts?.order ?? 'priority', this.#log, (disposedId) => {
      // Frees the id, which is what lets a dev-build reload re-define its points
      // instead of needing a restart.
      if (this.#points.get(disposedId) === (point as unknown as Point<unknown>)) this.#points.delete(disposedId);
    });
    this.#points.set(id, point as unknown as Point<unknown>);
    this.#log.debug(`defined extension point ${id} (order ${opts?.order ?? 'priority'})`);
    return point;
  }

  /**
   * Undefined rather than an empty point: "nobody defines this seam" and "nobody
   * has registered into it" are different facts, and the first one is a typo.
   */
  get<T>(id: string): ExtensionPoint<T> | undefined {
    return this.#points.get(id) as ExtensionPoint<T> | undefined;
  }

  ids(): readonly string[] {
    return [...this.#points.keys()];
  }

  dispose(): void {
    for (const point of [...this.#points.values()]) point.dispose();
    this.#points.clear();
  }
}
