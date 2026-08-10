import { mkdirSync } from 'node:fs';
import type { Clock, ProcessAPI } from '@shepherd/sdk';
import type { QuickTarget } from './quick-model.ts';

/**
 * Asking a model something — the `complete` half of §7c's headless seam, and the
 * only file in this extension that runs a program.
 *
 * It exists so an extension author who wants one smart feature does not write
 * their own spawn plumbing. Everything a vendor knows lives in its kind's
 * `headless` half; everything about *how a call is run* lives here, because the
 * alternative — measured in §7c's own argument — is every kind reimplementing the
 * deadline, the cap and the environment, each of them differently.
 *
 * **The environment is an allow-list, and that is not a precaution.** `runExec`
 * REPLACES the environment rather than merging it (`platform/darwin/src/exec.ts`:
 * "the caller's env is kept exactly as given except for PATH"); only `runGit`
 * merges. So a child inherits nothing unless it is named here — which is the safe
 * direction. `SHEPHERD_TAB_ID` and `SHEPHERD_SOCK` cannot leak into a nested
 * agent and have its lifecycle reported as some pane's, because they are not
 * there at all, rather than because somebody remembered a deny-list.
 */

/** Long enough for a cold vendor CLI; short enough that nothing waits forever. */
export const QUICK_TIMEOUT_MS = 15_000;

/** A quick answer is a handful of words. Anything more is a runaway. */
export const MAX_STDOUT_BYTES = 4_096;

/**
 * Two at once.
 *
 * Per host rather than per caller: the cap exists because this spends the user's
 * model budget, and a share per caller would make the total "however many
 * extensions are installed".
 */
export const MAX_CONCURRENT = 2;

export type CompleteAnswer =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly reason: 'no-kind' | 'timeout' | 'failed' | 'empty';
      readonly message: string;
    };

export interface CompleteInput {
  readonly prompt: string;
  readonly system?: string;
  /** The CALLER's deadline (ADR 0030). Defaults to `QUICK_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

export interface CompleteDeps {
  readonly process: ProcessAPI;
  readonly clock: Clock;
  /** This extension's own directory — a neutral cwd, never a repo. */
  readonly dataDir: string;
  readonly homeDir: string;
  readonly userName: string;
}

/**
 * Everything the child gets, and nothing else.
 *
 * `HOME` alone is not enough, and the way it fails is the reason this is a named
 * function with a test: measured, a vendor CLI handed only `HOME` and `PATH`
 * answers "Not logged in · Please run /login" in about two seconds. That is
 * indistinguishable from a machine nobody ever signed in on. `USER` is what its
 * credential lookup needs, and `LOGNAME` is not a substitute for it.
 *
 * `PATH` is deliberately absent: `runExec` composes its own from the standard
 * locations plus the inherited one, because a GUI-launched app inherits launchd's.
 */
export function childEnv(homeDir: string, userName: string): Record<string, string> {
  return { HOME: homeDir, USER: userName };
}

/** At most `max` at once, in arrival order. Frees its slot even on a throw. */
export function limiter(max: number): <T>(job: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await job();
    } finally {
      active -= 1;
      // A slot leaked on failure would throttle this to nothing after a few
      // broken calls, and the symptom would be a feature that stops working
      // later, for no visible reason.
      waiting.shift()?.();
    }
  };
}

export async function runComplete(
  deps: CompleteDeps,
  target: QuickTarget,
  input: CompleteInput,
): Promise<CompleteAnswer> {
  // `dataDir` is not created for you (`ExtensionContext`), and a cwd that does
  // not exist fails inside spawn with an errno rather than with a sentence.
  mkdirSync(deps.dataDir, { recursive: true });

  const timeoutMs = input.timeoutMs ?? QUICK_TIMEOUT_MS;
  const argv = target.kind.headless.argv({
    prompt: input.prompt,
    model: target.model,
    ...(input.system === undefined ? {} : { system: input.system }),
  });

  const started = deps.clock.now();
  const run = await deps.process.exec([...argv], {
    cwd: deps.dataDir,
    timeoutMs,
    env: childEnv(deps.homeDir, deps.userName),
  });

  if (!run.ok) {
    const elapsed = deps.clock.now() - started;
    return {
      ok: false,
      reason: elapsed >= timeoutMs ? 'timeout' : 'failed',
      message: run.stderr.trim() || `${argv[0] ?? 'the agent'} exited ${run.code}`,
    };
  }

  const text = target.kind.headless.parse(run.stdout.slice(0, MAX_STDOUT_BYTES));
  if (text === undefined || text.trim() === '') {
    return { ok: false, reason: 'empty', message: 'the model returned nothing usable' };
  }
  return { ok: true, text: text.trim() };
}
