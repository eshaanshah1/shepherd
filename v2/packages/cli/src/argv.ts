/**
 * `shepherd` — the agent API, as §7b decided it.
 *
 * "CLI-first, no MCP in v2.0 — agents in panes have Bash; the `shepherd` CLI +
 * skill is the agent API." So this is not a convenience wrapper over an API that
 * exists elsewhere; for an agent it *is* the API, and that is why it is a real
 * client rather than a skill that teaches `curl` with a hand-written JSON
 * envelope. Teaching the envelope would make the envelope the interface.
 *
 * It owns **no verbs**. `control-ingress` is a thin adapter over
 * `commands.invoke` and this is a thin adapter over that: a noun/verb pair maps
 * to a command id, flags become arguments, and `raw` passes any id through — so
 * a new command is reachable the day it is registered, without a release here.
 * The registry stays the one verb table.
 */

export type Caller =
  | { readonly kind: 'agent'; readonly sessionId: string }
  | { readonly kind: 'device'; readonly deviceId: string };

export type Parsed =
  | {
      readonly ok: true;
      readonly command: string;
      readonly args: Record<string, unknown>;
      readonly caller: Caller;
    }
  | { readonly ok: false; readonly error: string };

/** noun → verb → command id. The only table this file owns. */
const VERBS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  task: {
    new: 'tasks.create',
    list: 'tasks.list',
    spawn: 'tasks.spawn',
    archive: 'tasks.archive',
    restore: 'tasks.restore',
    delete: 'tasks.delete',
  },
  session: { list: 'sessions.list' },
  agent: { list: 'agents.list', 'quick-model': 'agents.quickModel' },
  'worktree-hook': {
    get: 'worktreeHook.get',
    set: 'worktreeHook.set',
    clear: 'worktreeHook.clear',
    'test-run': 'worktreeHook.testRun',
  },
};

/** Flags that may repeat, and what they accumulate into. */
const REPO_FLAG = 'repo';

/**
 * The one noun where `--repo` repeats.
 *
 * A task is 1..n repos, so `task new --repo a --repo b` accumulates. A hook
 * belongs to exactly one repo, and accumulating there would send a one-element
 * array to a schema expecting a string — rejected one process away, naming a
 * field nobody typed. Decided by noun rather than by "did it appear twice",
 * because the shape of an argument must not depend on how many were given.
 */
const REPO_REPEATS = 'task';

export function parseArgv(argv: readonly string[], env: Record<string, string | undefined> = {}): Parsed {
  const [noun, verb, ...rest] = argv;
  if (noun === undefined) {
    return fail(`nothing to do. Try: ${Object.keys(VERBS).map((n) => `shepherd ${n} …`).join(', ')}`);
  }

  // `raw <command.id>` — the escape hatch that keeps the registry authoritative.
  const command =
    noun === 'raw'
      ? verb
      : VERBS[noun]?.[verb ?? ''];
  if (noun !== 'raw' && VERBS[noun] === undefined) {
    return fail(`unknown noun "${noun}". Known: ${Object.keys(VERBS).join(', ')}`);
  }
  if (command === undefined || command === '') {
    const known = Object.keys(VERBS[noun] ?? {}).join(', ');
    return fail(`unknown verb "${verb ?? ''}" for "${noun}". Known: ${known}`);
  }

  const parsedArgs = parseFlags(rest, noun === REPO_REPEATS);
  if (!parsedArgs.ok) return parsedArgs;

  return {
    ok: true,
    command,
    args: parsedArgs.value,
    // An agent in a pane is a session, and the kernel authorizes it as one
    // (D9b) — which is what makes `tasks.spawn` scoped to its own task instead
    // of ambient. A human at a terminal is the local device.
    caller:
      env.SHEPHERD_SESSION_ID !== undefined && env.SHEPHERD_SESSION_ID !== ''
        ? { kind: 'agent', sessionId: env.SHEPHERD_SESSION_ID }
        : { kind: 'device', deviceId: 'local-cli' },
  };
}

function parseFlags(
  rest: readonly string[],
  repoRepeats: boolean,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const args: Record<string, unknown> = {};
  const repos: { path: string; name: string }[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] ?? '';
    if (!token.startsWith('--')) return fail(`expected a --flag, got "${token}"`);
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    let value: string;
    if (eq === -1) {
      const next = rest[i + 1];
      // A flag with no value must fail rather than send `undefined`: the schema
      // would reject it one process away, naming a field nobody typed.
      if (next === undefined || next.startsWith('--')) return fail(`--${name} needs a value`);
      value = next;
      i += 1;
    } else {
      value = token.slice(eq + 1);
    }

    if (name === REPO_FLAG && repoRepeats) {
      // The name is the basename, which is what the task root calls it and what
      // namespaces a skill collision.
      repos.push({ path: value, name: value.split('/').filter((p) => p !== '').pop() ?? value });
    } else {
      args[name] = value;
    }
  }

  if (repos.length > 0) args.repos = repos;
  return { ok: true, value: args };
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
