import {
  err,
  ok,
  paneId,
  sessionId,
  toDisposable,
  KERNEL,
  USER,
  type AttentionLevel,
  type AttentionState,
  type Caller,
  type Disposable,
  type Logger,
  type NodeID,
  type PaneID,
  type Result,
  type RootID,
  type SessionID,
} from '@shepherd/sdk';
import type { EventBus } from '../events/bus.ts';
import type { LayoutStore } from '../layout/store.ts';
import { route, wantsAttention, type RoutingDecision } from './routing.ts';
import type { ViewingResolver } from './viewing.ts';

/**
 * One attention channel, aggregated.
 *
 * An extension says *how much* it needs you and *why*; core owns every
 * consequence — the dot, the dock badge, the ⌘⇧A ring, and (through `decide`) the
 * banner/chime/push. Core deliberately does not know what "blocked" means: that
 * meaning is `claude-code`'s, and keeping it there is what lets a second agent kind
 * exist without touching the kernel.
 *
 * v1 reached the same outcomes from `AgentState`, which every feature then wrote
 * to — and the nudge work had to grow a *second*, parallel channel unioned in at
 * the badge because writing `.blocked` onto a pane would have corrupted the hook
 * lifecycle map. Here there is one channel and no state enum to corrupt.
 *
 * Storage is canonically **by pane**. A caller may address a session instead and
 * it resolves through the layout; storing by session as well would mean two
 * entries for one pane the moment a session was rebound.
 */

/** Either handle a caller may use. Both id spaces are opaque strings at runtime. */
export type AttentionTarget = SessionID | PaneID | NodeID;

/**
 * A caller's string, on its way to `#resolve`, which decides which id space it
 * belongs to (sessions first). This cast is the honest form of "we cannot tell
 * these apart by looking".
 */
export const attentionTarget = (raw: string): AttentionTarget => paneId(raw);

export const ATTENTION_TOPIC = 'attention.changed';

export interface AttentionChanged {
  readonly pane: PaneID;
  readonly level: AttentionLevel;
  readonly reason: string;
}

export interface AttentionStoreOptions {
  readonly layout: LayoutStore;
  readonly viewing: ViewingResolver;
  readonly bus: EventBus;
  readonly logger: Logger;
}

export interface DecideOptions {
  /** Defaults to the pane's stored level. */
  readonly level?: AttentionLevel;
  /**
   * Presence-sensed "nobody is at this Mac". Passed in because M1 has no lid/display
   * sensor — v1's `PresenceMonitor` is AppKit and is not ported here.
   */
  readonly away?: boolean;
  readonly turnFinished?: boolean;
}

/** urgent > attention > info > none. The dot's priority, and the ring's. */
const RANK: Readonly<Record<AttentionLevel, number>> = { urgent: 3, attention: 2, info: 1, none: 0 };

export class AttentionStore {
  /** Insertion-ordered, which is what makes the ⌘⇧A ring stable within a level. */
  readonly #entries = new Map<PaneID, AttentionState>();
  readonly #listeners = new Set<() => void>();
  readonly #layout: LayoutStore;
  readonly #viewing: ViewingResolver;
  readonly #bus: EventBus;
  readonly #log;
  #subscriptions: Disposable[];

