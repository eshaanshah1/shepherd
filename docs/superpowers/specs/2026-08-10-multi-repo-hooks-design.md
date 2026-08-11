# Worktree hooks for a set of repos — design

**Date:** 2026-08-10
**Status:** approved, not yet implemented
**Predecessor:** [`2026-08-09-worktree-hook-design.md`](2026-08-09-worktree-hook-design.md)

## Goal

A hook that fires only when a **set** of repos is on a task, and runs in the one
directory that holds all of them — the task root. Alongside today's per-repo
hook, so a task carrying `alpha` and `beta` runs the `alpha` hook, the `beta`
hook, *and* the `{alpha, beta}` hook.

The motivating case is wiring that exists only between two checkouts and cannot
be written from inside either one: symlinking one repo's build output into the
other's vendor directory, writing a `docker-compose.yml` that names both paths, a
`.env` in one that points at the other. A per-repo hook cannot do it — when
`alpha`'s hook runs, nothing tells it whether `beta` is even on this task, and
`beta`'s worktree may not exist yet.

Second, smaller goal, from the same conversation: **repos provision in
parallel.** `runProvision` is a serial loop today and its own comment complains
about "~2.5s-per-repo of network" going by.

## What this is not

- **Not a rework of the per-repo hook.** `hook:global` and `hook:repo:<path>`
  keep their keys, their cwd, their env and their ordering. A script written
  against them runs unchanged.
- **Not a way to run a hook before a worktree exists.** The one moment this adds
  is *later* than the existing one, not earlier.
- **Not a settings page.** The ⌘⇧H editor gains a section and stays as temporary
  as its README already says it is.
- **Not deduplication of work across hooks.** Considered and rejected — see
  *Rejected: the empty set and script dedupe*.

## Architecture

### The seam

`tasks` defines a second extension point beside `tasks.repoProvisioned`, awaited
**once per task** after the repo loop in `runProvision`:

```ts
export const TASK_PROVISIONED_POINT = 'tasks.taskProvisioned';

export interface TaskProvisionedFact {
  readonly task: { readonly slug: string; readonly root: string };
  readonly branch: string;
  /**
   * Worktrees that exist AND that every `repoProvisioned` provider was happy
   * with, in the order the task lists its repos.
   */
  readonly repos: readonly {
    readonly path: string;
    readonly name: string;
    readonly worktree: string;
  }[];
}

export type TaskProvisioned = (
  fact: TaskProvisionedFact,
) => Promise<{ readonly ok: boolean; readonly message?: string }>;
```

`order: 'registration'`, for `repoProvisioned`'s reason: these are side effects
on a directory, so "which one wins" is not a question anybody is asking.

**That definition of `repos` is the whole skip rule.** Because it lists only
*ready* checkouts, everything a set hook must not do collapses into the subset
test:

- `beta`'s `worktree add` failed → not in `repos` → `{alpha, beta}` does not
  match → does not run. It never gets the chance to fail confusingly against a
  directory that is not there.
- `beta`'s **global** hook failed, so its repo hook was skipped → `tasks`
  recorded a `hookIssue` for it → not in `repos` → same outcome. The existing
  "a global failure poisons what depends on it" rule extends one level up for
  free, with no second cascade rule to reason about.

And `tasks` computes it without knowing that hooks exist: "landed, and no
`repoProvisioned` provider complained" is already `hookIssue.has(key) === false`.

### Why a second point rather than a wider fact

`tasks/manifest.ts` says of `REPO_PROVISIONED_POINT`: *"It is the ONLY
provisioning point… If a later need wants a different moment, widen this fact; do
not add `tasks.repoAboutToProvision` beside it."*

