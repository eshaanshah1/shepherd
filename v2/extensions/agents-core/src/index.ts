import {
  s,
  toDisposable,
  type ActivateFn,
  type Disposable,
  type ExtensionContext,
  type SessionID,
  type Shepherd,
} from '@shepherd/sdk';
import { AGENT_KINDS_POINT, type AgentKind } from './kind.ts';
import { limiter, runComplete, MAX_CONCURRENT, type CompleteAnswer } from './complete.ts';
import { applyOverride, describeQuick, resolveQuick, type QuickOverride } from './quick-model.ts';
import { AgentRegistry, type AgentChange, type AgentRecord } from './registry.ts';
import { attentionFor } from './attention-map.ts';
import {
  AGENT_STATE_TOPIC,
  AGENTS_COMMANDS,
  QUICK_MODEL_KEY,
  SESSION_EXIT_TOPIC,
  SESSIONS_LIST_COMMAND,
  VIEWING_TOPIC,
} from './manifest.ts';

/**
 * `shepherd.agents-core` — the vendor-blind agent noun.
 *
 * It knows what an agent *is* (a session with a state that someone reports) and
 * nothing about what any agent *says*. A vendor registers a kind through the
 * `agents.kinds` point this defines; `claude-code` is one of those and has no
 * privileged path.
 *
 * The IO shell around `AgentRegistry`, which is where every decision lives.
 */

export type { AgentKind, AgentCapabilities, AgentDecision, AgentEventInput, AgentSlot } from './kind.ts';
export type { AgentRecord, AgentChange } from './registry.ts';
export { AGENT_KINDS_POINT } from './kind.ts';
export * from './state.ts';

/** How often the reconciliation sweep looks, while anything claims to be busy. */
export const SWEEP_INTERVAL_MS = 5_000;

/** What `claude-code` (or any vendor extension) gets from `extensions.get`. */
export interface AgentsAPI {
  /**
   * Register a vendor kind. A thin wrapper over the `agents.kinds` point — the
   * point is the registry and this is the convenience, so there is exactly one
   * list to consult and a kind registered either way sits in the same order.
   */
  registerKind(kind: AgentKind): Disposable;
  stateOf(sessionId: string): AgentRecord | undefined;
  /** The calling kind's own per-session state — see `AgentSlot`. */
  slotOf(sessionId: string): Record<string, unknown> | undefined;
  /** Fires when a turn ends — including the landing that reads `idle` (ADR 0020). */
  onTurnFinished(fn: (change: AgentChange) => void): Disposable;
}

interface SessionRow {
  readonly id: string;
  readonly hasForegroundProcess: boolean | null;
  readonly viewing: boolean | null;
}

/**
 * Reads the three fields this extension needs out of `sessions.list`, and
 * **ignores every other key**.
 *
 * Deliberately not `s.object`, which rejects unknown keys — correct for a
 * *command's arguments*, where an unexpected key means the caller misunderstood
 * the verb, and wrong for a command's *answer*, where it means the kernel is
 * newer than this extension. A strict schema here would reject every row the day
 * `sessions.list` grows a field, and the symptom would be an agent extension
 * that quietly tracks nothing. Messages stay additive (review §Bad-4); a reader
 * that made a new field fatal would be the same failure from the other side.
 *
 * A row missing what it needs is skipped rather than failing the batch, for the
 * same reason: one unreadable row must not cost the others.
 */
export function readSessionRows(value: unknown): readonly SessionRow[] {
  if (!Array.isArray(value)) return [];
  const rows: SessionRow[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row['id'] !== 'string') continue;
    rows.push({
      id: row['id'],
      hasForegroundProcess: triState(row['hasForegroundProcess']),
      viewing: triState(row['viewing']),
    });
  }
  return rows;
}

