import { basename } from 'node:path';
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { ProcessAPI } from '@shepherd/sdk';
import { planTrust, trustKeys } from './trust.ts';

/**
 * An incognito task's Claude profile: a `CLAUDE_CONFIG_DIR` that is born with
 * the task and dies with it.
 *
 * **What this buys.** Claude Code keeps everything about a session under its
 * config dir — `history.jsonl`, the per-project transcripts in `projects/`,
 * `settings.json`, `skills/`, `plugins/`, MCP servers. Point `CLAUDE_CONFIG_DIR`
 * somewhere new and a session both *starts* with none of that and *leaves* none
 * of it behind, because everything it writes is written in there. Deleting the
 * directory is therefore the whole teardown; there is nothing to scrub out of
 * the real profile because nothing ever reached it.
 *
 * **What it deliberately does not buy.** The session is still signed in as the
 * same person and still bills the same account — the credential is carried over
 * on purpose (see `credentials` below), because an agent that opens on *"Please
 * run /login"* is not an agent. This is privacy from the *machine*, not
 * anonymity from Anthropic, and describing it as the latter would be a lie.
 *
 * **Two things are carried in besides the flags, and they are not history.**
 * The Shepherd plugin, because its hooks are how the rail learns what the agent
 * is doing — a session Shepherd cannot see is not what "incognito" was asking
 * for, and the plugin reads the kernel's env and posts back rather than reading
 * anything of the user's. And the statusline, because a pane that loses its
 * model and its rate limits looks broken rather than private. Neither carries a
 * transcript, a skill, a permission or a preference.
 *
 * **Two flags are seeded, and only two.** A profile this new hits Claude Code's
 * trust dialog and its onboarding screen, and an agent that is waiting on a
 * keypress is not an agent — the same argument `trust.ts` makes at length, which
 * is why the plan here is built out of that module's pure half rather than a
 * second opinion about the record's shape. Nothing else is copied in: not
 * settings, not skills, not plugins, not identity. "Everything else is new" is
 * the feature.
 *
 * **Why we author this config where `trust.ts` refuses to.** `seedClaudeTrust`
 * will not create `~/.claude.json` — that file is the USER's, and a well-meaning
 * rewrite of one that will not parse discards their configuration. This file is
 * OURS: we made the directory a moment ago, we are its only writer, and it is
 * deleted when the task is. Creating it is not the same act.
 */

/**
 * Where an incognito profile lives, given `ctx.dataDir`.
 *
 * A dot-prefixed sibling of the task roots, beside `.archives` and `.prompts`,
 * for the reason those are: it is Shepherd's bookkeeping rather than anyone's
 * work. Being outside every task root and every worktree is also what keeps it
 * out of the editor's file tree and out of `git status` — a profile the user has
 * to look at is not one they have forgotten about.
 */
export function incognitoProfileDir(dataDir: string, taskId: string): string {
  return `${dataDir}/.incognito/${taskId}`;
}

/** The container the sweep enumerates. */
function profilesRoot(dataDir: string): string {
  return `${dataDir}/.incognito`;
}

export interface IncognitoOutcome {
  readonly ok: boolean;
  /** One line, already phrased for the log. */
  readonly detail: string;
}

/**
 * Materialize the profile and write the one file in it.
 *
 * Re-entrant on purpose: a restore re-provisions the task, and a second repo
 * joining it later needs its worktree trusted too. So an existing config is read
 * and merged rather than replaced — `planTrust` already merges into a project
 * entry for exactly this reason.
 *
 * `realpath` is injected for the same reason `trustKeys` takes it: the symlink
 * resolution Claude Code does is a property of the machine, not of this logic.
 */