This adds one anyway, and the distinction is that the rule forbids publishing
finer **steps** of one repo's provisioning. `taskProvisioned` publishes a
different **subject** — the task — and it is still a question ("every checkout
exists; is anything else needed before this can be worked in?") rather than a
step.

Widening `RepoProvisionedFact` cannot work: that fact is delivered N times, so a
provider keyed on a repo *set* would either fire N times or have to accumulate
state across calls and guess which delivery was the last one. The guess is the
part that makes it wrong — nothing in the fact says how many are coming.

**This needs ADR 0037.** Adding a point beside a point whose own comment forbids
it is exactly the kind of change the decision log exists for, and a quiet edit to
that comment would erase the reasoning that produced it.

### Where it runs in `runProvision`

After `materializeTaskRoot` and its conflict/notice logging; before
`seedClaudeTrust` and the orchestrator spawn.

**After materialize**, so the root is complete: a set hook can read the generated
`CLAUDE.md`, and materialize's stale-link `rmSync` cannot reach in after the hook
has written. **Before the spawn**, which is the invariant the whole seam exists
for — the awaited-not-announced argument from the predecessor spec applies
unchanged, one level up.

### Parallel repos

```
repo1: add ──▶ global ──▶ repo1 hook ┐
repo2: add ──▶ global ──▶ repo2 hook ├──▶ root synth ──▶ set hooks ──▶ trust ──▶ spawn
repo3: add ──▶ global ──▶ repo3 hook ┘        (in order, at the task root)
```

Each repo is one chain that catches its own errors; the chains run concurrently.
Within a chain nothing changes: global hook, then repo hook, then skip the repo
hook if the global one failed.

Three consequences that are requirements, not observations:

- **Results are collected positionally and re-read in `task.repos` order.**
  `landed` feeds `synthTaskRoot`, which namespaces skill collisions and writes
  the repo list into the generated `CLAUDE.md`. Ordered by completion, the task
  root would vary run to run for reasons nobody could see.
- **No fail-fast.** A rejecting chain must not abandon its siblings mid-`worktree
  add`: a registered worktree whose directory is gone is the state nothing
  cleans up later, and `runProvision` is where that gets created.
- **The global hook now runs concurrently with itself**, once per worktree. That
  is accepted deliberately (see *Rejected*), and it is a **documentation
  requirement**: the extension README must say so, because a hook doing
  machine-wide setup (`mise install`, a shared cache warm) has to guard itself
  and today nothing warns the author that it needs to.

Known limitation, documented rather than fixed: two repos sharing one source path
would run concurrent `git worktree add` in the same repo and contend on
`.git/index.lock`. The composer dedupes by path; the CLI does not. Serialising
chains by source path is the fix if it ever bites.

### Matching and ordering

Matching is **subset**: a set hook fires when every repo in its set is in
`fact.repos`. A task carrying `{1,2,3}` therefore runs the `{1,2}`, `{1,3}`,
`{2,3}` and `{1,2,3}` hooks, each once. Exact-match was considered and rejected:
a `{1,2}` hook would go silent the moment a third repo joined the task, and the
wiring it performs is still exactly as necessary.

Set hooks run **sequentially**, sorted by **set size ascending, then by key**.
They share one cwd — the task root — so concurrency here means racing writes to a
single directory, and there are never many. Smaller sets are the more basic
wiring that larger ones plausibly build on, and a fixed order is reproducible.

The predicate and the ordering are one pure function in `model/plan.ts` beside
`planHooks` — no filesystem, table-tested:

```ts
matchSets(
  sets: readonly { paths: readonly string[]; script: string }[],
  ready: readonly string[],   // the SOURCE paths of `fact.repos`
): readonly HookRun[]          // kind: 'set', in size-then-key order
```

### Storage

| Scope | Key | Runs |
|---|---|---|
| Global | `hook:global` | first, in every worktree, **possibly concurrently** |
| Per repo | `hook:repo:<source path>` | after the global one, in that repo's worktree |
| Per set | `hook:set:` + the source paths, newline-joined | once, at the task root, after every worktree is ready |

Paths are `expandHome`'d, then sorted lexicographically, then joined by `\n`
before the key is built — so `{a,b}` and `{b,a}` are one hook, and two spellings
of one path are one member. That is the same reason `expandHome` is load-bearing
for the per-repo key rather than cosmetic. Duplicate paths within one set collapse
to one member for the same reason.

`hook:set:` rather than `hook:repos:`, because the latter is one character away
from colliding with `startsWith('hook:repo:')` and a prefix scheme that survives
only by arithmetic is one rename from breaking `listRepos()`.

Two boundary calls:

- **A one-repo set is allowed.** It is not a spelling of the repo hook: different
  cwd (the task root), different moment (after every repo), and it fires once
  rather than per worktree. "When `alpha` is on a task, do this at the root" is a
  real thing to want.
- **The empty set is refused.** See *Rejected*.

An empty or whitespace-only script **clears** the hook, as it does today.

`HookStore` gains `listSets(): readonly StoredSet[]` (`{ paths, script }`, sorted
size-then-key) beside `listRepos()`, plus `forSet(paths)` / `setForSet(paths,
script)`.

### Execution

`/bin/bash -lc <script>`, cwd = **the task root**. Login shell, one string,
spelled as an argv, `HOOK_TIMEOUT_MS` of 600s, output merged and tailed to
`TAIL_LINES` — every one of those is the predecessor's decision, unchanged.

| Variable | Value |
|---|---|
| `TASK_ROOT` | the task root, which is also the cwd |
| `TASK_SLUG` | the task slug |
| `WORKTREE_BRANCH` | the task's branch |
| `HOOK_REPOS` | the matched set's worktree dirs, newline-separated, in the key's sorted order |

`HOOK_REPOS` exists so a generic loop is writable (`readarray -t repos <<<
"$HOOK_REPOS"`) without hardcoding names. A script wanting one specific checkout
says `$TASK_ROOT/alpha` — the worktree's directory name is the repo's name, and a
set hook knows its own repos by construction, because it is keyed on them.

**Deliberately absent: `WORKTREE_DIR`, `WORKTREE_SRC`, `WORKTREE_NAME`,
`REPO_NAME`.** Each would have to name a single repo, and this hook has no single
repo. A set hook inheriting `REPO_NAME` from whichever path sorted first is a
variable that silently means something different than it does one scope up, and
the failure it produces is a script that ran successfully against the wrong
checkout.

`HookKind` gains `'set'`, and `describeOutcomes` needs its wording.

### Failure

Unchanged in spirit: **a set hook failure degrades the task; it does not fail
it.** The worktrees are kept, the root is built, agents still spawn.

- **A non-match is not a failure.** It is silent on screen and gets a
  `log.info` line naming why — `set hook {alpha, beta} skipped — beta is not
  ready`. Without that line, "the hook I expected did not fire" and "the hook
  fired and did nothing" are indistinguishable from outside, which is the same
  objection `plan.ts` already makes about the skipped repo hook.
- **A failure lands in a new `taskIssue: Map<taskId, string>`**, cleared at the
  top of `runProvision`, mirroring `hookIssue` exactly. Surfaced three ways: the
  task row's description becomes `<state> — set hook failed` (**appended**, so
  the row's `tint` and real display state survive), `tasks.list` carries the
  message on the task, and the extension host log gets it.
- **Set hooks are siblings, not a chain.** One failing does not skip the others;
  their messages join. The chain rule exists between the global and repo hooks
  because the second depends on the first, and two unrelated repo sets have no
  such relationship.

### Surfaces

**Editor (⌘⇧H).** A third section, `a set of repos`, between `one repo` and the
stored-hook list:

```
── every repo ──────────────────────────
[ direnv allow                          ]
                       [ save global hook ]

── one repo ────────────────────────────
Repo  [ ~/dev/alpha                     ]
[ cp "$WORKTREE_SRC/.env" .             ]
                        [ save repo hook ]

── a set of repos ──────────────────────
Repos [ + repo                          ]
       (alpha ×) (beta ×)
Runs at the task root when all are present
[ ln -sf "$TASK_ROOT/alpha/dist" beta/… ]
                         [ save set hook ]

── hooked ──────────────────────────────
~/dev/alpha                     [ clear ]
alpha + beta                    [ clear ]
```

The chip field is the `Field` + `datalist` the editor already has, fed by
`tasks.suggestRepos`: ⏎ adds a chip, × removes one. **The composer's picker is
not extracted and shared.** It is woven into its own path-completion state and
`sh-composer-*` CSS, one extension cannot value-import another
(`tooling/eslint/boundaries.js`), so sharing means promoting it into
`@shepherd/ui` — a refactor of a surface covered by `smoke:m3`, in service of a
view whose own README says to delete it when the settings page lands.

Clicking a set row loads its paths and script into the fields above, for the
reason the repo rows already do it that way: one editor, because two would be two
places for one script to disagree about itself.

**Commands.** No new command ids. `worktreeHook.get`, `.set` and `.clear` each
gain an optional `repos: s.array(s.string())` beside the existing optional
`repo`, and `.get` answers with `sets` beside `repos` so one call still fills the
whole editor — the predecessor's reason, that a second round-trip is a second
chance to draw a stale one.

Three targets rather than two on one optional field, which the schema cannot
express on its own: `repo` absent and `repos` absent is the global hook, `repo`
alone is that repo, `repos` alone is that set, and **both is an error the handler
raises**. A precedence rule for `--repo x --repos y` would be a rule nobody would
remember, which is the argument that kept `repo` optional rather than adding a
`--global` switch in the first place.

**CLI.** `--repo` stays singular and means the per-repo hook. A repeatable
`--repos` means the set:

```sh
shepherd worktree-hook set   --repos ~/dev/alpha --repos ~/dev/beta --script 'ln -sf …'
shepherd worktree-hook clear --repos ~/dev/alpha --repos ~/dev/beta
shepherd worktree-hook get     # the global hook, every repo hook, every set hook
```

`--repos` **always** accumulates into an array, even with one occurrence, so
`argv.ts`'s own rule holds: the shape of an argument must not depend on how many
were given. `--repo` together with `--repos` is an error rather than a precedence
rule nobody would remember.

Two flags one letter apart is the weakest thing in this design, and it is chosen
against worse options: making `--repo` repeat for this noun changes the shape of
the existing one-repo call, and a `set-group`/`clear-group`/`get-group` verb
triple doubles the verb table for one concept.

**Test run.** `worktreeHook.testRun` gains an optional `repos`. Given it, the
script runs as a *set* hook against the nominated directory — `TASK_ROOT` = `at`,
`HOOK_REPOS` derived from the set's basenames under it. Without it, behaviour is
byte-identical to today.

Small, and it closes a real trap: a set script tested through today's path runs
with `TASK_ROOT` unset, so `cp "$TASK_ROOT/alpha/.env" .` becomes
`cp /alpha/.env .` and the test reports a bug that does not exist.

### Restore

Nothing new. `tasks.restore` and `tasks.create` both go through `provision()`, so
a restored task's worktrees fire set hooks exactly as a fresh task's do — a
restored checkout needs its cross-repo wiring as much as a new one, for the same
reason it needs its gitignored files.

## Rejected: the empty set and script dedupe

Two ways to stop identical work running N times, both rejected.

**Deduping commands inside a script is impossible.** A hook reaches `execFile` as
`['/bin/bash', '-lc', script]` — one opaque string. Shepherd never sees
`pnpm install` as a thing, so it cannot notice that two hooks both do it, and a
hook that ran only the lines Shepherd could parse would be worse than one that
runs all of them.

**Deduping identical whole scripts is possible and unwanted.** The key would have
to include the environment, or two invocations differing in their only input
would collapse; with env in the key the case it exists for stops matching, since
`{alpha,beta}` and `{alpha,gamma}` get different `HOOK_REPOS`. It would fire
mostly by accident, and when it fired it would silently change what a script
does — `echo x >> log` run twice is two lines, and whoever wrote it meant it.

**The empty set — a hook running once per task at the root, filling the missing
cell below — was offered and declined.**

|  | per worktree, N× | per task root, 1× |
|---|---|---|
| unconditional | `hook:global` | *(not built)* |
| gated on repo(s) | `hook:repo:<p>` | `hook:set:<p1,p2>` |

So `hook:global` keeps both of its jobs, runs once per worktree and now does so
concurrently, and a script that cannot take that guards itself with a lockfile or
a sentinel. The burden is the author's, on purpose: it is one fewer scope to
learn, and the guard is two lines of bash. If real hooks turn out to need it, the
empty set is the cell to fill and it costs no new machinery — `matchSets` already
returns it.

## Testing

Pure and unit, which is the cheap majority:

- **`matchSets`** — subset, non-match, size-then-key ordering, a one-repo set, an
  empty `ready` list.
- **store** — key sorting, `expandHome` collapsing two spellings into one hook,
  a duplicate path collapsing to one member, `hook:set:` and `hook:repo:` not
  seeing each other's keys, an empty script clearing, an empty set refused.
- **commands** — `repo` and `repos` together is an error; `get` answers `sets`
  and `repos` in one call.
- **runner** — the env map, cwd = the task root, sequential order, the failure
  and timeout wording.
- **`tasks`** — the point is defined; providers are awaited once with the right
  fact; `fact.repos` excludes both a repo that failed to provision and one whose
  `repoProvisioned` provider complained; **`landed` order equals `task.repos`
  order regardless of completion order**; a rejecting chain does not abandon its
  siblings; the task row's description and `tasks.list` carry the issue.
- **CLI** — repeated `--repos` → array, a single `--repos` → a one-element array,
  `--repo` still a string, both → an error.
- **editor** — chip add/remove, save posting sorted paths, set rows rendering.

And the part a green unit suite would lie about. **`pnpm smoke:m3` gets a second
repo** — `--shepherd-m3-repo2`, built by the same harness that builds the first —
and asserts that both worktrees landed, that the generated `CLAUDE.md` names
both, and that a set hook wrote a file at the task root. Parallelising
provisioning is precisely the class of change the root `CLAUDE.md` says a unit
suite cannot police: every existing test supplies both halves of the ordering it
asserts.

One trap in writing that check: the existing repo-hook assertion is allowed a
bare `existsSync` because the root gate already proves the repo hook ran *before*
materialize. A set hook runs *after* materialize, so that reasoning does not
transfer and the new check needs its own `until` gate.

## Deferred

- **No per-hook timeout.** Still one number, 600s, until something needs
  otherwise.
- **No ordering control beyond size-then-key.** No priorities, no `after:`.
- **No `serial` flag on the global hook.** The concurrency it now runs under is
  documented instead; the flag is the escape hatch if that proves insufficient.
- **No serialising of chains that share a source repo.** Documented as a
  limitation; the composer already prevents the only path that produces it.
- **No migration.** There was never a set hook to migrate from.
- **Still no settings page**, and this section of the editor belongs inside one
  the moment it exists — the predecessor spec's instruction, unweakened by
  growing a third scope.
