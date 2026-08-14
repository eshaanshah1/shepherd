import type { ExecOptions, ProcessAPI, SecretStore } from '@shepherd/sdk';
import { TOKEN_SECRET_KEY } from './manifest.ts';

/**
 * How this extension gets a token, and why it asks `gh` before it asks you.
 *
 * Almost everyone who would use this already has `gh` logged in, and a feature
 * whose first screen is "paste a personal access token" is a feature most people
 * do not turn on. So the order is:
 *
 *   1. `gh auth token` — zero configuration, and the credential is already
 *      scoped, already refreshed, and already revocable somewhere the user knows
 *   2. this extension's own secret, from the keychain — for a machine with no
 *      `gh`, or a `gh` logged into the wrong account
 *
 * and never an environment variable: `GH_TOKEN` in a shell profile is a
 * credential the app would pick up without anybody deciding it should.
 *
 * ── the two things measured here ─────────────────────────────────────────────
 *
 * **`exec` REPLACES the child's environment** rather than merging it, so a
 * program run through it gets exactly what is named below. `HOME` and `PATH` are
 * not enough: a vendor CLI handed only those reports itself as logged out, in
 * about two seconds, which is indistinguishable from a machine nobody signed in
 * on. `USER` is what a keychain lookup needs, and `ctx.userName` exists for this.
 *
 * **A GUI app inherits a minimal PATH**, so `gh` is not on it. v1 learned this
 * and its answer is copied here: probe the two places Homebrew puts things, then
 * `/usr/bin`, and only then fall back to the name and let `PATH` try. Probing by
 * running the candidate is deliberate — `stat` on a path we may not be allowed
 * to read answers the wrong question.
 *
 * That last paragraph is now belt to the app's braces, and deliberately kept.
 * The app harvests the user's login-shell `PATH` at startup
 * (`platform/darwin/shell-env.ts`), so the bare `gh` at the end of the list is
 * the one that normally answers — including for a `gh` installed somewhere no
 * fixed list would name. The explicit candidates stay because this extension
 * must still work when that harvest found nothing, which is the case the fixed
 * list was written for.
 */

/** Where a GUI app has to look, because its `PATH` is not a terminal's. */
const GH_CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', 'gh'] as const;

export interface TokenEnvironment {
  readonly homeDir: string;
  readonly userName: string;
}

export interface TokenSource {
  readonly process: ProcessAPI;
  readonly secrets: SecretStore;
  readonly env: TokenEnvironment;
  /** A directory to run `gh` in. Any real one; `gh auth token` is not repo-scoped. */
  readonly cwd: string;
}

/** Where the token came from, so the settings page and the log can say. */
export type TokenOrigin = 'gh' | 'secret';

export interface Token {
  readonly value: string;
  readonly origin: TokenOrigin;
}

/*
 * The key itself lives in `manifest.ts`, beside the DECLARATION that makes it
 * exist. Two spellings of one key is a store that silently holds nothing: the
 * host refuses a write to an undeclared key, so a drifted constant here would
 * fail on write and answer `undefined` on read, with nothing connecting the two.
 */
export { TOKEN_SECRET_KEY } from './manifest.ts';

/**
 * A short deadline, and it is a real decision.
 *
 * `gh auth token` is a local read of a config file in the normal case and a
 * keychain prompt in the abnormal one. Nothing here may wait on the second: this
 * runs on the way to drawing a pane, and a keychain dialog that appears because
 * the app asked in the background is worse than no PRs.
 */
const GH_TIMEOUT_MS = 3_000;

export async function resolveToken(source: TokenSource): Promise<Token | null> {
  const fromGh = await ghToken(source);
  if (fromGh !== null) return { value: fromGh, origin: 'gh' };

  /*
   * The keychain is asked inside a `try`, and it stays that way now that the
   * store is real.
   *
   * `secrets.get` throws for a denial — a manifest missing the `secrets`
   * permission, which no retry fixes — and that is the right shape for the
   * caller who can act on it. This caller cannot: its job is to answer "is
   * there a token", and every reason there is not one has the same answer.
   *
   * Measured before the store existed, and the reason this is written down: a
   * rejection from here escaped as an unhandled promise and took the extension
   * host with it, on the path whose entire purpose is to say "no token".
   */
  let stored: string | undefined;
  try {
    stored = await source.secrets.get(TOKEN_SECRET_KEY);
  } catch {
    stored = undefined;
  }
  const trimmed = stored?.trim() ?? '';
  return trimmed === '' ? null : { value: trimmed, origin: 'secret' };
}

async function ghToken(source: TokenSource): Promise<string | null> {
  /*
   * No `PATH` named here, on purpose. `exec` composes one — the standard
   * locations, then whatever the app's own `PATH` is, which since startup is the
   * user's login-shell `PATH`. Naming one would REPLACE that with a fixed list
   * and put this extension back to knowing where tools live, which is a rule
   * every extension author would then have to remember.
   */
  const options: ExecOptions = {
    cwd: source.cwd,
    env: { HOME: source.env.homeDir, USER: source.env.userName },
    timeoutMs: GH_TIMEOUT_MS,
  };

  for (const candidate of GH_CANDIDATES) {
    const result = await source.process.exec([candidate, 'auth', 'token'], options);
    if (!result.ok) continue;
    const token = result.stdout.trim();
    // An exit of 0 with nothing on stdout is `gh` present and logged out. Keep
    // looking: a second `gh` on this machine may be the logged-in one.
    if (token !== '') return token;
  }
  return null;
}
