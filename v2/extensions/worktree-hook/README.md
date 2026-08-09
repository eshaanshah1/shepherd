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
| Global | `hook:global` | first, in every worktree |
| Per repo | `hook:repo:<absolute source repo path>` | after the global one, in that repo's worktree |

The **source repo path** is the key, because it is the only stable identity a
repo has in v2 — there is no repo registry, just the `{path, name}` a user picks
per task. `~` is expanded before the key is built, so `~/dev/alpha` and
`/Users/x/dev/alpha` are one hook rather than two.

Setting a hook to an empty or whitespace-only script **clears** it.

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

⌘⇧H raises the editor. From the CLI:

```sh
shepherd worktree-hook get                                    # the global hook, plus every repo that has one
shepherd worktree-hook get   --repo ~/dev/alpha
shepherd worktree-hook set   --repo ~/dev/alpha --script 'cp "$WORKTREE_SRC/.env" .'
shepherd worktree-hook clear --repo ~/dev/alpha
shepherd worktree-hook test-run --script 'ls' --at /tmp/throwaway
```

`test-run` is v1's "Test run": it runs a script against a directory you nominate
so a typo is found before a worktree exists rather than after. The directory is
yours to create and to remove — an extension that made temp directories would
acquire a cleanup problem, and `os.tmpdir` is exactly the OS API `boundaries.js`
keeps out of an extension.

## Not done yet

- **A settings page.** This extension contributes its own `worktree-hook.editor`
  view for exactly one reason: v2 has no settings surface. The moment there is
  one, this editor belongs inside it and the standalone overlay should go. **Do
  not let it become the permanent home.**
- **A Test run button in the editor.** The command exists and the CLI reaches
  it; the button needs a throwaway directory the renderer cannot create, so it
  waits for the settings page above.
- **No migration from v1.** v1's hooks were per-workspace and there is no sound
  mapping to a repo. An existing workspace hook has to be entered once as a repo
  hook.
- **No per-repo timeout.** One number, 600s, until something needs otherwise.
