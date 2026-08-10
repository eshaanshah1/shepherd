# 0037. (v2) `agents-core` spawns the model, so a kind does not

Status: Accepted
Date: 2026-08-10
Scope: `v2/` only.
Implements: sketch §7c's `complete` half, and the `agents` permission that
`packages/sdk/src/permission.ts` has declared since M1 without an implementation.

## Context

§7c settled that asking a model something is the SDK's job rather than each
extension's: "does an extension author who wants one smart feature write their own
spawn plumbing and NDJSON parser, or does the SDK make it a line? It is a line,
and the primitive is ours." What it did not settle is **which process spawns**.

A kind supplies `argv` and `parse` — the vendor's whole surface. Somebody then has
to run it, with a deadline, an output cap, a concurrency limit and an environment.
Two places could:

1. **The kind.** `claude-code` already holds `sessions` and `storage`; it would
   need `process.exec` and would own the run.
2. **`agents-core`.** It holds `sessions`, `storage` and `attention` — deliberately
   narrow, and notably the **only** extension in the repo declaring `attention`, so
   that "agents-core is the only writer of agent attention" is enforced by manifest
   rather than by review (ADR 0026).

Option 1 keeps `agents-core` free of the heaviest grant in the vocabulary. Option 2
concentrates the grant but keeps the mechanism in one place.

Measured while deciding, because the numbers shaped the mechanism (2026-08-10, this
machine, subscription OAuth):

| argv | Wall clock | User CPU |
|---|---|---|
| `claude -p --model claude-haiku-4-5`, normal config | 8.3 / 8.9 / 11.3s | ~1.5s |
| + MCP stripped by hand | 6.6 / 6.9 / 8.3s | ~1.3s |
| `--strict-mcp-config --disable-slash-commands --setting-sources user --tools ""` | 8.3 / 7.0s | 1.2s |
| **`--safe-mode --tools ""`** | **6.3 / 5.8 / 6.6s** | **0.72s** |
| `claude --bare -p …` | 0.86s — **and it fails** | 0.32s |

## Decision

**`agents-core` spawns, and takes `process.exec` to do it.** A kind declares
`headless: { quickModel, argv, parse }` and nothing else.

Confined by three rules:

- the spawn lives in `complete.ts` **alone**;
- its argv comes only from a **registered kind**, never from a caller;
- a caller's influence stops at the **prompt text**.

The seam is exposed as a **command** (`agents.complete`), not as a method on the
API `activate` returns. That is about enforcement rather than style:
`CommandSpec.permission` is checked by `authorize()` in the dispatcher before any
handler runs, while an object handed over by `extensions.get` has nothing in
between. As a method, the `agents` permission would be decorative and `agents-core`
would have to re-implement the authorizer to learn who was calling.

## Consequences

**What this buys.** One owner for the deadline, the 4 KiB output cap, the
concurrency limit, and the child's environment. Option 1's cost is the failure §7c
invoked to justify having a seam at all: "if every extension hand-rolls it, they
each do it badly and differently" — the same argument that made one `ProcessAPI`
with `gitRead`/`gitWrite` correct rather than letting each extension write git
runner #4.

**What it costs.** The extension that is deliberately narrow now holds the grant
that means "can run arbitrary programs". The three rules above are the whole of the
containment, and they are conventions in one file rather than anything the loader
checks. A future reviewer should be suspicious of any second `exec` call in this
extension.

**The environment is an allow-list, and this is the trap.** `runExec`
(`packages/platform/darwin/src/exec.ts`) **replaces** the child's environment
rather than merging it — only `runGit` merges. So a nested model call inherits
nothing unless named, which is the safe direction: `SHEPHERD_TAB_ID` and
`SHEPHERD_SOCK` cannot leak into it and have its lifecycle reported as some pane's,
because they are not there at all.

What it must be handed was measured rather than reasoned:

| env | Result |
|---|---|
| `HOME` + `PATH` | **"Not logged in · Please run /login"**, 2.09s |
| `HOME` + `PATH` + `LOGNAME` | **"Not logged in · Please run /login"** |
| `HOME` + `PATH` + `USER` | answers normally |

So the list is exactly `{ HOME, USER }` (`PATH` is `runExec`'s). **Do not trim
it.** Getting this wrong does not fail loudly — it produces a fast, confident
"please run /login" that reads exactly like a machine nobody ever signed in on.
`USER` has no counterpart on `ExtensionContext`, and `boundaries.js` denies
`node:os` to extensions, so `userName` was added to the context beside `homeDir` —
which exists for that same reason.

**`--bare` is not available, and no credential will change that.** Its auth is
"strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings` (OAuth and
keychain are never read)", while this machine's org-managed
`/Library/Application Support/ClaudeCode/managed-settings.json` pins
`forceLoginMethod: "claudeai"` with a `forceLoginOrgUUID` allow-list. The two are
mutually exclusive by construction, and the CLI says so before doing any work:
*"A non-OAuth Anthropic credential cannot satisfy the org pin."* Adding an API key
produces that same message — it **is** the rejected credential. `--safe-mode` gives
what we wanted from it anyway, and keeps auth working.

**~6s is the floor, so no consumer may wait on this.** With `--safe-mode` the
CLI's own work is 0.72s of user CPU; the rest is the network round-trip. That is
why the first consumer (task naming) overlaps the call with the per-repo `git
fetch` and gives up after 4s rather than blocking — and why **a task's slug may
change exactly once, before its first git write, and never after**. That invariant
is what keeps `git branch -m`, `git worktree move`, a task root moving under a
booting agent, and re-seeding Claude Code's trust out of the codebase.

**Not implemented: `stream`.** §7c specifies a normalized event union plus a `raw`
passthrough for a consumer that renders a live agent. No such consumer exists, so
the kind interface is shaped for it to slot in beside `headless` without moving
anything, and that is all.

**Cancellation is not expressible.** `ExecOptions` carries a `signal`, but
`createProcess` (`packages/app/src/ext-host/api.ts`) honours it on the child's side
only — "an `AbortSignal` is not clonable … aborting a call already in flight is not
yet expressible; there is no cancel frame". A ~6s call whose caller has stopped
caring runs to completion and has its answer dropped. Adding a cancel frame is a
kernel change this did not need.
