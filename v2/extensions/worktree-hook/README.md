# `shepherd.worktree-hook`

A script you choose, run inside every worktree a task creates.

A fresh `git worktree add` gives you the tracked files and nothing else. The
`.env`, the vendored framework, the `google-services.json`, the symlink into a
shared build cache — all gitignored, none of them carried, and the agent that
opens in that checkout a second later finds a repo that does not build. This is
the extension that fixes that once per repo instead of once per task.

v1 had the same feature keyed per **workspace**
(`spike/seam1/Sources/WorktreeHookRunner.swift`). That unit does not survive the
move: a v2 task worktrees several repos at once, and what a hook actually does
belongs to a repo rather than to the window it happens to be opened in.

## Where a hook lives

In this extension's KV, reachable through the app and the Shepherd CLI, and
nowhere else. Not a config file and not a dotfile in the repo — deliberately. A
hook names this machine's paths and copies this machine's secrets, so it must
not be committable into a repo somebody else clones.

| Scope | Key | Runs |
|---|---|---|
| Global | `hook:global` | first, in every worktree — **possibly several at once** |
| Per repo | `hook:repo:<absolute source repo path>` | after the global one, in that repo's worktree |
| Per set | `hook:set:` + the paths, `\n`-joined | once, at the **task root**, after every worktree is ready |

The **source repo path** is the key, because it is the only stable identity a
repo has in v2 — there is no repo registry, just the `{path, name}` a user picks
per task. `~` is expanded before the key is built, so `~/dev/alpha` and
`/Users/x/dev/alpha` are one hook rather than two.

A **set**'s members are expanded, then deduped, then sorted, then joined — in
that order, because the joined string *is* the hook. Deduping after expansion
makes `~/dev/alpha` and `/Users/x/dev/alpha` one member; sorting makes `{a,b}`
and `{b,a}` one hook. The prefix is `hook:set:` and not `hook:repos:`, which is
one character away from being caught by `startsWith('hook:repo:')`.

Setting a hook to an empty or whitespace-only script **clears** it. A set with
**no** repos is refused on write: it would be a subset of every task — a second
global hook — with a key indistinguishable from the bare prefix.

## How it runs

`/bin/bash -lc <script>`, with cwd set to the new worktree.

A **login** shell, which is v1's choice and worth keeping: it is what makes
`pnpm`, `mise` and `direnv` work inside a hook rather than the stunted
environment a GUI app inherits. It is spelled as an argv because v2's exec
reaches `execFile` and never a shell, so the script is one argument and nothing
re-parses it.

| Variable | Value |
|---|---|
| `WORKTREE_DIR` | the new worktree |
| `WORKTREE_SRC` | the source repo it came from |
| `WORKTREE_BRANCH` | the task's branch |
| `WORKTREE_NAME` | the worktree's directory name |
| `REPO_NAME` | the repo's name |
| `TASK_SLUG` | the task slug |
| `TASK_ROOT` | the task root that holds every worktree |

The first five are v1's names, unprefixed and unchanged, so a script written
against v1 runs here untouched — `scripts/worktree-hook.sh` at the root of this
repo is a working example and is written against exactly those. The two `TASK_`
names are new, because in v2 a worktree has siblings and a hook may want to
reach them.

stdout and stderr are merged. A hook is killed after **600 seconds**.

**The global hook runs once per worktree, and the worktrees provision
concurrently.** So a global hook doing machine-wide setup — `mise install`,
warming a shared cache, anything that writes one path for all of them — can have
several copies of itself running at the same time, and has to guard itself with a
lockfile or a sentinel. A repo hook and a set hook each get one invocation per
task and need no such guard.

## How a set hook runs

Same shell, same timeout, same tail. What differs is where and when: `cwd` is the
**task root**, and it runs once, after every repo's worktree exists and the root
has been written.

| Variable | Value |
|---|---|
| `TASK_ROOT` | the task root, which is also the cwd |
| `TASK_SLUG` | the task slug |
| `WORKTREE_BRANCH` | the task's branch |
| `HOOK_REPOS` | this set's worktree dirs, newline-separated, in the key's sorted order |

`HOOK_REPOS` is there so a generic loop is writable without hardcoding names
(`readarray -t repos <<< "$HOOK_REPOS"`). A script wanting one specific checkout
says `$TASK_ROOT/alpha` — a worktree's directory name is its repo's name, and a
set hook knows its own repos by construction, because it was selected by them.

**Deliberately absent: `WORKTREE_DIR`, `WORKTREE_SRC`, `WORKTREE_NAME`,
`REPO_NAME`.** Each would have to name a single repo, and this hook has no single
repo. Inherited from whichever path sorted first they would mean something
different than they do one scope up, and the failure that produces is a script
that ran successfully against the wrong checkout.

Matching is **subset**: the hook fires when every repo in it is on the task,
whatever else is. A task carrying `{1,2,3}` therefore runs the `{1,2}`, `{1,3}`,
`{2,3}` and `{1,2,3}` hooks — wiring written for a pair stays valid when a third
repo joins. They run **sequentially**, ordered by set size then by key: they share
one cwd, so concurrency there is racing writes to a single directory, and a
smaller set is the more basic wiring a larger one plausibly builds on.

