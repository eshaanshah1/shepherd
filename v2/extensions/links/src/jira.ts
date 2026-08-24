import type { ExecErr, ExecOk, ExecOptions, ProcessAPI, SecretStore } from '@shepherd/sdk';
import { JIRA_TOKEN_SECRET_KEY } from './manifest.ts';

/**
 * An issue's summary, asked of the CLI first and a stored token second.
 *
 * The order and its reasoning are `github/src/token.ts`', copied deliberately:
 * almost everyone who would use this already has `acli` logged in, and a feature
 * whose first screen is "paste an API token" is a feature most people never turn
 * on. So the CLI answers, and the token is for the machine where it cannot.
 *
 * Everything is injected. That is what lets the whole chain be tested without a
 * network, a keychain or a subprocess — and it is the only reason the failure
 * cases below are covered at all, since each of them is a state that is a pain
 * to arrange for real.
 */

/**
 * Where a GUI app has to look, because its `PATH` is not a terminal's.
 *
 * The bare name LAST is the one that normally answers: the app harvests the
 * user's login-shell `PATH` at startup (ADR 0045), and `exec` composes one from
 * that. The explicit candidates stay for the machine where that harvest found
 * nothing, which is the case a fixed list was written for.
 */
export const ACLI_CANDIDATES = [
  '/opt/homebrew/bin/acli',
  '/usr/local/bin/acli',
  'acli',
] as const;

/**
 * Short, and a real decision.
 *
 * This runs on the way to filling in a label that is already drawn. The whole
 * chain sits under the caller's own deadline as well; this one exists so a
 * single hung candidate cannot eat it.
 */
const ACLI_TIMEOUT_MS = 2_500;

export interface JiraSource {
  readonly process: Pick<ProcessAPI, 'exec'>;
  readonly secrets: Pick<SecretStore, 'get'>;
  readonly fetch: typeof globalThis.fetch;
  /** `ctx.homeDir` — the child gets exactly what is named, so this is required. */
  readonly homeDir: string;
  /** `ctx.userName`, and without it a vendor CLI reports itself as logged out. */
  readonly userName: string;
  /** The host the URL named, so a second Atlassian site needs no second config. */
  readonly site: string;
}

/**
 * `acli --json` is not a contract — it prints an out-of-date warning on every
 * invocation and its shape is the vendor's to change — so this reads rather than
 * casts, and an unrecognised shape falls through to the next step.
 */
function readSummary(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const fields = (parsed as { fields?: unknown }).fields;
  if (typeof fields !== 'object' || fields === null) return null;
  const summary = (fields as { summary?: unknown }).summary;
  return typeof summary === 'string' && summary !== '' ? summary : null;
}

async function fromAcli(
  key: string,
  source: JiraSource,
  signal: AbortSignal,
): Promise<string | null> {
  /*
   * No `PATH` named here, on purpose. `exec` composes one — the standard
   * locations, then the app's own, which since startup is the user's login-shell
   * `PATH`. Naming one would REPLACE that with a fixed list and put this
   * extension back to knowing where tools live.
   */
  const options: ExecOptions = {
    cwd: source.homeDir,
    env: { HOME: source.homeDir, USER: source.userName },
    timeoutMs: ACLI_TIMEOUT_MS,
    signal,
  };

  for (const candidate of ACLI_CANDIDATES) {
    if (signal.aborted) return null;
    let run: ExecOk | ExecErr;
    try {
      run = await source.process.exec(
        [candidate, 'jira', 'workitem', 'view', key, '--fields', 'summary', '--json'],
        options,
      );
    } catch {
      // A candidate that does not exist is the common case here, not an
      // exception worth a log line per paste.
      continue;
    }
    if (!run.ok) continue;
    const summary = readSummary(run.stdout);
    // An exit of 0 whose output says nothing is `acli` present and logged out.
    // Keep looking: a second one on this machine may be the logged-in one.
    if (summary !== null) return summary;
  }
  return null;
}

async function fromRest(
  key: string,
  source: JiraSource,
  signal: AbortSignal,
): Promise<string | null> {
  let stored: string | undefined;
  try {
    stored = await source.secrets.get(JIRA_TOKEN_SECRET_KEY);
  } catch {
    // `secrets.get` throws for a DENIAL, which no retry fixes. This caller
    // cannot act on that: its job is to answer "is there a summary", and every
    // reason there is not one has the same answer.
    stored = undefined;
  }

  const pair = (stored ?? '').trim();
  // The FIRST colon: an Atlassian token is opaque and may contain one, and the
  // email cannot.
  const cut = pair.indexOf(':');
  if (cut <= 0 || cut === pair.length - 1) return null;

  try {
    const answer = await source.fetch(
      `https://${source.site}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`,
      {
        signal,
        headers: { Authorization: `Basic ${btoa(pair)}`, Accept: 'application/json' },
      },
    );
    if (!answer.ok) return null;
    return readSummary(await answer.text());
  } catch {
    return null;
  }
}

/**
 * The summary, or `null` for every way of not having one.
 *
 * `null` is a NORMAL answer rather than an error. The pill already carries its
 * fallback label by the time this is called, and a person pasting a link into a
 * brief did not ask this app to authenticate them — so nothing here reports
 * anything to the user, and the callers say so too.
 */
export async function resolveJira(
  key: string,
  source: JiraSource,
  signal: AbortSignal,
): Promise<string | null> {
  if (signal.aborted) return null;
  const viaCli = await fromAcli(key, source, signal);
  if (viaCli !== null) return viaCli;
  if (signal.aborted) return null;
  return fromRest(key, source, signal);
}
