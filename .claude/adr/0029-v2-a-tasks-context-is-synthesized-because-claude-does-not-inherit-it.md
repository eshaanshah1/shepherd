# 0029. (v2) A task's context is synthesized, because Claude Code does not inherit it

Status: Accepted
Date: 2026-08-08
Scope: `v2/` only.

## Context
A task root holds one git worktree per repo, and an orchestrator runs at that
root. Sketch §4 assumed a synthesis step (`TaskRootSynth`) on the reasoning that
"nested `CLAUDE.md`s load themselves… but `.claude/` does not propagate". That
was a hypothesis. It had never been measured, and the whole task model rests on
it, so M3 measured it first — ~20 headless sessions against purpose-built roots
(Claude Code 2.1.224, evidence in `docs/superpowers/probes/2026-08-07-m3/`).

| measured | result |
|---|---|
| `CLAUDE.md` at cwd | loaded at session start |
| a **nested** repo's `CLAUDE.md` | **not** loaded at start — injected lazily, once a file in that subtree is touched |
| `.claude/skills/<name>` as a symlink, and `.claude/skills` itself as a symlink | both discovered *and* executable, indistinguishable from a real directory |
| `.claude/agents/<name>.md` as a symlink, and a symlinked agents dir | both discovered and spawnable |
| `.claude/settings.json` at cwd, incl. as a symlink | honoured — `env` and a `SessionStart` hook both fired |
| a **nested** repo's `.claude/` | skills load lazily on subtree access; **agents and `settings.json` are never loaded at all** |
| ancestor directories | Claude walks **up** from cwd for `.claude/skills` and `CLAUDE.md` — found from **three** levels up |
| a non-git cwd | nothing degrades; a task root need not be a repo |

## Decision
`TaskRootSynth` is **pure** — repos + brief in, a description of the root out —
and a separate materializer performs it. Four rules, each from a row above:

1. **Aggregate agents and settings, not just skills.** Skills half-work without
   synthesis (lazily, if the agent happens to touch that subtree); agents and
   settings simply do not exist from the root. This is what makes synthesis
   load-bearing rather than a convenience.
2. **Per-entry symlinks, never a symlinked directory.** Both forms work
   identically, so the tiebreaker is that only per-entry aggregation can merge N
   repos into one namespace — which is the entire job.
3. **A name collision namespaces EVERY contributor and is reported.** Two repos
   contributing `deploy` do not conflict in Claude Code: one symlink overwrites
   the other, silently, and the agent then runs the wrong repo's skill.
   Namespacing only the losers would make resolution depend on repo order, so
   adding a repo would rename another's skill out from under its callers.
4. **The generated `CLAUDE.md` carries the repo map**, because it is the only
   file loaded at session start — the orchestrator cannot learn what repos it
   has from their own `CLAUDE.md`s until it has already gone looking.

**Settings are reported, never merged.** One file cannot be N files, and merging
would union permission grants across repos and fire every repo's hooks in every
task. That is its own decision with its own consequences; inventing it silently
inside a materializer is how it would arrive unexamined.

**Nothing above a task root may contain `.claude/` or `CLAUDE.md`.** Ancestors
leak in, measured from three levels up, so `~/.shepherd/v2/` and `~/.shepherd/`
stay clean. Read the other way this is a feature: a deliberate `.claude/` at the
tasks root would share configuration across every task.

## Consequences
The interesting half is table-testable without a filesystem, including every
collision case. Verified end to end afterwards: a two-repo task produced two
worktrees, a generated `CLAUDE.md`, `api-deploy`/`web-deploy` for the colliding
skill with a warning naming both repos, and a real `claude -p` at that root
answered "Ship the login fix across `api/` and `web/` repos" — the generated file
being read at session start, exactly as measured.

## Not decided here
Whether an **interactive** first run in a new task root shows a trust dialog
before honouring the generated `settings.json`. Headless with an explicit
`--permission-mode default` and no trust record at all, it is honoured. If a
dialog does appear it is once per task root — a UX cost, not a dead feature.
