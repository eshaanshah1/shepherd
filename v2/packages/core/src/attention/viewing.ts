import { toDisposable, type CategoryLogger, type Disposable, type Logger, type PaneID, type RootID } from '@shepherd/sdk';
import type { LayoutStore } from '../layout/store.ts';

/**
 * "Is the user looking at this pane" — ONE predicate, in one place (ADR 0020).
 *
 * v1's hardest-won invariant. Everything downstream — a state machine's landing,
 * a dot, a banner, a chime, a phone push — threads the single value this resolver
 * produces rather than asking again with slightly different terms. Two visibility
 * checks that agree today are two that will disagree after the next change, and
 * v1 shipped exactly that: a turn finishing in front of you read "done" until you
 * clicked away and back, because the only clearing path fired on a focus *change*.
 *
 * So: no second `isVisible` anywhere, and nothing outside this file recomputes
 * front-ness from focus + zoom + overlay. Add an input here, not a caller there.
 */

export interface Presence {
  /** `NSApp.isActive` equivalent: is Shepherd the frontmost application. */
  readonly appActive: boolean;
  /** Which window is frontmost. `null` = none of ours is. */
  readonly focusedRoot: RootID | null;
  /** A full-takeover overlay (a workbench, a code surface) hides the terminal. */
  readonly overlay: boolean;
}

export class ViewingResolver {
  readonly #layout: LayoutStore;
  readonly #listeners = new Set<(pane: PaneID, viewing: boolean) => void>();
  /** Last announced value per live pane. The diff source, so nothing fires twice. */
  #snapshot: Map<PaneID, boolean>;
  #presence: Presence;
  #subscription: Disposable | undefined;
  readonly #log: CategoryLogger | undefined;

  constructor(layout: LayoutStore, presence: Presence, logger?: Logger) {
    this.#layout = layout;
    this.#presence = presence;
    this.#log = logger?.child('attention');
    this.#snapshot = this.#current();
    // A focus move, a zoom, a split or a close all change who is being looked at,
    // and none of them goes through `setPresence`.
    this.#subscription = layout.onDidChange(() => this.#reevaluate());
  }

  presence(): Presence {
    return this.#presence;
  }

  /**
   * On screen and focused: the focused pane of the frontmost window, not starved
   * by a zoomed sibling, not covered by a full-takeover overlay.
   *
   * Focus is read through `LayoutStore.focused`, which resolves a stale id to the
   * first leaf — caching it here would keep reporting a closed pane as front.
   */
  isFrontPane(pane: PaneID): boolean {
    const root = this.#presence.focusedRoot;
    if (root === null) return false;
    if (this.#presence.overlay) return false;
    // A zoomed pane IS front. Its siblings are starved to 0×0 and still mounted,
    // which is why this check has to exist at all: they are alive and focusable in
    // the model, and invisible on screen.
    const zoomed = this.#layout.zoomed(root);
    if (zoomed !== null && zoomed !== pane) return false;
    return this.#layout.focused(root) === pane;
  }

  /** `isFrontPane` plus Shepherd being frontmost — "they saw it". */
  isViewing(pane: PaneID): boolean {
    return this.#presence.appActive && this.isFrontPane(pane);
  }

  setPresence(next: Presence): void {
    this.#presence = next;
    this.#reevaluate();
  }

  onDidChangeViewing(fn: (pane: PaneID, viewing: boolean) => void): Disposable {
    this.#listeners.add(fn);
    return toDisposable(() => void this.#listeners.delete(fn));
  }

  dispose(): void {
    this.#subscription?.dispose();
    this.#subscription = undefined;
    this.#listeners.clear();
  }

  #current(): Map<PaneID, boolean> {
    const next = new Map<PaneID, boolean>();
    for (const root of this.#layout.roots()) {
      for (const pane of this.#layout.panes(root)) next.set(pane, this.isViewing(pane));
    }
    return next;
  }

  /**
   * Announce only what CHANGED. Firing for every pane on every layout event would
   * make each subscriber re-decide for panes nothing happened to — and a
   * subscriber that clears attention on the viewed edge would then clear it on any
   * unrelated rename.
   */
  #reevaluate(): void {
    const next = this.#current();
    const previous = this.#snapshot;
    this.#snapshot = next;

    // A pane that vanished while being viewed is announced `false` first: a
    // subscriber caching "they are looking at p2" must be told otherwise, or it
    // keeps suppressing alerts on behalf of a pane that no longer exists.
    for (const [pane, was] of previous) {
      if (!next.has(pane) && was) this.#fire(pane, false);
    }
    for (const [pane, is] of next) {
      if (previous.get(pane) !== is) this.#fire(pane, is);
    }
  }

  #fire(pane: PaneID, viewing: boolean): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(pane, viewing);
      } catch (error) {
        // One bad subscriber must not stop the fan-out, and must not be silent:
        // "alerts stopped being suppressed for the pane I am looking at" is not
        // something anyone discovers without a line naming it.
        this.#log?.error(`viewing listener threw: ${messageOf(error)}`);
      }
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