  constructor(options: AttentionStoreOptions) {
    this.#layout = options.layout;
    this.#viewing = options.viewing;
    this.#bus = options.bus;
    this.#log = options.logger.child('attention');

    this.#subscriptions = [
      // Clearing on focus, v1's table: need-to-check → idle on focus / select tab /
      // notification click / app becomes active. Only `attention` clears — see
      // `#clearedByViewing`.
      this.#viewing.onDidChangeViewing((pane, viewing) => {
        if (viewing) this.#clearedByViewing(pane);
      }),
      // Nothing else purges a closed pane's entry, and a badge counting a pane that
      // no longer exists can never be cleared by looking at it.
      this.#layout.onDidChange(() => this.#purge()),
    ];
  }

  // -------------------------------------------------------------------- mutation

  /**
   * `by` is the caller this attention is attributed to, and it is **threaded, not
   * invented**: the command registry already carries an attributed caller, and the
   * bus numbers sequences per source, so a wrong label pollutes another source's
   * counter. `USER` is the default because core setting attention on its own behalf
   * has no honest kind in the `Caller` union — there is no `kernel` — and inventing
   * one means editing `sdk/caller.ts`. Recorded as a follow-up rather than faked.
   */
  set(target: AttentionTarget, state: AttentionState, by: Caller = USER): Result<PaneID, string> {
    const pane = this.#resolve(target);
    if (pane === undefined) return this.#unroutable(target);

    // `none` IS a clear. One meaning for one level, so nothing has to remember
    // whether a level-none entry counts.
    if (state.level === 'none') {
      this.#drop(pane, state.reason, by);
      return ok(pane);
    }

    const previous = this.#entries.get(pane);
    if (previous && same(previous, state)) return ok(pane);
    this.#entries.set(pane, state);
    // Emitted on a LEVEL change only, per the API's contract. A reason-only edit
    // still reaches the chrome through `onDidChange`; putting it on the bus too
    // would make a re-worded prompt look like a new transition to anything
    // counting them.
    if (previous?.level !== state.level) this.#emit(pane, state.level, state.reason, by);
    this.#notify();
    return ok(pane);
  }

  clear(target: AttentionTarget, by: Caller = USER): Result<PaneID, string> {
    const pane = this.#resolve(target);
    if (pane === undefined) return this.#unroutable(target);
    this.#drop(pane, 'cleared', by);
    return ok(pane);
  }

  // --------------------------------------------------------------------- queries

  get(target: AttentionTarget): AttentionState | undefined {
    const pane = this.#resolve(target);
    return pane === undefined ? undefined : this.#entries.get(pane);
  }

  /**
   * The dock badge: every pane wanting attention, across EVERY root. A pane in a
   * window that is not frontmost still needs you — v1 aggregated over every pane of
   * every tab of every workspace for exactly this reason.
   *
   * `info` is excluded, and this is the same predicate `ring()` uses. That is the
   * decision: a badge ⌘⇧A cannot reach would be two sources of truth about "what
   * needs me", which is the class of divergence this kernel exists to remove.
   */
  count(): number {
    return this.ring().length;
  }

  /** The folder/tab dot: the single worst level in a root, `info` included. */
  aggregate(root: RootID): AttentionLevel {
    let worst: AttentionLevel = 'none';
    for (const pane of this.#layout.panes(root)) {
      const level = this.#entries.get(pane)?.level ?? 'none';
      if (RANK[level] > RANK[worst]) worst = level;
    }
    return worst;
  }

  /** The ⌘⇧A order: urgent first, then attention, insertion-stable within a level. */
  ring(): readonly PaneID[] {
    return [...this.#entries.entries()]
      .filter(([, state]) => wantsAttention(state.level))
      .sort((a, b) => RANK[b[1].level] - RANK[a[1].level])
      .map(([pane]) => pane);
  }

  /** The next pane in the ring, wrapping. A pane outside it starts at the front. */
  next(after?: PaneID): PaneID | undefined {
    const ring = this.ring();
    if (ring.length === 0) return undefined;
    if (after === undefined) return ring[0];
    const index = ring.indexOf(after);
    return index < 0 ? ring[0] : ring[(index + 1) % ring.length];
  }

  /**
   * Where a transition goes. **The viewing value is computed here, once**, and
   * threaded into the pure `route` — a caller must never ask the resolver itself
   * and pass its own answer in, which is how two visibility checks appear (ADR
   * 0020).
   */
  decide(pane: PaneID, opts: DecideOptions = {}): RoutingDecision {
    const level = opts.level ?? this.#entries.get(pane)?.level ?? 'none';
    const decision = route({
      level,
      viewing: this.#viewing.isViewing(pane),
      appActive: this.#viewing.presence().appActive,
      away: opts.away ?? false,
      turnFinished: opts.turnFinished ?? false,
    });
    // Say where it went and on what grounds. "I heard nothing on my phone" is
    // otherwise unanswerable: push is suppressed unless this Mac is away, and
    // without this nothing records which branch ran.
    this.#log.info(
      `pane=${pane} ${level} -> banner=${decision.banner} chime=${decision.chime} ` +
        `push=${decision.push} badge=${decision.badge} (${decision.reason})`,
    );
    return decision;
  }

  onDidChange(fn: () => void): Disposable {
    this.#listeners.add(fn);
    return toDisposable(() => void this.#listeners.delete(fn));
  }

  dispose(): void {
    for (const subscription of this.#subscriptions) subscription.dispose();
    this.#subscriptions = [];
    this.#listeners.clear();
  }

  // ------------------------------------------------------------------- internals

  /**
   * Sessions first, then panes. A `SessionID` and a `PaneID` are both branded
   * strings, so nothing may depend on being able to tell them apart by looking.
   * A target that resolves to no live pane is dropped **with a line**: an
   * unroutable set that says nothing is indistinguishable from attention that has
   * stopped working.
   */
  #resolve(target: AttentionTarget): PaneID | undefined {
    const raw = target as string;
    const viaSession = this.#layout.paneForSession(sessionId(raw));
    if (viaSession !== undefined) return viaSession;
    const pane = paneId(raw);
    return this.#layout.rootOf(pane) === undefined ? undefined : pane;
  }

  #unroutable(target: AttentionTarget): Result<PaneID, string> {
    const message = `no live pane for "${target as string}" — attention dropped`;
    this.#log.warn(message);
    return err(message);
  }

  /**
   * Only `attention` clears when you look at the pane. `urgent` does not: v1's
   * table says need-to-check → idle on focus, **never** blocked/working — looking
   * at a permission prompt is not answering it. `info` does not either: a condition
   * ends when the condition does (the conflict is resolved), not when you glance.
   *
   * The discriminator is the LEVEL, never the reason text. Reason is a human-facing
   * string; matching on it would repeat v1's "detect by EVENT, not detail" bug one
   * layer along. The mapping M2's `claude-code` inherits: a finished turn is
   * `attention`, a blocked turn is `urgent`.
   */
  #clearedByViewing(pane: PaneID): void {
    if (this.#entries.get(pane)?.level !== 'attention') return;
    // `user` is genuinely accurate here: the user's own gaze caused this clear.
    this.#drop(pane, 'viewed', USER);
  }

  #purge(): void {
    for (const pane of [...this.#entries.keys()]) {
      if (this.#layout.rootOf(pane) === undefined) this.#drop(pane, 'pane closed', KERNEL);
    }
  }

  #drop(pane: PaneID, reason: string, by: Caller): void {
    if (!this.#entries.delete(pane)) return;
    this.#emit(pane, 'none', reason, by);
    this.#notify();
  }

  #emit(pane: PaneID, level: AttentionLevel, reason: string, by: Caller): void {
    const payload: AttentionChanged = { pane, level, reason };
    this.#bus.emit(ATTENTION_TOPIC, payload, by);
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        // One bad subscriber must not stop the fan-out, and must not be silent.
        this.#log.error(`attention listener threw: ${messageOf(error)}`);
      }
    }
  }
}

function same(a: AttentionState, b: AttentionState): boolean {
  return a.level === b.level && a.reason === b.reason && a.color === b.color;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