export function seedIncognitoProfile(options: {
  readonly dir: string;
  readonly dirs: readonly string[];
  readonly realpath: (path: string) => string;
  /**
   * The `lastOnboardingVersion` to claim. Mirrored from the user's real config
   * at the call site when it can be read — it is an onboarding flag like
   * `hasCompletedOnboarding`, not something about the user — and omitted when it
   * cannot, since a missing version is not worth inventing.
   */
  readonly onboardingVersion?: string;
  /**
   * The OAuth credential, verbatim, as `.credentials.json` holds it.
   *
   * **Measured, against Claude Code 2.1.245.** The token is in the macOS
   * Keychain (`Claude Code-credentials`) and Shepherd would rather leave it
   * there — but the Keychain is read only for the DEFAULT config dir. Point
   * `CLAUDE_CONFIG_DIR` anywhere else and Claude Code looks for
   * `.credentials.json` inside it instead, so a profile without one is signed
   * out. Copying `oauthAccount`, or the whole of `~/.claude.json`, does not
   * change that; this is the only thing that does.
   *
   * The consequence is worth stating plainly: an incognito task puts a live
   * OAuth token in a file, at `0600`, under the user's own data dir, for as long
   * as the task exists. That is the same shape Claude Code itself uses where
   * there is no Keychain, it is deleted with the profile, and it is the price of
   * the session being usable at all.
   *
   * Optional: a Keychain that will not answer degrades to a profile that asks
   * for a login, which is a task the user can still see and still fix.
   */
  readonly credentials?: string;
  /**
   * The Shepherd Claude plugin, linked in so the agent reports itself.
   *
   * Shepherd tracks an agent through this plugin's hooks: the kernel injects
   * `SHEPHERD_SESSION_ID` and the socket paths into every session, and the
   * plugin's `report.sh` is what posts back. Without it an incognito task runs a
   * perfectly good Claude that the rail cannot see — no state mark, no
   * attention, no notification — which is a different feature from the one
   * anybody asked for.
   *
   * A SYMLINK rather than a copy. The plugin is read and never written, it
   * belongs to the app rather than to the profile, and a copy per task is a copy
   * to keep in step with the app it reports to.
   */
  readonly plugin?: string;
  /**
   * The user's `statusLine` setting, and nothing else out of their settings.
   *
   * Carried for the reason the plugin is: a pane whose status line has gone
   * blank reads as broken, not as private. It is a command that reads the JSON
   * Claude Code hands it on stdin — it neither reads nor writes a profile — so
   * carrying it leaks nothing. The rest of `settings.json` (the model, the
   * permissions, every other hook) stays behind, which is what "everything else
   * is new" means.
   */
  readonly statusLine?: unknown;
}): IncognitoOutcome {
  const file = `${options.dir}/.claude.json`;

  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
    // A profile of ours that will not parse is replaced rather than preserved —
    // the opposite of the rule for `~/.claude.json`, and for the opposite
    // reason: there is no user configuration in here to lose.
  } catch {
    // The ordinary path: the profile is new.
  }

  const keys = options.dirs.flatMap((dir) => trustKeys(dir, options.realpath));
  const config: Record<string, unknown> = {
    ...planTrust(existing, keys).config,
    hasCompletedOnboarding: true,
    ...(options.onboardingVersion === undefined ? {} : { lastOnboardingVersion: options.onboardingVersion }),
  };

  try {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (options.credentials !== undefined) {
      writeFileSync(`${options.dir}/.credentials.json`, options.credentials, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
    if (options.statusLine !== undefined) {
      writeFileSync(`${options.dir}/settings.json`, `${JSON.stringify({ statusLine: options.statusLine }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
    if (options.plugin !== undefined) {
      const skills = `${options.dir}/skills`;
      mkdirSync(skills, { recursive: true, mode: 0o700 });
      try {
        symlinkSync(options.plugin, `${skills}/${basename(options.plugin)}`);
      } catch {
        // Already linked by an earlier seed of this same profile — a restore
        // re-provisions, and a link that is already right is not a failure.
      }
    }
  } catch (error) {
    return {
      ok: false,
      detail: `could not seed the incognito profile at ${options.dir} — ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { ok: true, detail: `seeded an incognito profile at ${options.dir} trusting ${keys.length} path(s)` };
}

/**
 * Delete the profile, and with it the session's whole history.
 *
 * A profile that is not there is a success, not an error: teardown runs from
 * archive, from delete and from the startup sweep, and any of the three may
 * legitimately be second.
 */
export function removeIncognitoProfile(dir: string): IncognitoOutcome {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    return {
      ok: false,
      detail: `could not remove the incognito profile at ${dir} — ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true, detail: `removed the incognito profile at ${dir}` };
}

/**
 * The profiles no live task claims.
 *
 * This exists because teardown-on-archive is not a guarantee: a force-quit, a
 * crash or a `kill -9` ends the app without running any of it, and what would be
 * left is exactly the transcript the user asked not to keep. So the sweep runs
 * at activation and the invariant is restated rather than trusted — a profile
 * outlives its task by at most one launch.
 */
export function orphanProfiles(dataDir: string, liveTaskIds: readonly string[]): readonly string[] {
  const live = new Set(liveTaskIds);
  let entries: readonly string[];
  try {
    entries = readdirSync(profilesRoot(dataDir));
  } catch {
    // No profile has ever been made here. Nothing to sweep.
    return [];
  }
  return entries.filter((id) => !live.has(id)).map((id) => `${profilesRoot(dataDir)}/${id}`);
}

/**
 * The line an incognito task's agent runs, with the profile in front of it.
 *
 * **Why a shell line rather than the session's environment.** The seam that
 * should carry this is `sessions.onWillCreate`, and an extension cannot have it:
 * the hook is synchronous and the pty is spawned in the same tick, so it cannot
 * cross the extension host's message port — `packages/app/src/ext-host/api.ts`
 * refuses it in those words. The alternative was a persisted `env` on `Pane`,
 * which `pane.ts` argues against by construction ("a pane carries what the
 * layout needs and what survives a relaunch, and nothing else"). What is left is
 * the thing a pane already carries: a line typed into its shell. `tasks` already
 * builds the shell around a launch — `launch.ts` names the binary — so this is
 * that coupling one variable wider, not a new one.
 *
 * **`export`, not a one-shot prefix.** `VAR=x claude` would put the agent in the
 * profile and leave the pane's shell in the user's, so a second `claude` typed
 * into that same pane would write a transcript into the real profile — from
 * inside a task the user marked incognito. Exporting makes the whole shell
 * incognito, which is what the pane appears to promise.
 *
 * Single quotes, because the path is ours and contains no expansion worth
 * running. A path holding a single quote cannot be quoted this way, so it throws
 * rather than emitting a line that would run the wrong thing — an id and a data
 * dir never produce one, and a silent mis-quote here is a shell injection.
 */
export function incognitoCommand(line: string, dir: string): string {
  if (dir.includes("'")) {
    throw new Error(`an incognito profile path may not contain a single quote: ${dir}`);
  }
  const target = `export CLAUDE_CONFIG_DIR='${dir}'`;
  /*
   * No line to run is a real case, not a caller's mistake: a terminal task opens
   * a pane with nothing typed into it, and it still needs the export — a shell
   * without it would send the `claude` you type by hand into the profile this
   * whole mode exists to stay out of. The export alone is what that pane gets,
   * rather than a trailing `; ` nobody wrote.
   */
  return line.trim() === '' ? target : `${target}; ${line}`;
}

/**
 * The OAuth credential, read out of the macOS Keychain.
 *
 * The Keychain item Claude Code writes at login — one generic password under
 * `Claude Code-credentials`, holding the JSON that `.credentials.json` would
 * hold on a machine with no Keychain. Reading it is what lets an incognito
 * profile be signed in without the user logging in per task; see
 * `seedIncognitoProfile`'s `credentials` for why nothing else works.
 *
 * **Nothing is answered that is not JSON.** `security` prints to stdout, and a
 * warning, a prompt or a blank line would otherwise be written into the profile
 * AS the credential — which fails later, somewhere else, as a login screen with
 * no explanation. Parsing it here is the cheapest possible proof that what came
 * back is the thing we asked for.
 */
export async function claudeCredentials(process: ProcessAPI): Promise<string | undefined> {
  const out = await process.exec(['security', 'find-generic-password', '-s', KEYCHAIN_ITEM, '-w'], {
    cwd: '/',
    timeoutMs: 10_000,
  });
  if (!out.ok) return undefined;
  const raw = out.stdout.trim();
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** What Claude Code calls its Keychain entry. */
const KEYCHAIN_ITEM = 'Claude Code-credentials';
