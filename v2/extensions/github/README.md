# `shepherd.github`

The pull requests a task has open, where its agents are.

A task already carries the join GitHub needs: **one branch, named after the
task's slug, checked out in every one of its repos.** So "which PRs belong to
this task" is a lookup rather than a guess — and it stays correct when a PR is
retitled, rebased, or opened by somebody else.

The join is derived on every sync rather than stored, so nothing goes stale when
a PR is opened, closed or reopened outside the app. Its one weakness is that a
branch NAME is not unique over time — `uniqueSlug` only dedupes against tasks
that exist now, a repo has its own history of branch names, and a multi-repo task
asks the same name of every repo. `model/ownership.ts` is the guard: a **finished**
PR is this task's only if the task's HEAD is its tip or one of its commits. A live
PR always belongs, and anything unjudgeable is kept.

## What it puts on screen

Two places, and nowhere else.

**A glyph on the task's row**, tinted by the worst state across its PRs,
contributed through `tasks.cardFacts`. A shipped row carries the merged number
(`v2 #309`) instead, because on finished work the state is always "merged" and
the useful fact is which PR it was. `tasks` never learns what a pull request is.

**A `review` tab** — a contributed pane (ADR 0044). It has a home page listing
every PR of the task, one row each, with enough on the row to decide whether to
go in; clicking one opens the whole PR with `‹ PRs` in the head and Esc to come
back. **One PR skips the list entirely**: the tab *is* the PR, with no crumb and
no `1 of 1`. A second PR appearing is what grows the crumb.

Deliberately **not** a rail section of its own. A task's PRs listed separately
would repeat every task title one level down.

Deliberately **no attention**: a failing check is a *condition*, not an event, and
is always downstream of something that already alerted. `agents-core` stays the
only writer of agent attention (ADR 0026), and the enforcement is `attention`
being absent from this manifest.

## How it knows

| | |
|---|---|
| which tasks exist | `tasks.list`, every tick — a task appearing is exactly when its first PR is about to |
| which GitHub repo a checkout is | `git remote get-url origin`, once per directory, then remembered (`remotes.ts`) |
| the PRs | **one GraphQL query per repo** (`query.ts`), by head branch. REST would be five calls per PR |
| whose work a finished PR is | `git rev-parse HEAD` (`heads.ts`), read **only** when a repo answered with a merged or closed PR — the ordinary task never pays for it |
| the diffs | REST `pulls.listFiles`, **only when the Files tab opens**. GraphQL has no patch field, and a patch is the largest thing about a PR by an order of magnitude |
| the token | `gh auth token` first, then this extension's own keychain secret. Never an env var |

Nothing is persisted. A PR's state is a fact about a moment, and one restored
from disk would be a confident claim about a build that finished hours ago — the
same argument `tasks` makes for its diff cache.

**Three cadences** (`sync.ts`), because how often to ask depends on who is
looking: 20s while the review tab is open, 2min for other live tasks, 1h for
shipped ones. A redraw only happens when something *drawn* changed
(`Sync.changed`), because a redraw is a full tree re-read across a port.

## Layout

```
src/model/     pure — what a PR is, and every decision about how it reads
  pr.ts          the vocabulary, the state word, the stack, the land order, the rollup
  remote.ts      a git remote URL → owner/repo
  prompt.ts      what "Hand to agent" actually says
src/           the service half (utility process, no DOM)
  query.ts       the GraphQL document and the mapping off it — testable without a network
  client.ts      Octokit, behind an interface so everything else can be faked
  sync.ts        the loop: what is due, what changed, what to keep on failure
  token.ts       gh, then the keychain
  remotes.ts     origin per directory, memoized
  index.ts       activate: the fact provider, the view type, the verbs
ui/            the in-proc React half (ADR 0033) — imported only by the renderer
```

The stylesheet is `packages/app/src/renderer/review-pane.css`, not here: §7's rule
is that a contribution supplies data and a token name and can set neither a
colour nor a length.

## Hand to agent

It goes to **the agent that is already working**, and spawns one only when there
is nobody.

| | |
|---|---|
| one live agent in the PR's repo | it — the overwhelming case |
| **two or more** | **it asks** — a `Menu` anchored under the button that asked |
| none in the repo, a live orchestrator | it — can reach every worktree |
| nothing live | spawn one |

The ask exists because there is genuinely nothing to go on: every agent of a task
shares one branch, so *the one that owns this PR* is recorded nowhere and cannot
be recovered from git either — same author, same branch, and the push came out of
a worktree they share.

A **menu, not a modal**: the verb acts on one row, so the surface points at that
row; the thread you are handing over stays legible behind it, which a scrim would
destroy; and two to four destinations do not need a search field. Past four, the
last item becomes `More…`.

Each row is `claude · sdk worktree` and then **`sends now`** or **`queues`** —
what handing to that agent means right now, read off `agents.list`. An idle agent
takes the prompt immediately and a mid-turn one takes it when the turn ends;
finding that out by watching a pane not respond is what the third column avoids.
Both are fine, so neither is a warning. Two further items sit under a separator:
`New agent on this branch` and `Copy as prompt`.

A workstream in another repo is never chosen automatically — being told about a
file it does not have is worse than not being told — but it does appear in the
list once a person is choosing. Liveness comes from `sessions.list`, because a
task's record outlives the ptys it names (ADR 0036), and the session the picker
sends back is re-checked: an agent can finish while a menu is open.

The text is **pasted, not typed**: a typed newline is an Enter press, so a
six-line prompt typed into a TUI submits its first line and scatters five into
whatever runs next. `sessions.write` routes through `SessionHost.paste`, which
brackets iff the running program turned bracketed paste on — read off the mirror,
not assumed.

## The PR view

Four sub-views — Conversation, Commits, Checks, Files — because everything a PR
has does not fit in a stack. The tab row carries counts, so you can see what is
in a tab before opening it, and it **opens on Checks when something failed**:
that is why you came.

The diff and the file tree are **`@pierre/diffs` and `@pierre/trees`**. Two
things they buy that are months of work each: shiki highlighting with hunk
expansion and virtualisation, and `lineAnnotations` — which is exactly the shape
of a review comment sitting on the line it was written about.

Two adaptations they forced, both in `model/patch.ts`:

- **GitHub sends hunks, not patches.** No `diff --git` header at all, and
  `PatchDiff` refuses one. `unifiedPatch` synthesises it.
- **A thread naming a file is not a thread the diff can show.** Its line may have
  moved out of the change since it was written, and pinning it anyway puts the
  remark against whatever code now occupies that line number. `isLineInDiff`
  decides; a thread it cannot place is listed above the diff as `not on this
  diff` rather than dropped.

## Known limits

- **The PAT fallback is inert until `secrets` is implemented.** `secrets.get`
  throws in this build; `resolveToken` treats that as "no token", so a machine
  with `gh` is unaffected and a machine without it says "not signed in".
- **github.com only.** An enterprise host is a different API base URL, and
  guessing one from a remote is how a token reaches the wrong server.