A **one-repo set is allowed** and is not a spelling of the repo hook: different
cwd, different moment, and it fires once rather than per worktree.

## When a hook fails

The worktree is kept, provisioning continues, the task root is still built and
agents still spawn. That is v1's behaviour and v1's reasoning: a
half-provisioned checkout you can look at beats a task that refused to open.

What changes is the repo's row in the task tree, which reads `ready — hook
failed`; `tasks.list` carries the same text on `repos[].hookIssue`, and the
extension host log gets it too. The message is the last 20 lines of merged
output, with a count of what was dropped.

If the **global** hook fails, that repo's own hook is skipped — it likely
depended on the global one, and running it anyway produces a second failure
caused by the first. The message says so.

For a **set** hook, three things differ. A set that does not match is **not** a
failure: it is silent, and it silently covers the case where a repo of its own
failed to provision or failed its hook, because such a repo is absent from the
ready set the match is made against. A set hook that *does* fail puts
`<state> — set hook failed` on the **task's** row (appended, so the row's state
still reads true) and its message on `tasks.list`'s task-level `hookIssue`. And
matched sets are **siblings, not a chain**: one failing does not skip the rest,
and their messages join. The global→repo skip exists only because the second
depends on the first; two unrelated repo sets have no such relationship.

## Where it plugs in

`tasks` defines one extension point, `tasks.repoProvisioned`, and awaits its
providers per repo: after `git worktree add` succeeds, before the task root is
materialized, and long before a session opens. Awaited rather than announced on
the event bus, because an agent opens in that checkout moments later and a
fire-and-forget event would race it — invisibly, since the files do land, just
sometimes after the agent looked.

This extension registers exactly one provider into that point. If nothing
defines the point (`tasks` disabled or failed to activate) it warns and stays
up: the editor still works, so the scripts you have set are neither lost nor
hidden.

It runs on `tasks.restore` as well as `tasks.create` — both go through the same
`provision()`, and a restored worktree needs its gitignored files as much as a
fresh one.

## Using it

**⌘, → Worktree hooks** opens the editor: it is a settings page (spec
2026-08-11), contributed as `contributes.settings` in the manifest. It had a ⌘⇧H
of its own until there was a settings screen to put it in; that key is gone, and
so is the gear button beside the composer's `+`.

From the CLI:

```sh
shepherd worktree-hook get                                    # the global hook, plus every repo and set that has one
shepherd worktree-hook get   --repo ~/dev/alpha
shepherd worktree-hook set   --repo ~/dev/alpha --script 'cp "$WORKTREE_SRC/.env" .'
shepherd worktree-hook clear --repo ~/dev/alpha
shepherd worktree-hook test-run --script 'ls' --at /tmp/throwaway

# a SET: --repos repeats, and one hook runs at the task root
shepherd worktree-hook set   --repos ~/dev/alpha --repos ~/dev/beta \
  --script 'ln -sf "$TASK_ROOT/alpha/dist" "$TASK_ROOT/beta/vendor/alpha"'
shepherd worktree-hook clear --repos ~/dev/alpha --repos ~/dev/beta
shepherd worktree-hook test-run --repos ~/dev/alpha --repos ~/dev/beta \
  --script 'echo "$HOOK_REPOS"' --at /tmp/throwaway
```

`--repo` is one repo and a hook in **each** worktree; `--repos` repeats and names
a **set**, whose hook runs **once at the task root**. Giving both is an error
rather than a precedence rule nobody would remember. `--repos` always accumulates
into an array, even given once, because the shape of an argument must not depend
on how many were passed.

`test-run` takes `--repos` too, and it matters more than it looks: a set script
tested through the repo path runs with `TASK_ROOT` unset, so
`cp "$TASK_ROOT/alpha/.env" .` becomes `cp /alpha/.env .` and the test reports a
bug that does not exist.

`test-run` is v1's "Test run": it runs a script against a directory you nominate
so a typo is found before a worktree exists rather than after. The directory is
yours to create and to remove — an extension that made temp directories would
acquire a cleanup problem, and `os.tmpdir` is exactly the OS API `boundaries.js`
keeps out of an extension.

## Not done yet

- **A Test run button in the editor.** The command exists and the CLI reaches it;
  the button needs a throwaway directory the renderer cannot create.
- **No migration from v1.** v1's hooks were per-workspace and there is no sound
  mapping to a repo. An existing workspace hook has to be entered once as a repo
  hook.
- **No per-repo timeout.** One number, 600s, until something needs otherwise.
- **No dedupe of identical scripts, and no "every task, once" scope.** Both were
  considered and declined; the design doc's *Rejected* section has the argument.
  The short version: a script is one opaque string to `bash -lc`, so the commands
  inside two hooks cannot be compared; deduping whole scripts would have to key on
  the environment too, at which point the case it exists for stops matching; and
  the empty set — a hook running once per task at the root, unconditionally — was
  offered and turned down, leaving `hook:global` carrying both of its jobs.
