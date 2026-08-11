# 0039. (v2) A task is a second provisioning subject, not a finer step

Status: Accepted
Date: 2026-08-11
Scope: `v2/` only.

## Context
`extensions/tasks/src/manifest.ts` says of `REPO_PROVISIONED_POINT`, in the
comment that declares it:

> It is the ONLY provisioning point, and it publishes a question rather than a
> step… If a later need wants a different moment, widen this fact; do not add
> `tasks.repoAboutToProvision` beside it.

That rule exists for a good reason, stated one paragraph up in the same file: a
hook per provisioning step "would freeze this extension's internals as public API
and let a third party corrupt invariants it cannot see."

Then a need arrived that the fact cannot express. A **hook gated on a set of
repos** — fire only when `alpha` *and* `beta` are both on this task, and run in
the one directory that holds both — is the motivating case, and the wiring it
performs exists only *between* two checkouts: a symlink from one repo's build
output into the other's vendor directory, a `docker-compose.yml` naming both
paths. Neither repo's own hook can write it. When `alpha`'s hook runs, nothing
tells it whether `beta` is even on this task, and `beta`'s worktree may not exist
yet.

So the question was whether to widen `RepoProvisionedFact` or add a point beside
it, having just been told not to.

## Decision
**Add `tasks.taskProvisioned`**, awaited once per task after every repo's
worktree exists and the task root has been materialized.

The rule forbids publishing finer **steps** of one repo's provisioning. This
publishes a different **subject** — the task — and it is still a *question*
("every checkout exists; is anything else needed before this can be worked
in?") rather than a step. A provider is handed paths and nothing else, exactly as
`repoProvisioned`'s is, and it cannot fail a task: `ok: false` degrades it.

**Widening the fact cannot work, and the reason is mechanical rather than
aesthetic.** `RepoProvisionedFact` is delivered **N times**, once per repo. A
provider gated on a repo *set* would therefore either fire N times for one set,
or have to accumulate state across calls and guess which delivery was the last.
The guess is what makes it wrong: nothing in the fact says how many are coming,
so there is no correct moment for the provider to act. No amount of extra fields
fixes a cardinality mismatch.

## What keeps the rule's teeth

The new fact's `repos` lists **only** the checkouts that landed *and* that no
`repoProvisioned` provider complained about. That single definition is why this
point needs no third one beside it:

- a repo whose `worktree add` failed is absent, so every set containing it
  does not match — with no cascade rule to write;
- a repo whose own hook failed is absent for the same reason, which extends the
  existing "a global failure poisons what depends on it" rule one scope up for
  free.

`tasks` computes it without knowing that hooks exist: "landed, and nobody
complained" is already `hookIssue.has(key) === false`.

**The bar for a fourth point is the same as the bar this one had to clear: a new
subject, not a new moment.** "After the worktrees but before the root" is a
moment, and a provider wanting it should say why its work is not a question about
either the repo or the task.

## Consequences
- Two seams to keep in step. Both are `order: 'registration'`, both are awaited,
  both degrade rather than fail — a provider written against one reads correctly
  against the other.
- `shepherd.worktree-hook` now pins **two** point ids at compile time in
  `manifest.test.ts`, by the `typeof` assignment that trick already used: one
  extension may not value-import another, so a rename in `tasks` has to break the
  build rather than register into a seam nobody defines.
- A task-level complaint needed a home, so `taskIssue` sits beside `hookIssue`
  keyed by task id, surfaced on the task row (`<state> — set hook failed`,
  appended so the tint still tells the truth) and on `tasks.list`.
- The comment in `manifest.ts` that forbade this now points here instead of
  being quietly deleted. A rule that turned out to have an exception is worth
  more with the exception recorded than with the rule softened.

## Related
- Design: [`docs/superpowers/specs/2026-08-10-multi-repo-hooks-design.md`](../../docs/superpowers/specs/2026-08-10-multi-repo-hooks-design.md)
- Plan: [`docs/superpowers/plans/2026-08-11-multi-repo-hooks.md`](../../docs/superpowers/plans/2026-08-11-multi-repo-hooks.md)
- The rule this qualifies: `REPO_PROVISIONED_POINT` in `v2/extensions/tasks/src/manifest.ts`
- [ADR 0029](0029-v2-a-tasks-context-is-synthesized-because-claude-does-not-inherit-it.md) — what the task root is, which is the directory a set hook works in
