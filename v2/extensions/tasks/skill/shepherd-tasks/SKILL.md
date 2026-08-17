---
name: shepherd-tasks
description: Use when running as an orchestrator inside a Shepherd task — to see the task you are in, spawn a tracked workstream session for a repo, or archive the task when it is done. Also explains when a tracked session is the right unit of parallelism and when a plain subagent is.
---

# Working inside a Shepherd task

You are running at a **task root**: a directory holding one git **worktree per
repo**, plus a generated `CLAUDE.md` and an aggregated `.claude/`. The repos
listed in that `CLAUDE.md` are real worktrees on this task's branch — commit in
them normally.

Two things about the root that are easy to get wrong:

- **A repo's own `CLAUDE.md` is not loaded until you read a file inside it.**
  The root one is the only one loaded up front. If you need a repo's conventions,
  open something in it first.
- **Skills and agents from every repo are aggregated at the root**, and a name
  contributed by two repos is namespaced — `api-deploy` and `web-deploy` rather
  than one `deploy`. If you see a namespaced pair, those are two different repos'
  versions and you must pick deliberately.

## The verbs

Run them with Bash. Inside a pane the socket is already in your environment.

```sh
shepherd task list                     # every task, with its state
shepherd task spawn --repo api         # a tracked session working in api/
shepherd task spawn --repo api --prompt "port the auth middleware"
shepherd task rename-branch --name fix-login   # renames it in every repo at once
shepherd task archive --task <id>      # shelve it; worktrees are snapshotted
```

`shepherd raw <command.id>` reaches any registered command, so a verb this file
does not list is still available.

**You are scoped to your own task.** `shepherd task spawn` with no `--task`
means yours, and naming another task's id is refused. That is deliberate, not a
bug to work around.

## Which kind of parallelism to use

This is the decision this skill exists for, and the two options are not
interchangeable.

**Use a plain subagent** (the Agent/Task tool) for work that is cheap,
short-lived, and whose only output is an answer you will read yourself:
searching, reading across files, a self-contained review. It is invisible to
Shepherd, which is exactly right — nobody wants a state indicator for a
forty-second grep.

**Use `shepherd task spawn`** for a real parallel workstream: something that
runs long, edits a repo, and might need a human. A spawned session is a
**tracked** session, which buys three things a subagent cannot have:

- its own state indicator, so a person can see it is working, blocked, or done
- **attention** — if it gets blocked on a question, it can pull a human back
- it can be attached to from another device

The rule of thumb: if a human might need to answer it, or if it will still be
running when you have moved on, spawn it. Otherwise use a subagent.

## When you finish

Leave the work committed on the task's branch. `shepherd task archive` snapshots
anything uncommitted and removes the worktrees; it refuses while a repo has
unresolved conflicts, and warns before it destroys git-ignored files (`.env`,
build output) because those are not captured by the snapshot.
