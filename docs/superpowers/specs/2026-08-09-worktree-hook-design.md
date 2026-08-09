# Worktree hook, per repo — design

**Date:** 2026-08-09
**Status:** approved, not yet implemented

## Goal

When a task provisions a repo's worktree, run a user-supplied script inside that
worktree before any agent opens in it. The motivating case is gitignored files:
a vendored directory, a `.env`, a `google-services.json` — things a fresh
`git worktree add` does not carry and an agent immediately needs.

v1 had this, keyed per **workspace**
(`spike/seam1/Sources/WorktreeHookRunner.swift`, documented in
`docs/control-cli.md:68-90`). v2 has nothing equivalent. This ports it and
re-keys it per **repo**: a task worktrees all its repos, then runs each repo's
own hook individually inside that repo's worktree.

## What this is not

Not a config file. Hooks live in the database and are reachable only through the
Shepherd UI and the Shepherd CLI, so they stay local to this machine and never
land in a repo someone else clones.

## Architecture

### The seam

`tasks` defines one extension point, `tasks.repoProvisioned`. Providers receive
facts and nothing else:

```ts
type RepoProvisioned = (fact: {
  readonly repo: { readonly path: string; readonly name: string };
  readonly worktree: string;
  readonly branch: string;
  readonly task: { readonly slug: string; readonly root: string };
}) => Promise<{ readonly ok: boolean; readonly message?: string }>;
```

`provision()` (`v2/extensions/tasks/src/index.ts:813-906`) awaits every provider
for a repo immediately after `provisionRepo` returns `ok`, and before root
materialization, trust seeding, and the orchestrator spawn. Awaited, not
announced on the event bus: a fire-and-forget event would race the spawn, and
copying gitignored files must finish before Claude starts.

This bumps against the doctrine in `v2/extensions/tasks/src/manifest.ts`
("publish questions, not steps — a hook per provisioning step would freeze this
extension's internals as public API"). It survives that bar because it is *one*
point asking a question — "given this fresh worktree, is anything else needed to
make it usable?" — it passes only paths, and there will not be a second one. If
a future need wants a different provisioning moment, the answer is to widen this
fact, not to add `tasks.repoAboutToProvision`.

### The extension

`v2/extensions/worktree-hook`, id `shepherd.worktree-hook`.

- Permissions: `storage`, `process.exec`.
- Dependencies: `shepherd.tasks` (to reach the point, and to reuse
  `tasks.suggestRepos` for path completion in the editor).
- Activation: `onStartup` — it must have registered its provider before the
  first task is created.

Storage (KV):

| Key | Value |
|---|---|
| `hook:global` | `{ script: string }` |
| `hook:repo:<absolute source repo path>` | `{ script: string }` |

The repo path is the key because it is the only stable identity a repo has in
v2 — there is no repo registry, just the `{path, name}` a user picks per task
(`v2/extensions/tasks/src/store.ts:52-57`). Paths are home-expanded before use,
the same way `tasks.create` does it
(`v2/extensions/tasks/src/model/repo-path.ts:15`). Setting an empty or
whitespace-only script clears the entry, matching v1's `setWorktreeHook`.

### Execution

Per repo, the global hook runs first, then that repo's own hook. Both run with
cwd set to the new worktree:

```ts
process.exec(['/bin/bash', '-lc', script], { cwd: worktree, env, timeoutMs: 600_000 })
```

`/bin/bash -lc` is v1's shape (login shell, script as one string). It is spelled
as argv because v2's exec never goes through a shell
(`v2/packages/platform/darwin/src/exec.ts`).

Environment, overlaid on the inherited one. The first five keep v1's unprefixed
names so scripts written against v1 — including this repo's own
`scripts/worktree-hook.sh` — run unchanged:

| Variable | Value |
|---|---|
| `WORKTREE_DIR` | the new worktree |
| `WORKTREE_SRC` | the source repo the worktree came from |
| `WORKTREE_BRANCH` | the task's branch |
| `WORKTREE_NAME` | the worktree directory name |
| `REPO_NAME` | the repo's name |
| `TASK_SLUG` | the task slug |
| `TASK_ROOT` | the task root that holds every worktree |

stdout and stderr are merged, as in v1. Timeout is 600s — room for a real
dependency install inside a hook.

### Failure

A non-zero exit keeps the worktree, lets provisioning continue, and lets agents
spawn. This is v1's behavior and the reason is unchanged: a half-provisioned
checkout you can look at beats a task that refused to open.

The repo's provisioning state becomes `ready` and carries a hook error. The task
tree row shows a warning with the last 20 lines of merged output (v1's `tail`
helper, `spike/seam1/Sources/AgentStore.swift:631-634`), and `ctx.log.warn` gets
the same text. There is no toast or alert API in v2; the per-repo state map that
`provision()` already maintains and the tree already renders is the surface.

A timeout reports as a failure reading "timed out after 600s". If the global
hook fails, that repo's own hook is skipped — it likely depended on the global
one — and the message says so.

### Surfaces

**CLI**, mirroring v1's `workspace-hook-get/set/clear`:

```
shepherd worktree-hook get   [--global | --repo <path>]
shepherd worktree-hook set   [--global | --repo <path>] <script>
shepherd worktree-hook clear [--global | --repo <path>]
```

**UI**: a contributed view `worktree-hook.editor`, opened by the palette command
`Worktree Hook: Edit`, registered in the renderer's component table
(`v2/packages/app/src/renderer/extension-ui.ts:30`). It lists the global hook
and every repo that has one, takes a new repo path with completion borrowed from
`tasks.suggestRepos`, and offers v1's "Test run" against a throwaway temp
directory (`spike/seam1/Sources/SettingsView.swift:373-396`) so a script can be
checked without creating a task.

### Restore

The hook runs on `tasks.restore` as well as `tasks.create` — both paths go
through `provision()`. A restored worktree needs its gitignored files as much as
a fresh one does.

## Testing

- `model/plan.ts` — pure. Given `(globalEntry, repoEntry)` it returns the ordered
  list of scripts to run, and given a run's outcomes it returns the reported
  message. Table-tested, including: neither set (nothing runs), global only,
  repo only, both, global fails (repo skipped, message names the global hook).
- `runner.ts` — exec against a fake `ProcessAPI`: argv shape, cwd, env contents,
  `timeoutMs`, output tail at 20 lines, timeout wording.
- `tasks` — a registered provider that fails still leaves the repo `ready`, still
  materializes the root, still spawns agents, and still surfaces the message.
- Store — empty and whitespace-only scripts clear; `~` paths resolve to the same
  entry as their expanded form.

## Deferred

- **A settings page. Once v2 has a settings surface at all, the worktree hook
  editor belongs in it, and the standalone `Worktree Hook: Edit` view should be
  folded in.** v2 has no settings UI today, which is the only reason this ships
  as its own view. Do not let the standalone view become the permanent home.
- No migration from v1. v1 hooks were per-workspace and there is no sound mapping
  to a repo; an existing workspace hook must be re-entered once as a repo hook.
- No per-repo timeout override. One number, 600s, until something needs more.
