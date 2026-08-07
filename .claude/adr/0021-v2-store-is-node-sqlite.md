# 0021. (v2) The store is `node:sqlite`, and its version is a header field

Status: Accepted
Date: 2026-08-07
Scope: `v2/` only. v1's `UserDefaults` persistence is unchanged and maintenance-only.

## Context
The v2 core design (§5.3) named **`better-sqlite3`** for the task store, on the
reasonable grounds that "machines write DBs, humans write files" and that v1's
persistence was the single worst-aged subsystem in the app: 34 string-literal
`UserDefaults` keys, a whole-blob JSON re-encode on **every `cd`**, index-based
selection that broke whenever a list reordered, and schema versions smuggled into
comment lines. The architecture review's §Bad-8 is the full account.

`better-sqlite3` is a native module, which in an Electron app means rebuilding it
against Electron's ABI — the same `@electron/rebuild` step the M0 plan flagged as
node-pty's "classic silent crash", now needed twice. It also means a second
exception in `tooling/eslint/boundaries.js`, whose entire value is that it reads as
the architecture diagram: `core` imports stdlib + node-pty, and every addition to
that list makes the sentence longer and the rule weaker.

Before writing the M1 plan we probed the actual binary rather than reasoning from
release notes. Electron 43.3.0 runs Node 24.18.1, and **`node:sqlite` is present
and complete** there: `DatabaseSync`, `StatementSync`, `Session`, `backup`,
`PRAGMA user_version`, prepared statements, `ON CONFLICT` upserts. It emits no
`ExperimentalWarning` — measured under Electron and under node 26.

## Decision
**`node:sqlite`.** It is stdlib, so:

- no native dependency, no ABI rebuild, nothing to go silently wrong on an
  Electron bump;
- no new entry in the boundary lint — `core` still imports "stdlib + node-pty".
  (The lint file gained a *comment* naming `node:sqlite`, `node:http` and
  `node:net` as builtins core deliberately uses, because a deny-list is silent
  about what it permits and that file is meant to be readable as the architecture.)

**The schema version lives in `PRAGMA user_version`, not a `meta` row.** It is a
header field, so it moves atomically with the transaction that earned it and no
`DELETE FROM`, no namespace wipe, no future "clear extension data" feature can
take it out. A version marker that a data operation can erase is a marker that
will one day read `0` on a populated file and re-run every migration over live
rows.

Three rules follow, each implemented and tested:

- **One transaction per migration.** A failure rolls back and leaves the version
  where it was, so the next launch retries *that* migration rather than half of it.
- **A file from a newer build is refused, loudly.** Opening it read-write would let
  an older schema write rows the newer one cannot read back — quiet corruption
  bought with a successful launch.
- **`KV.get` takes the schema at the *read* site**, and a mismatch reads as
  **absent** with a log line rather than throwing. The value on disk was written by
  an earlier version of the code and only today's reader knows what it expects;
  this is a restore path, and an exception here means a bad blob stops the app from
  starting.

Writes are one row via upsert (`ON CONFLICT … DO UPDATE`), which makes
select-by-id structural rather than remembered. Callers that persist a *composite*
(the layout tree) debounce through `core/util/debounce`, which carries a `flush()`
because batching writes is only safe if quitting is one of the things that ends a
batch.

## Consequences
- `node:sqlite` is younger than `better-sqlite3` and has a smaller API. If
  something needs a feature it lacks (custom collations, extensions,
  `WAL` tuning beyond a pragma), that is the moment to revisit — not before. The
  interface callers see is `SqliteStore`/`KV`, so a swap is one file.
- Node's stdlib SQLite is synchronous. In the main process that is a deliberate
  trade: a KV write is a single row and measurably faster than the IPC hop that
  requested it, and an async store would make every persistence call site a state
  machine. A future large query (a task history sweep) should not be added to the
  main process without measuring it.
- Extensions get **`KV`, not SQL.** Raw SQL is a much bigger grant than it looks —
  migrations, corruption blast radius, and a schema other extensions can see. If
  M3's `tasks` proves KV too thin, widen it *then*, with a real consumer to shape
  it. See the sketch's §7c.
- Do not reintroduce a `meta` table for the version. Do not "helpfully" migrate a
  newer file downward.

## Lesson
Two of the three hard parts of this decision were settled by running one command
against the real binary. The design named a dependency, the probe removed it, and
the removal also deleted an ABI rebuild step and an exception to the rule that
keeps the kernel honest. **Probe the runtime before you plan around it** — this is
the same habit that made v1's ADR 0015 correct where 0014 (reasoned from a log
that recorded transitions rather than payloads) was wrong.
