import { s, toDisposable, type ActivateFn } from '@shepherd/sdk';
import { DIAGNOSTICS_COMMANDS, EXTENSIONS_LIST_COMMAND } from './manifest.ts';

/**
 * `shepherd.diagnostics` — the built-in you invoke to find out whether the
 * extension host is alive.
 *
 * It is a real tool rather than a fixture, and the distinction matters: a
 * fixture proves the wire on the day it is written, and this proves it on every
 * day after. `diagnostics.ping` is the thing to run when an extension has
 * stopped responding, and its answer distinguishes the three cases that look
 * identical from outside — a dead child (no answer at all), a child that is up
 * but never activated this extension (`unavailable`), and a healthy host
 * (facts, including the pid of the process they came from).
 *
 * It also has a job §7 gives every built-in: **consume the proposed API**, so
 * `api.proposed` has at least one caller that would break loudly if a group
 * changed shape. And a job §7b gives one of them: prove the permission model by
 * asking for something it never declared and reporting the refusal
 * (`diagnostics.probeDenied`).
 */

/** How many times this host has been pinged. The one thing worth persisting here. */
const PING_COUNT_KEY = 'pings';

interface HostFacts {
  readonly extensions: number;
  readonly commands: number;
  readonly childPid: number;
}

export const activate: ActivateFn = (ctx, api) => {
  const { commands, events, views } = api.proposed;
  const startedAt = ctx.clock.now();

  ctx.subscriptions.push(
    commands.register(DIAGNOSTICS_COMMANDS.ping, {
      title: 'Diagnostics: Ping the Extension Host',
      schema: s.nothing(),
      handler: async () => {
        // Through `ctx.storage`, which is this extension's one declared
        // capability — so a ping that answers also proves storage round-trips.
        const pings = (ctx.storage.get(PING_COUNT_KEY, s.number()) ?? 0) + 1;
        ctx.storage.set(PING_COUNT_KEY, pings);

        // The real command registry, reached from inside the utility process. A
        // failure here is reported rather than swallowed into a partial answer:
        // half a diagnostic is worse than none, because it reads as healthy.
        const facts = await commands.invoke<HostFacts>(EXTENSIONS_LIST_COMMAND);
        if (!facts.ok) {
          throw new Error(`could not read host facts: ${facts.error.code}: ${facts.error.message}`);
        }

        events.emit('diagnostics.pinged', { pings, at: ctx.clock.now() });

        return {
          api: api.version,
          extensions: facts.value.extensions,
          commands: facts.value.commands,
          /**
           * The OS process this answer was computed in. It is the only field here
           * that cannot be faked by a healthy-looking main process, which is why
           * a smoke asserts on it: services really do run in their own process
           * (sketch §7b), and a unit test cannot tell you that.
           */
          childPid: facts.value.childPid,
          uptimeMs: ctx.clock.now() - startedAt,
          pings,
        };
      },
    }),

    commands.register(DIAGNOSTICS_COMMANDS.probeDenied, {
      title: 'Diagnostics: Probe an Undeclared Capability',
      schema: s.nothing(),
      handler: async () => {
        // `attention.set` declares `permission: 'attention'`, and this extension's
        // manifest declares only `storage`. So this must come back as a typed
        // `denied` from the one authorizer in the dispatcher — not a crash, not a
        // silent no-op, and not a success.
        const attempt = await commands.invoke('attention.set', {
          target: 'diagnostics-probe',
          level: 'attention',
          reason: 'diagnostics is probing a capability it never declared',
        });

        if (attempt.ok) {
          // Reported, not thrown: "the probe was allowed" is a finding about the
          // permission model, and a throw here would look like a broken probe.
          ctx.log.error('probed attention.set without declaring it and was ALLOWED — the permission gate is open');
          return { probed: 'attention', denied: false, declared: [...ctx.permissions] };
        }

        return {
          probed: 'attention',
          denied: true,
          code: attempt.error.code,
          message: attempt.error.message,
          declared: [...ctx.permissions],
        };
      },
    }),
  );

  /**
   * A contributed tree — the trivial consumer P6's view mechanism is built
   * against, deliberately NOT the task tree.
   *
   * Building the mechanism against its real consumer would shape it around one
   * caller. Building it against a static two-item list would prove registration
   * and nothing else, so this exercises the three axes a real tree needs and a
   * static one does not: a row whose label CHANGES (via `onDidChange`), a row
   * carrying a `command` (which is where D14's attribution is enforced), and a
   * `tint` (a token name, resolved by the renderer — never a raw colour).
   */
  let ticks = 0;
  const listeners = new Set<() => void>();
  ctx.subscriptions.push(
    views.registerViewType('diagnostics.tree', {
      kind: 'tree',
      data: {
        children: (parent) =>
          Promise.resolve(
            parent === undefined
              ? [
                  { id: 'ticks', label: `ticks: ${ticks}`, tint: 'accent' },
                  {
                    id: 'ping',
                    label: 'click me — the count above goes up',
                    description: 'runs a command',
                    command: { id: 'diagnostics.bump' },
                  },
                ]
              : [],
          ),
        onDidChange: (fn) => {
          listeners.add(fn);
          return toDisposable(() => listeners.delete(fn));
        },
      },
    }),
  );

  /**
   * What the row's command does: change the tree.
   *
   * A timer was the first version and was wrong twice over — `Clock` has no
   * `setInterval` (it threw, and one bad extension being one bad extension took
   * the whole contribution with it), and a tree that changes on a schedule tests
   * change-propagation without testing the thing that usually causes it. A click
   * exercises the command path AND `onDidChange` together, deterministically.
   */
  ctx.subscriptions.push(
    commands.register('diagnostics.bump', {
      schema: s.nothing(),
      handler: () => {
        ticks += 1;
        for (const fn of listeners) fn();
        return { ticks };
      },
    }),
  );

  ctx.log.info(`ready — granted ${ctx.permissions.join(', ') || 'nothing'}, api ${api.version}`);
};
