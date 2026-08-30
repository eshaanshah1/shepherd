import { toDisposable, type CategoryLogger, type Disposable, type Logger, type SessionID } from '@shepherd/sdk';

/**
 * Who may end a session, and when — the decision ADR 0022 gave to `layout.close`
 * and ADR 0052 takes back.
 *
 * ADR 0022 was right while there was exactly one client: the layout was the only
 * thing that could point at a pty, so "the pane closed" and "nobody wants this
 * any more" were the same sentence, and making `layout.close` the one terminator
 * closed a real leak. With a second client they come apart. A phone watching an
 * agent, another window, a CLI reading its screen — each of them is a reason the
 * pty must outlive one client's decision to stop drawing it. The daemon has
 * always known this: it treats a disconnect as **detach, never kill**.
 *
 * So a pane close is a RELEASE — "this principal is done with it" — and this
 * class answers the only question that remains: does anybody ELSE hold it. If
 * not, it ends. If so, it lives, and the log says whose. Ending it anyway is
 * `terminate`, which is a verb somebody asks for rather than a side effect of a
 * gesture about a window.
 *
 * A holder is asked rather than told: a registry of holds would need every
 * holder to remember to give one back, and the layout already knows perfectly
 * well which sessions its panes show. Deriving beats bookkeeping — the failure
 * of a derived answer is a wrong answer now, the failure of bookkeeping is a
 * session held forever by a client that crashed.
 */

/**
 * Who is asking. One string per client: `app`, `device:<id>`, `cli`.
 *
 * A principal, not a connection: two windows of one app are one principal, and a
 * phone that reconnects is the same one it was. That is the granularity the
 * question is asked at — "is another CLIENT watching this" — and connection
 * identity would make a reconnect look like an abandonment.
 */
export type PrincipalKey = string;

/**
 * A reason a session is still wanted, asked whenever somebody lets go.
 *
 * It answers with PRINCIPALS rather than a boolean because one holder often
 * speaks for several: the viewer set is a single holder that may name a Mac and
 * two phones, and a `principal` field on the holder itself could not say which.
 */
export interface SessionHolder {
  /** Said in the log line, so a session that would not die can be explained. */
  readonly reason: string;
  principals(id: SessionID): readonly PrincipalKey[];
}

export interface SessionHold {
  readonly principal: PrincipalKey;
  readonly reason: string;
}

export interface ReleaseOutcome {
  readonly ended: boolean;
  /** The principals that kept it alive. Empty exactly when `ended`. */
  readonly heldBy: readonly PrincipalKey[];
}

export interface SessionLifetimeOptions {
  /**
   * What ending one actually means — `SessionHost.kill`, or the daemon's `kill`
   * frame. Injected rather than imported so this file has no opinion about where
   * the pty lives, which is the whole point of Stage 3.
   */
  readonly end: (id: SessionID) => void;
  readonly logger: Logger;
}

export class SessionLifetime {
  readonly #end: (id: SessionID) => void;
  readonly #holders = new Set<SessionHolder>();
  readonly #log: CategoryLogger;

  constructor(options: SessionLifetimeOptions) {
    this.#end = options.end;
    this.#log = options.logger.child('session');
  }

  addHolder(holder: SessionHolder): Disposable {
    this.#holders.add(holder);
    return toDisposable(() => void this.#holders.delete(holder));
  }

  /** Every principal that still wants this session, each named once. */
  holdersOf(id: SessionID, except?: PrincipalKey): readonly SessionHold[] {
    const found = new Map<PrincipalKey, SessionHold>();
    for (const holder of this.#holders) {
      let principals: readonly PrincipalKey[] = [];
      try {
        principals = holder.principals(id);
      } catch (error) {
        // A holder that cannot answer must not be able to strand a pty forever.
        // Treated as holding nothing — the direction that fails loudly — and
        // said out loud, because "the agent I closed is still running" is not
        // something anyone discovers without a line naming it.
        this.#log.error(`session holder "${holder.reason}" threw: ${messageOf(error)}`);
      }
      for (const principal of principals) {
        if (principal === except) continue;
        if (found.has(principal)) continue;
        found.set(principal, { principal, reason: holder.reason });
      }
    }
    return [...found.values()];
  }

  /**
   * One principal let go. The session ends **iff no other principal holds it**.
   *
   * `by` is excluded deliberately: the releasing client's own holds are what it
   * is in the middle of dropping, and the layout announces a close before its
   * viewing resolver has re-run. A principal cannot hold a session against
   * itself.
   */
  release(id: SessionID, by: PrincipalKey): ReleaseOutcome {
    const holders = this.holdersOf(id, by);
    if (holders.length === 0) {
      this.#log.info(`${by} released ${id}; nobody else holds it, so it ends`);
      this.#end(id);
      return { ended: true, heldBy: [] };
    }
    this.#log.info(
      `${by} released ${id}; it lives — held by ${holders.map((h) => `${h.principal} (${h.reason})`).join(', ')}`,
    );
    return { ended: false, heldBy: holders.map((h) => h.principal) };
  }

  /**
   * End it, whoever is watching. The verb `sessions.terminate` runs.
   *
   * Deliberately unconditional: a user who says "kill this agent" is not asking
   * whether their phone happens to be showing it. The check belongs to `release`,
   * which is a gesture about a *view*.
   */
  terminate(id: SessionID): void {
    this.#log.info(`terminating ${id}`);
    this.#end(id);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
