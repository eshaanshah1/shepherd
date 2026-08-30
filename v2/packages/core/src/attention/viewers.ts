import { toDisposable, type Disposable, type SessionID } from '@shepherd/sdk';

/**
 * WHO is looking at a session — ADR 0020's one predicate, generalised from a
 * boolean to a set (ADR 0052).
 *
 * ADR 0020's rule is that "is the user looking at this" has exactly one answer,
 * computed once and threaded everywhere, because two visibility checks that
 * agree today disagree after the next change. That rule is kept here, not
 * broken: this is not a second answer beside `ViewingResolver`, it is the same
 * answer with the client named. `ViewingResolver` still decides whether THIS
 * app's window is looking at a pane; it reports what it decided under its own
 * principal, and a phone reports what it decided under its own. Aggregation is
 * `isViewed`, and it is the only place anything asks "is anybody looking".
 *
 * The consequence that matters: **nothing may push for a session another client
 * is looking at.** A turn that finishes while your phone is open on it has been
 * seen, and a banner on the Mac is telling you something you already know.
 *
 * A principal, not a connection. A phone that reconnects is the same viewer it
 * was; a viewer keyed by connection would come back as a stranger and the set
 * would grow one entry per reconnect.
 */
export type PrincipalKey = string;

export class ViewerRegistry {
  /** session -> the principals currently looking at it. Empty sets are dropped. */
  readonly #bySession = new Map<SessionID, Set<PrincipalKey>>();
  readonly #listeners = new Set<(session: SessionID, viewers: readonly PrincipalKey[]) => void>();

  /**
   * A client's own answer about one session. Returns whether the SET changed —
   * a client re-reporting what it already said must not wake every subscriber,
   * and a phone reporting per frame is the ordinary case.
   */
  report(principal: PrincipalKey, session: SessionID, viewing: boolean): boolean {
    const current = this.#bySession.get(session);
    if (viewing) {
      if (current?.has(principal) === true) return false;
      const next = current ?? new Set<PrincipalKey>();
      next.add(principal);
      this.#bySession.set(session, next);
    } else {
      if (current === undefined || !current.has(principal)) return false;
      current.delete(principal);
      if (current.size === 0) this.#bySession.delete(session);
    }
    this.#fire(session);
    return true;
  }

  /**
   * A client is gone. Everything it claimed to be looking at stops being looked
   * at by it — otherwise a client that crashed mid-view suppresses that
   * session's alerts for the life of the process, which is a bug nobody can see.
   */
  forget(principal: PrincipalKey): readonly SessionID[] {
    const changed: SessionID[] = [];
    for (const [session, viewers] of [...this.#bySession]) {
      if (!viewers.delete(principal)) continue;
      if (viewers.size === 0) this.#bySession.delete(session);
      changed.push(session);
    }
    for (const session of changed) this.#fire(session);
    return changed;
  }

  viewersOf(session: SessionID): readonly PrincipalKey[] {
    return [...(this.#bySession.get(session) ?? [])];
  }

  /** The one aggregate. Nothing outside this class re-derives it. */
  isViewed(session: SessionID): boolean {
    return (this.#bySession.get(session)?.size ?? 0) > 0;
  }

  /** Every session somebody is looking at — what a holder walk needs. */
  viewed(): readonly SessionID[] {
    return [...this.#bySession.keys()];
  }

  onDidChange(fn: (session: SessionID, viewers: readonly PrincipalKey[]) => void): Disposable {
    this.#listeners.add(fn);
    return toDisposable(() => void this.#listeners.delete(fn));
  }

  #fire(session: SessionID): void {
    const viewers = this.viewersOf(session);
    for (const listener of [...this.#listeners]) listener(session, viewers);
  }
}