/** `true` / `false` / `null` = "not known". Anything else is not knowledge either. */
function triState(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export const activate: ActivateFn<AgentsAPI> = async (ctx: ExtensionContext, api: Shepherd) => {
  const { commands, events, points, attention } = api.proposed;
  const registry = new AgentRegistry();
  const kinds = points.define<AgentKind>(AGENT_KINDS_POINT, { order: 'priority' });
  ctx.subscriptions.push(kinds);

  const overrideSchema = s.stored({ kind: s.optional(s.string()), model: s.optional(s.string()) });
  /**
   * An unreadable override reads as "no override" rather than as a failure: it is
   * a preference, and refusing to ask a model because a preference blob is
   * malformed would be worse than having forgotten which model was chosen.
   */
  const readOverride = (): QuickOverride | undefined => ctx.storage.get(QUICK_MODEL_KEY, overrideSchema);
  const quickLimit = limiter(MAX_CONCURRENT);

  /**
   * Edges that arrive before the seed lands.
   *
   * `event.on` is fire-and-forget while `sessions.list` is a round-trip, so a
   * viewing edge can arrive after subscribing and before the snapshot — and
   * applying the snapshot afterwards would overwrite it with a staler value.
   * Buffer, apply the snapshot, then drain: the replay-then-live rule the pty
   * ring already follows, for the same reason.
   */
  let buffered: (() => void)[] | undefined = [];
  const afterSeed = (apply: () => void): void => {
    if (buffered === undefined) apply();
    else buffered.push(apply);
  };

  // ------------------------------------------------------------------ outputs

  const publish = (change: AgentChange): void => {
    const { level, reason } = attentionFor(change.to, change.reason);
    /**
     * The alert level rides the event, computed HERE and once.
     *
     * Both this emit and the `attention.set` below cross the port, in order — so
     * a consumer in main receives this event *before* the attention store has
     * taken the new level. A router that then asked the store "how urgent is
     * this pane" would read the PREVIOUS answer and route a finished turn as
     * whatever the last one was. Threading it is the same discipline `viewing`
     * follows: one computation, carried, never re-derived downstream.
     */
    events.emit(AGENT_STATE_TOPIC, { ...change, level, alertReason: reason });
    // `none` is a clear, and `attention.set` treats it as one — so there is no
    // branch here, which is the point: one mapping, one call, no second opinion
    // about when an agent stops needing you.
    // The registry keys by a plain string; attention takes the branded id. The
    // brand is compile-time only, so this is a re-labelling and not a conversion.
    attention.set(change.sessionId as unknown as SessionID, { level, reason });
    ctx.log.debug(`${change.sessionId} ${change.from} -> ${change.to} (${change.reason ?? 'no reason'})`);
  };
  ctx.subscriptions.push(toDisposable(registry.onDidChange(publish)));

  // ------------------------------------------------------------------- inputs

  const subscribedTopics = new Set<string>();
  const subscribeTo = (topic: string): void => {
    if (subscribedTopics.has(topic)) return;
    subscribedTopics.add(topic);
    ctx.log.info(`subscribed to ${topic}`);
    ctx.subscriptions.push(
      events.on(topic, (payload, envelope) => {
        // The session is the envelope's source, never a field in the payload: a
        // payload that names its own session is v1's `tab_id` lie in new clothes,
        // and the ingress already attributes every hook to the session that
        // posted it.
        if (envelope.source.kind !== 'agent') {
          ctx.log.warn(`ignored ${topic} from ${envelope.source.kind} — only a session may report agent state`);
          return;
        }
        const sessionId = envelope.source.sessionId as unknown as string;
        afterSeed(() => {
          const result = registry.handle(sessionId, topic, payload, kinds.all());
          if (result.change === undefined) {
            // Every branch that ends in "and then nothing happens" says why —
            // this is where a working ordering guard and a dead wire are told
            // apart.
            ctx.log.debug(`${topic} for ${sessionId} changed nothing: ${result.ignored ?? 'no reason given'}`);
          }
        });
      }),
    );
  };

  ctx.subscriptions.push(
    events.on(VIEWING_TOPIC, (payload) => {
      const view = payload as { sessionId?: string; viewing?: boolean };
      if (typeof view.sessionId !== 'string' || typeof view.viewing !== 'boolean') return;
      afterSeed(() => {
        // `true` is the edge that clears a finished turn you have now seen; the
        // registry decides whether that applies, so no second opinion here.
        if (view.viewing) registry.observeViewed(view.sessionId as string);
        else registry.setViewing(view.sessionId as string, false);
      });
    }),
  );

  ctx.subscriptions.push(
    events.on(SESSION_EXIT_TOPIC, (payload) => {
      const exit = payload as { sessionId?: string };
      if (typeof exit.sessionId !== 'string') return;
      // The exact signal, so a dead session's record and every kind's slot for it
      // go together rather than waiting for the sweep to infer it.
      afterSeed(() => void registry.forget(exit.sessionId as string));
    }),
  );

  // --------------------------------------------------------------- the snapshot

  const readSessions = async (): Promise<readonly SessionRow[]> => {
    const answer = await commands.invoke<unknown>(SESSIONS_LIST_COMMAND);
    if (!answer.ok) {
      ctx.log.warn(`${SESSIONS_LIST_COMMAND} failed: ${answer.error.code}: ${answer.error.message}`);
      return [];
    }
    const rows = readSessionRows(answer.value);
    if (rows.length === 0 && Array.isArray(answer.value) && answer.value.length > 0) {
      // Not the same as "there are no sessions", and the difference is the whole
      // point: this says the answer arrived and nothing in it was readable.
      ctx.log.warn(`${SESSIONS_LIST_COMMAND} answered ${answer.value.length} rows and none were readable`);
    }
    return rows;
  };

  // Seeds the viewing mirror from the same read the sweep uses. Deliberately not
  // a mechanism of its own: nothing in main knows when a child subscribes to a
  // topic, and this extension has to read the inventory anyway.
  for (const row of await readSessions()) {
    if (row.viewing !== null) registry.setViewing(row.id, row.viewing);
  }
  const queued = buffered ?? [];
  buffered = undefined;
  for (const apply of queued) apply();

  // ------------------------------------------------------------------- the sweep

  let timer: Disposable | undefined;
  const tick = async (): Promise<void> => {
    timer = undefined;
    for (const row of await readSessions()) {
      // `null` crosses the wire for "the tty could not be read", which is not
      // evidence of anything — the registry treats it as such.
      registry.observe(row.id, row.hasForegroundProcess ?? undefined);
      if (row.viewing !== null && !row.viewing) registry.setViewing(row.id, false);
    }
    schedule();
  };
  const schedule = (): void => {
    if (timer !== undefined) return;
    // Only while something claims to be busy: a window full of idle shells should
    // cost nothing, and a state that is not `working`/`blocked` cannot be wrong
    // in the direction this sweep corrects.
    if (!registry.list().some((record) => record.state === 'working' || record.state === 'blocked')) return;
    timer = ctx.clock.setTimeout(() => void tick(), SWEEP_INTERVAL_MS);
  };
  ctx.subscriptions.push(toDisposable(registry.onDidChange(() => schedule())));
  ctx.subscriptions.push(toDisposable(() => timer?.dispose()));
  schedule();

  // ----------------------------------------------------------------- the API

  ctx.subscriptions.push(
    commands.register(AGENTS_COMMANDS.list, {
      title: 'Agents: List Tracked Sessions',
      schema: s.nothing(),
      handler: () => ({ agents: registry.list() }),
    }),
  );

  ctx.subscriptions.push(
    commands.register(AGENTS_COMMANDS.resumeTarget, {
      title: 'Agents: Resume Target',
      schema: s.object({ sessionId: s.string() }),
      /**
       * Ask whichever kind adopted this session what would reattach to it.
       *
       * The value is the vendor's and stays opaque on the way through: this
       * extension does not read it either. `null` is a real answer and means
       * three different true things — nothing adopted the session, the kind
       * cannot resume, or it has not captured a target yet — and none of them
       * is an error, so none of them throws.
       */
      handler: (args) => {
        const record = registry.get(args.sessionId);
        const kind = kinds.all().find((candidate) => candidate.id === record?.kindId);
        const slot = registry.slotOf(args.sessionId);
        const resumeTarget = kind?.resumeTargetOf?.(slot) ?? null;
        return {
          sessionId: args.sessionId,
          kindId: record?.kindId ?? null,
          resumeTarget,
          /**
           * The whole command, so no consumer has to know the vendor's binary or
           * its flag (ADR 0036 §3). `resumeTarget` stays alongside it because a
           * caller may want to STORE the token and ask for the command later —
           * which is exactly what `tasks` does across an archive.
           */
          resumeCommand:
            resumeTarget === null ? null : (kind?.resumeCommandOf?.(resumeTarget) ?? null),
        };
      },
    }),
    commands.register(AGENTS_COMMANDS.resumeCommand, {
      title: 'Agents: Resume Command',
      schema: s.object({ target: s.string(), kindId: s.optional(s.string()) }),
      /**
       * Asked with a token captured earlier, when the session it came from no
       * longer exists — so it resolves the KIND by id rather than by session.
       *
       * With `kindId` absent it falls back to the only kind that declares
       * `capabilities.resume`, and refuses if that is ambiguous rather than
       * guessing: handing back the wrong vendor's command line would launch the
       * wrong agent against somebody's transcript id.
       */
      handler: (args) => {
        const resumable = kinds.all().filter((kind) => kind.capabilities?.resume === true);
        const kind =
          args.kindId === undefined
            ? resumable.length === 1
              ? resumable[0]
              : undefined
            : resumable.find((candidate) => candidate.id === args.kindId);
        if (kind === undefined) {
          ctx.log.warn(
            `no resumable kind for ${args.kindId ?? '(unspecified)'} — ${resumable.length} candidate(s)`,
          );
          return { command: null };
        }
        return { command: kind.resumeCommandOf?.(args.target) ?? null };
      },
    }),
    commands.register(AGENTS_COMMANDS.complete, {
      title: 'Agents: Ask the Quick Model',
      /**
       * The one grant this seam needs, and the reason it is a command: the
       * dispatcher checks this before the handler runs. As a method on the API
       * this extension exports, it could not be checked at all.
       */
      permission: 'agents',
      schema: s.object({
        prompt: s.string(),
        system: s.optional(s.string()),
        timeoutMs: s.optional(s.int()),
      }),
      /**
       * Never throws and never hangs: every failure is one of four reasons, and
       * the deadline is the caller's. A model call is the most tempting place in
       * the app to forget both.
       */
      handler: async (args): Promise<CompleteAnswer> => {
        const override = readOverride();
        const target = resolveQuick(kinds.all(), override);
        if (target === undefined) {
          // The two are different mistakes and read differently: nothing is
          // installed, versus what you chose is not what is installed.
          const message =
            override?.kind === undefined
              ? 'no registered agent kind offers a headless half'
              : `the configured kind "${override.kind}" offers no headless half`;
          ctx.log.info(`quick model: no-kind — ${message}`);
          return { ok: false, reason: 'no-kind', message };
        }
        const answer = await quickLimit(() =>
          runComplete(
            {
              process: api.proposed.process,
              clock: ctx.clock,
              dataDir: ctx.dataDir,
              homeDir: ctx.homeDir,
              userName: ctx.userName,
            },
            target,
            args,
          ),
        );
        // `info`, not `warn`: an unavailable model is not a fault of whoever
        // asked, and this extension's warn channel is for things a user can act
        // on.
        if (!answer.ok) ctx.log.info(`quick model: ${answer.reason} — ${answer.message}`);
        return answer;
      },
    }),
    commands.register(AGENTS_COMMANDS.quickModel, {
      title: 'Agents: Quick Model',
      schema: s.object({
        kind: s.optional(s.string()),
        model: s.optional(s.string()),
        clear: s.optional(s.boolean()),
      }),
      /**
       * One verb for read, set and clear, because from a terminal they are one
       * question: `shepherd agent quick-model` shows it, the same line with a
       * flag changes it.
       */
      handler: (args) => {
        const next = applyOverride(readOverride(), args);
        if (next === undefined) ctx.storage.delete(QUICK_MODEL_KEY);
        else ctx.storage.set(QUICK_MODEL_KEY, next);
        return describeQuick(kinds.all(), next);
      },
    }),
  );

  // Deliberately does not count topics: a kind subscribes them when it registers,
  // which happens after this line, so any number here would read as a fault
  // ("0 agent topics") while being momentarily true. A count that is only ever
  // right for an instant is worse than no count.
  ctx.log.info(`ready — sweep every ${SWEEP_INTERVAL_MS}ms; agent topics arrive as kinds register`);

  return {
    registerKind(kind) {
      for (const topic of kind.topics) subscribeTo(topic);
      return kinds.register(kind);
    },
    stateOf: (sessionId) => registry.get(sessionId),
    slotOf: (sessionId) => registry.slotOf(sessionId),
    onTurnFinished(fn) {
      return toDisposable(
        registry.onDidChange((change) => {
          if (change.turnFinished) fn(change);
        }),
      );
    },
  };
};

/**
 * What `agents.stateChanged` carries.
 *
 * `level`/`alertReason` are `attentionFor(to, reason)` computed at the moment of
 * the transition. They are on the wire rather than looked up because the emit
 * and the `attention.set` that follows it are two ordered crossings of one port:
 * a consumer reading the store on receipt sees the state from *before* this
 * change.
 */
export interface AgentStateChanged extends AgentChange {
  readonly level: 'none' | 'info' | 'attention' | 'urgent';
  readonly alertReason: string;
}
