# ADR 0045 (v2) — the app's PATH is harvested from the user's login shell

**Status:** accepted · 2026-08-14
**Supersedes in part:** the "probe a fixed list of directories" half of `exec.ts`

## Context

A process inherits its environment from its parent. A shell in a terminal has run
the user's profile, so `PATH` there has `/opt/homebrew/bin` on it. An app launched
from Finder or the Dock is a child of **launchd**, which sourced no profile — its
`PATH` is `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else.

So the identical `exec` call succeeds in a terminal and fails with `ENOENT` in the
shipped app. That is the worst shape a bug can have: it cannot be reproduced in
the loop you develop in, because `pnpm dev` is launched from a shell.

v1 hit this and answered it by probing a fixed list —
`STANDARD_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']` —
which v2 copied into `exec.ts`. It covers `git` and `gh`, and it stops there. It
does nothing for a **version manager**, which is where `node`, `python`, `ruby`
and their ecosystems live for most people: `mise`, `asdf`, `nvm`, `volta`,
`pyenv`, `rbenv` and `fnm` all put their shims in a directory that exists only
because a shell profile said so, and several pick the version from the directory
the shell started in. A fixed list cannot be extended to cover that.

The list also leaked. `extensions/github/src/token.ts` carried its own copy,
because an extension that names `env` in `ExecOptions` **replaces** the child's
environment and therefore has to supply a `PATH` — so "know where tools live"
had already become a rule extension authors have to remember, which is the shape
of mistake `boundaries.js` and the one-runner rule exist to prevent.

`pingdotgg/t3code` solves the same problem in
`apps/desktop/src/shell/DesktopShellEnvironment.ts`, and its answer is the one
worth having: ask the shell.

## Decision

**At startup, run the user's login shell once, take its `PATH`, and merge it into
`process.env`.** `packages/platform/darwin/src/shell-env.ts`, called as the first
statement of `app.whenReady()`.

Installing into `process.env` rather than returning a value somebody threads is
the point: `resolveProgram`, `execPath`, `gitEnv` and `spawnDetached` already read
it, so every consumer improves without knowing this happened. A fix each call site
must opt into is a rule, and this codebase has paid for that rule twice.

Five details, each a bug avoided rather than a preference:

- **`-ilc`, not `-lc`.** Login shells read `.zprofile`; the line that adds a
  version manager to `PATH` is overwhelmingly in `.zshrc`, the **interactive**
  file. A non-interactive login shell reports a `PATH` the user has never seen.
- **`$SHELL` first, never a hardcoded bash.** This is v1's own recorded rule,
  arriving from the other direction: `bash -lc` reads BASH profiles, so a `PATH`
  configured in zsh is invisible and the probe concludes the tool is missing.
- **Marker-delimited `printenv`, never a dump of `env`.** A profile prints things
  — motd, `fastfetch`, a version-manager warning — and any of it can look like
  `KEY=value`. `printenv NAME || true`, because a profile that set `set -e` would
  otherwise end the script at the first unset name.
- **Merge with the inherited `PATH`, never replace it.** A profile that overwrote
  `PATH` instead of appending would otherwise take away directories that were
  working a moment ago.
- **Two names harvested, `PATH` and `SSH_AUTH_SOCK`**, and the second only fills
  in when launchd supplied none. `shell.ts` is the counterweight: it exists to
  **strip** inherited variables — a proxy pointing at a dead port, another agent's
  session ids, forty `npm_*` keys — because the app inheriting its launcher's
  environment has already cost this project debugging sessions. Harvesting is that
  same door in the other direction, so the list stays narrow by construction.

`STANDARD_BIN_DIRS` stays, and stays first. It is what answers when the harvest
found nothing, and four `stat` calls are the difference between `git` being
findable and probably findable.

## Consequences

- **Startup pays for it, up to `LOGIN_SHELL_TIMEOUT_MS` (3s).** Awaited rather
  than backgrounded, because the alternative is a race that only appears on the
  slow machines this feature is for. Three orderings force it to be first:
  `remote.serve` shells out to `openssl`, the daemon inherits `process.env` when
  it is lazily spawned, and `resolveProgram` **caches** — an entry resolved under
  launchd's `PATH` would outlive the reason it was wrong. (`installShellEnvironment`
  drops that cache, but it cannot undo a spawn that already happened.) The
  measured `ms` is logged, so "launch got slower" is answerable rather than
  guessed at.
- **Every failure lands on the environment being untouched.** No shell, a wedged
  profile, a timeout, no launchd: the app behaves exactly as it did before this
  file existed. The one real-machine test asserts only that — that no directory
  which was on `PATH` is missing afterwards. It deliberately makes no claim about
  what the harvest *finds*, because that would be a test about the machine.
- **A user's dotfiles now run inside the app process's child at startup.** That is
  new attack surface in the sense that a profile can now slow the launch or print
  megabytes; it is not new trust, since every pane already spawns `$SHELL -l`.
- **The `exec` contract is unchanged.** `opts.env` still replaces. What changed is
  that an extension no longer has a reason to name `PATH` — and `token.ts`'s copy
  is deleted, with a test asserting it names none.
