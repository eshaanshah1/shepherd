---
name: handoff
description: Use when running inside a Shepherd pane and the work should continue in a fresh, independent Claude session — this session's context or token budget is nearly spent with work remaining, the user asks to hand off / spin up a new session / continue in another tab, or the next chunk of work is self-contained enough that inheriting this session's history would only cost budget.
---

# Handing Off to a New Session

## Overview

A handoff opens a new Shepherd tab, starts `claude` in it, and hands it a written
brief. The successor is not a continuation of you — it boots with an empty context
window and knows only what the brief says.

**Core principle: point, don't paste.** The successor can read every file you can.
What it cannot recover from disk is what you *decided* and what you *learned* — the
approach you rejected and why, the trap that cost you an hour, the reason the
obvious fix is wrong. So the brief records **decisions, state, and paths**, never
summaries of code the successor can open itself.

The brief goes in a **file**, not a prompt: a prompt is gone once the successor's
context compacts; a file it can re-read, you can correct, and the user can audit.

## When to use

Budget nearly spent with a clean unit of work left; the user asks for a new
session; the remaining work is independent enough that this session's history is
dead weight; or a separable piece should run in parallel.

**Not for** a bounded sub-task you intend to supervise and fold back in — spawn a
pane (`shepherd:controlling-shepherd`) or use a subagent. A handoff means the
successor owns the work from here.

## The four steps

```sh
shepherd ping      # -> pong, else no control channel: tell the user, don't guess
```

**1. Write the brief** to `~/.shepherd/handoffs/<YYYY-MM-DD>-<slug>.md` (`mkdir -p`
it) — outside any repo, so it never appears in `git status`, and it persists.
Write it *before* spawning anything; it is the part that decides whether the
handoff works.

**2. Open the tab where the work lives.** Without `--cwd` a new tab opens in the
workspace's default directory, which is usually not where you are. Read **Same
tree or its own worktree** before defaulting to `$(pwd)`.

```sh
p=$(shepherd tab new --cwd "$(pwd)")
```

**3. Launch the successor pointed at the brief**, and name the tab — both panes
otherwise show the same directory.

```sh
b="$HOME/.shepherd/handoffs/<file>.md"
shepherd tell "$p" "claude 'Read $b — it is your full brief for this session. Follow it.'"
shepherd tab rename "$p" "handoff: <slug>"     # tab verbs accept a pane handle
```

The prompt rides `claude`'s own argument, so there's no boot-wait and nothing is
typed into a bare shell. Interpolate `$b` from *your* shell as shown — a `~` left
inside the quotes reaches the successor unexpanded, and its `Read` needs a real
absolute path.

**4. Verify, report, stop.**

```sh
shepherd wait "$p" --state working --timeout 90
```

Tell the user which tab took over, what it was asked to do, and where the brief is.
Then stop: don't poll the successor, relay its output, or keep editing the files you
just handed over.

**A timeout usually means the trust dialog.** In a directory Claude has never run
in — which a freshly created worktree *always* is — it asks "do you trust the files
in this folder?" before anything else. That blocks ahead of `SessionStart`, so no
hook fires, the pane stays `shell`, and `wait` times out with nothing visible in
Shepherd to explain it. It is skipped only in non-interactive mode, which a handoff
is not. So on a timeout: check `shepherd state` — still `shell` means it never got
going, and the user has to accept the dialog. Say that plainly instead of reporting
a launch failure.

## What the brief must contain

Every section is REQUIRED. An empty one is information (`Nothing broken right now`);
a missing one is a hole.

```markdown
# Handoff: <one-line statement of the goal>

## Objective
What "done" looks like, as an outcome, not an activity. One or two sentences.

## Where things stand
Committed, staged, half-finished, broken-right-now — each named explicitly, plus
the branch and whether the tree is clean.

## Next steps
The remaining work, ordered, concrete enough to start the first one without
re-deriving it.

## Decisions and gotchas
What is already decided and must not be relitigated, with the reason. What was
tried and rejected, with the reason. Traps that cost this session time. This is the
one thing not recoverable from the repo — usually the longest section.

## How to verify
The exact commands that prove the work is done, and what passing looks like.

## Where to read more
Paths — specs, ADRs, plan docs, the files being changed. Paths, not summaries.
```

Write it as instructions to a capable colleague who has never seen the task, not as
a diary of your session.

## Same tree or its own worktree

Two agents editing one working tree overwrite each other, and neither knows why the
file it just wrote changed.

| Situation | Directory |
|---|---|
| **Takeover** — you are stopping | `--cwd "$(pwd)"`, and say in the brief that you have stopped |
| **Parallel** — you keep working | its own worktree, below |

```sh
d=~/.shepherd/worktrees/<repo>/<branch>
git worktree add "$d" -b <branch>          # no control verb for this — use git
p=$(shepherd tab new --cwd "$d")
```

A new worktree is a directory Claude has never run in, so this path always meets
the trust dialog described in step 4. Warn the user in the same breath as reporting
the handoff.

## Handing a brief to an already-running session

`tell --file` pastes a multi-line brief as one message (typed newlines submit
line-by-line, so `tell` pastes anything containing a newline):

```sh
shepherd tell "$p" --file "$b"
```

Still prefer the launch-argument form for a fresh session — a file the successor
reads survives its own compaction; a pasted message doesn't.

## Common mistakes

- **Summarizing code in the brief.** It can read the code. Spend the words on
  decisions.
- **A vague objective.** "Continue the workbench work" makes the successor re-plan
  from scratch — the exact cost you were avoiding.
- **Omitting what's broken.** A successor that finds a failing build it didn't cause
  spends its first hour debugging your half-finished edit.
- **Handing off and then continuing to edit.** Either stop, or give it a worktree.
- **Babysitting.** Polling or relaying spends the budget that triggered the handoff.
- **Never verifying.** `tell` reports success as long as the pane exists — it says
  nothing about whether `claude` started.
- **Reading a `wait` timeout as a broken launch.** Check `shepherd state` first;
  `shell` means the trust dialog, not a failure.
