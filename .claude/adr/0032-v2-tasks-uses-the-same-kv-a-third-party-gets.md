# 0032. (v2) `tasks` uses the same KV a third party gets

Status: Accepted
Date: 2026-08-08
Scope: `v2/` only.

## Context
Three settled statements disagreed, and M3 could not start until they were
reconciled by name rather than by drift:

- **§7b**: "Task store is SQLite (**better-sqlite3**, main process, versioned
  migrations)."
- **ADR 0021**: the store is **`node:sqlite`** — better-sqlite3 is a native
  module built against Electron's ABI, and deleting that dependency was the
  point. §5.3's "better-sqlite3" is stale text.
- **§7c**: "Storage stays as it is: `KV`… Raw SQL to extensions is a bigger grant
  than it looks… if M3 proves KV too thin, that is the moment to widen it, with a
  real consumer to shape it."

So the live question was never which SQLite. It was the API surface `tasks` is
handed. And `SqliteStore.db` already existed, commented "escape hatch for core's
own tables (**tasks**, layout). Not exposed to extensions" — with zero callers.

## Decision
**KV, and the escape hatch stays shut.**

The query a task list needs is "all of them, ordered". `keys()` plus a filter
*is* that query at the scale a person's task list reaches, with no index for the
extension to keep consistent. Widening the grant to buy an index nobody's data
needs would be paying exactly the cost §7c warns about, for a hypothetical.

Taking `SqliteStore.db` would have been worse than a shortcut. It would make
`tasks` a **core-owned table reached through commands**, which is the privileged
path the whole ADE bet forbids: `tasks` must consume the same public API a third
party gets, or "a hackable substrate" is a slogan. If KV genuinely cannot carry
tasks, the answer is to widen **KV**, for everyone.

Two constraints follow, and the first is not obvious. `ctx.storage` is a
**write-through mirror**: the host ships an extension's entire namespace across
the message port at activation and it stays resident in the child. So a task
record stays small — no transcripts, no diffs, no file contents; those are files
or they are nothing. And the mirror is sound only because a namespace has exactly
one writer, which this is and must remain.

**An unreadable record is quarantined, never silently absent.** `KV.get` treats a
schema mismatch as absent and `s.object` rejects unknown keys, so a record
written by a newer build would read as "there is no such task" while its
worktrees, branches and archive refs sat on disk with nothing referencing them.
Hence `s.stored` — lenient about added keys, strict about absences, since a
record with no id is not from the future but corrupt — plus a `schemaVersion`
stamped **inside** the value, because KV versions nothing itself. A record from a
future version is refused rather than guessed at: leniency covers additions, not
changed meanings.

## Consequences
`s.stored` landed in the SDK rather than being hand-rolled in `tasks`, which is
the moment the M2 handoff predicted ("if M3 adds a second answer-consumer, that
is the moment to give the SDK a lenient-object combinator" — the first being
`agents-core`'s `readSessionRows`). It earned its keep immediately: `archives`
was added to the task record mid-milestone and old records read straight over it
with no migration.

The revisit trigger is stated so it is measured rather than argued: if archived
tasks accumulate until the activation seed is a real cost, that is when to
widen — with a number.

`SqliteStore.db`'s comment is now stale in the other direction and should say so:
`tasks` is not one of core's own tables.
