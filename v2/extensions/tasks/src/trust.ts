import { readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * Pre-trusting the directories this extension generates, so a spawned agent
 * starts working instead of waiting on a dialog.
 *
 * ADR 0029 left "the interactive trust dialog is unmeasured" as an open
 * question. It is measured now, and it blocks: a task root is a directory that
 * did not exist a second ago, so `claude` opens on *"Quick safety check: Is this
 * a project you created or one you trust?"* and waits for a keypress. An agent
 * that cannot start unattended is not an agent, and every task this extension
 * creates hits it.
 *
 * **What was measured**, against Claude Code 2.1.226:
 *
 *   - Trust is a per-directory record in the global config file —
 *     `projects["<dir>"].hasTrustDialogAccepted === true`, read out of
 *     `~/.claude.json`. Strictly `=== true`; anything else is untrusted.
 *   - The key is the directory path, normalized and resolved through symlinks.
 *   - There is no flag, no env var and no project-local file that does this.
 *     Claude Code's own self-hosted runner writes exactly this record for the
 *     workspaces it generates, which is the same act for the same reason.
 *
 * **Why writing it is honest rather than a bypass.** The dialog asks whether the
 * user created or trusts this directory. Shepherd created it, seconds ago, out
 * of the repos the user picked in the composer, in response to the user asking
 * for this task. The answer is known and it is yes, so recording it is a
 * statement of fact. What we must not do is answer a question we do NOT know the
 * answer to, and that is why this is narrow: it names the exact directories this
 * extension materialized and nothing else. Never a blanket flag, never the
 * source repos, and never `--dangerously-skip-permissions`, which is a different
 * decision entirely (it turns off the per-tool permission prompts the user still
 * wants) and is not this one.
 */

/** The record Claude Code's own trust dialog writes when you accept it. */
const TRUSTED = { hasTrustDialogAccepted: true } as const;

/**
 * Where the trust store lives, given a home directory.
 *
 * **`CLAUDE_CONFIG_DIR` moves this file and we do not follow it**, because an
 * extension cannot read the environment and v2 has no profiles feature for the
 * host to resolve one from. The degradation is inert rather than wrong: a user
 * who has moved their config dir gets the trust prompt they get today, and the
 * record we wrote sits in the default config describing a directory Shepherd
 * really did generate. The path is logged on every seed so a mismatch is one
 * log line rather than a mystery. When v2 grows profiles, this takes the
 * resolved config dir instead of composing one.
 */
export function claudeConfigFile(homeDir: string): string {
  return `${homeDir}/.claude.json`;
}

/**
 * Every key that could name `dir` in the trust store.
 *
 * Claude Code resolves the directory through symlinks before looking it up, and
 * NFC-normalizes it. We cannot see which form it will land on from here — that
 * depends on the machine's filesystem — so both are written, which is what
 * Claude Code's own runner does when it seeds trust for a generated workspace.
 * Two keys for one directory is a cheap way to not care.
 *
 * `realpath` is injected so the shape can be tested without a filesystem that
 * happens to have the right symlinks in it.
 */
export function trustKeys(dir: string, realpath: (path: string) => string): readonly string[] {
  const forms = new Set<string>();
  forms.add(dir.normalize('NFC'));
  try {
    forms.add(realpath(dir).normalize('NFC'));
  } catch {
    // The directory is not there. Not an error worth reporting from a key
    // derivation — the caller's write is simply about a path that does not
    // exist, and the literal form is still the right key for it.
  }
  return [...forms];
}

export interface TrustPlan {
  /** The config to write. The same object, mutated, when nothing changed. */
  readonly config: Record<string, unknown>;
  /** Keys this plan turns on. */
  readonly added: readonly string[];
  /** Keys that already said yes — a re-provision, or the user did it by hand. */
  readonly already: readonly string[];
  /**
   * Keys whose existing entry is not an object and was therefore left alone.
   *
   * Refusing to overwrite it is the point: whatever it is, it is not ours to
   * reshape, and Claude Code reading `?.hasTrustDialogAccepted` off it already
   * answers "untrusted" — so the cost of leaving it is the prompt, and the cost
   * of replacing it is destroying something we do not understand.
   */
  readonly skipped: readonly string[];
}

/**
 * The whole decision, pure: what a config becomes once these keys are trusted.
 *
 * It **merges into the existing project entry** rather than replacing it. An
 * entry carries `allowedTools`, MCP server lists and onboarding flags, and a
 * task root that is re-provisioned after a restore must not lose them.
 */
export function planTrust(config: Record<string, unknown>, keys: readonly string[]): TrustPlan {
  const raw = config['projects'];
  // A missing `projects` is the ordinary case on a config that has never opened
  // a project. A `projects` that is not an object is not, and replacing it would
  // discard whatever it is — so nothing is planned against it.
  const projects: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const added: string[] = [];
  const already: string[] = [];
  const skipped: string[] = [];
  for (const key of keys) {
    const entry = projects[key];
    if (entry === undefined) {
      projects[key] = { ...TRUSTED };
      added.push(key);
      continue;
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      skipped.push(key);
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record['hasTrustDialogAccepted'] === true) {
      already.push(key);
      continue;
    }
    projects[key] = { ...record, ...TRUSTED };
    added.push(key);
  }

  return { config: { ...config, projects }, added, already, skipped };
}

export interface SeedOutcome {
  readonly ok: boolean;
  /** One line, already phrased for the log. */
  readonly detail: string;
}

/**
 * Read, plan, write — the half that touches another program's file.
 *
 * Three rules, and each is about the fact that this file is **not ours**:
 *
 *   - **A file we cannot read or parse is left alone.** No trust record is worth
 *     replacing a user's settings with a fresh object, and a config that will
 *     not parse is one where a well-meaning rewrite discards everything. The
 *     agent gets the prompt; the user keeps their configuration. Same answer for
 *     a config that is not there at all: a machine that has never run Claude
 *     Code has no agent to unblock.
 *   - **The write is atomic** — a temp file beside it, then `rename`. A torn
 *     `~/.claude.json` breaks every Claude Code session on the machine, which is
 *     far worse than the prompt this exists to avoid, and a partial write is the
 *     one failure mode a plain `writeFileSync` really can produce.
 *   - **It cannot merge a concurrent edit**, and neither can Claude Code, which
 *     read-modify-writes this file the same way. The window is one parse and one
 *     write wide, and what a lost update costs is *this* trust record — so the
 *     visible consequence is the dialog we were trying to skip, not damage.
 *     A lock nothing else takes would buy nothing.
 *
 * `0o600` on the temp file because that is the mode the real one carries, and
 * `rename` keeps the mode of the file it moves rather than the one it replaces.
 */
export function seedClaudeTrust(options: {
  readonly homeDir: string;
  readonly dirs: readonly string[];
  /**
   * What makes the temp file's name unique. Injected — `ctx.clock.now()` at the
   * call site — because an extension has no `process.pid` to reach for and no
   * clock of its own to invent one from.
   */
  readonly nonce: number;
}): SeedOutcome {
  const file = claudeConfigFile(options.homeDir);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      detail: `left ${file} alone — ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, detail: `left ${file} alone — its top level is not an object` };
  }

  const keys = options.dirs.flatMap((dir) => trustKeys(dir, realpathSync));
  const plan = planTrust(parsed as Record<string, unknown>, keys);
  if (plan.added.length === 0) {
    return {
      ok: true,
      detail: `${file} already trusted ${plan.already.length} path(s)${
        plan.skipped.length === 0 ? '' : `, left ${plan.skipped.length} unrecognisable entr(ies) alone`
      }`,
    };
  }

  // Beside the real file rather than in a temp directory: `rename` is only
  // atomic within one filesystem, and `~` and `/tmp` are not always the same one.
  const scratch = `${file}.shepherd-${String(options.nonce)}.tmp`;
  try {
    writeFileSync(scratch, `${JSON.stringify(plan.config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(scratch, file);
  } catch (error) {
    try {
      unlinkSync(scratch);
    } catch {
      // Nothing to clean up, or nothing we can do about it. The real file is
      // untouched either way, which is the property that matters.
    }
    return {
      ok: false,
      detail: `could not write ${file} — ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    ok: true,
    detail: `trusted ${plan.added.length} generated path(s) in ${file}: ${plan.added.join(', ')}`,
  };
}
