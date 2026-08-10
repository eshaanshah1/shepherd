# A quick-model seam, and a task that names itself — design

**Date:** 2026-08-10
**Status:** approved, not yet implemented
**Decisions:** continues the v2 D-series (D1–D15, owned by the M0–M3 plans) at **D16**.
**Proposes:** ADR 0038 (`agents-core` gains `process.exec`).

## Goal

Two things, and the first exists to serve the second.

**A cheap model, reachable in one line, for work that is small and constant.**
Commit messages, a thread's title, a task's name. §7c already decided this
("does an extension author who wants one smart feature write their own spawn
plumbing and NDJSON parser, or does the SDK make it a line?" — it is a line, and
the primitive is ours). `permission.ts` has shipped an `agents` permission since
M1 whose comment names `complete`/`stream` over `claude -p`. Nothing implements
it. This does the `complete` half.

**A task whose worktree and branch are named by that model, without the model
ever being able to delay a worktree.** Today `titleOf(brief)` takes the brief's
first line, caps it at 72 characters, and that becomes the slug, the directory
and the branch. The branch this document is committed on is
`shepherd-i-wanna-add-a-new-feature-extension-it-s-something`, which is the whole
bug in one string: the composer is deliberately ONE field, so the title *is* the
brief.

## The measurements, because they decide the design

Taken on this machine (2026-08-10, `claude` CLI, subscription OAuth):

| argv | Wall clock | User CPU |
|---|---|---|
| `claude -p --model claude-haiku-4-5`, the user's normal config | 8.3s, 8.9s, 11.3s | ~1.5s |
| + MCP stripped (`--strict-mcp-config --mcp-config '{"mcpServers":{}}'`) | 6.6s, 6.9s, 8.3s | ~1.3s |
| + a `--settings` deny-list instead of a tool flag | 7.5s | 1.25s |
| `--strict-mcp-config --disable-slash-commands --setting-sources user --tools ""` | 8.3s, 7.0s | 1.2s |
| **`--safe-mode --tools ""`** | **6.3s, 5.8s, 6.6s** | **0.72s** |
| `claude --bare -p …` | 0.86s — **and it fails, permanently** | 0.32s |

Four conclusions, each load-bearing:

- **A quick-model call is a ~6 second call, and ~6s is the floor.** With
  `--safe-mode` the CLI's own work is down to 0.72s of user CPU, so roughly 5.5s
  of it is the network round-trip. No flag reaches under that. Every consumer
  must therefore be structurally non-blocking; a timeout is not a design.
- **`--safe-mode --tools ""` is the argv**, and it beats stripping things
  individually. It disables CLAUDE.md, skills, plugins, hooks, MCP servers,
  custom agents, commands and workflows in one flag, while *"Admin-managed
  (policy) settings still apply. Auth, model selection, built-in tools, and
  permissions work normally."* The hand-rolled combination above is slower
  because each of its flags strips one thing — `--disable-slash-commands` is
  skills only, `--setting-sources user` is settings files only — and the halved
  user CPU is the evidence that `--safe-mode` strips more.
- **`--bare` is not available, and no credential will change that.** Its auth is
  *"strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings` (OAuth and
  keychain are never read)"*, while this machine's org-managed
  `/Library/Application Support/ClaudeCode/managed-settings.json` pins
  `forceLoginMethod: "claudeai"` and a `forceLoginOrgUUID` allow-list. The two are
  mutually exclusive by construction, and the CLI says so before doing any work:
  *"This machine's managed settings require a first-party login, but an
  Anthropic-issued credential … is configured. A non-OAuth Anthropic credential
  cannot satisfy the org pin."* Exit 1 in 0.86s. Adding an API key produces that
  same message — it *is* the rejected credential — so `--bare` returns only if
  the org pin changes, which is not ours to change. `--safe-mode` is the flag that
  gives us what we wanted from it anyway.
- **Managed settings merge, they do not get replaced.** The same file injects a
  `PreToolUse` gitleaks hook and an org deny-list, and `--safe-mode` keeps policy
  settings in force. Everything below therefore only ever *narrows* what the call
  may do.

`--safe-mode` is what closes the three hazards the full CLI would have carried
(§Hardening) — and it closes them at the vendor's end, which is why the argv is
two flags rather than four.

## What this is not

- **Not `stream`.** §7c specifies a normalized event union (`text`, `tool-call`,
  `tool-result`, `turn-start`/`turn-end`, `error`, `usage`) plus a `raw`
  passthrough, for a consumer that renders a live agent. No such consumer exists.
  `complete` is one prompt in, one string out; the kind interface is shaped so
  the streaming half slots in beside it without moving anything.
- **Not a settings system.** v2 has none (there is no config API in
  `packages/core/src` and no v2 counterpart to v1's `SettingsView`). This adds one
  override key in `agents-core`'s own KV and one CLI verb, and nothing else.
- **Not a rename.** Nothing this design does ever moves a worktree, renames a
  branch, or moves a task root. See D19.
- **Not a second title field.** The composer's one-field design stays.

> **Superseded.** This design also put the derived name on the card as a
> read-only line, on the reasoning that a model in the middle of naming is only
> predictable if the name is on screen. Lived with, it read as the brief echoed
> back under the brief, re-rendering per keystroke while you were still writing the
> sentence it was quoting — a preview of something you are mid-way through saying
> is not information. The line is gone; the ask below is unchanged and its answer
> reaches `tasks.create` exactly as described.

## Architecture

### 1. The seam — `agents.complete`

`agents-core` registers one command:

```ts
'agents.complete'
  args:   { prompt: string, system?: string, maxTokens?: number, timeoutMs?: number }
  answer: { ok: true, text: string }
        | { ok: false, reason: 'no-kind' | 'timeout' | 'failed' | 'empty', message: string }
  permission: 'agents'
```

**A command, not a method on the API returned from `activate`.** This is the
load-bearing choice and it is about enforcement. `CommandSpec.permission` exists
and `authorize()` (`packages/core/src/commands/authorize.ts`) checks it against
the caller's grants in the dispatcher before any handler runs. An object handed
over by `extensions.get` has no dispatcher in between, so the `agents` permission
would be decorative — `agents-core` would have to re-implement the authorizer to
find out who was calling. Routing it as a verb makes the grant real, and it means
a consumer needs no `dependencies` entry (a command is public vocabulary; `tasks`
already invokes `agents.resumeTarget` with no declared dependency).

**It never throws and never hangs.** Every failure is one of the four reasons
above, and the deadline is the caller's (ADR 0030's rule, restated here because a
model call is the most tempting place to forget it).

`AgentKind` grows the half §7c drew:

```ts
readonly headless?: {
  /** This vendor's cheap tier. The ONLY place in the codebase a model id may appear. */
  readonly quickModel: string;
  argv(input: { prompt: string; model: string; system?: string }): readonly string[];
  /** stdout → the answer, or undefined if this output carries none. */
  parse(stdout: string): string | undefined;
};
```

`capabilities` — already present, already commented "Consumed by the headless
seam, which is **not** in M2" — becomes consumed. A kind with no `headless` half
answers `no-kind`.

### 2. Hardening the argv (`claude-code`'s half)

```
claude -p <prompt> --model <quickModel> --safe-mode --tools ""
```

Two flags, and each closes hazards that were separately measured:

- **`--safe-mode`** disables CLAUDE.md discovery, skills, plugins, hooks, MCP
  servers, custom agents, commands and workflows, while auth, model selection and
  policy settings keep working. It is worth ~2s against the plain call, and it
  closes two hazards that would otherwise need handling here:
  - **CLAUDE.md discovery.** The full CLI reads it; this repo's is ~46k tokens.
    Naming a task must not cost a repo's context or its latency.
  - **Shepherd's own hooks.** The full CLI loads them, including `report.sh`,
    which reads `SHEPHERD_TAB_ID`/`SHEPHERD_SOCK` and would report this nested
    call's lifecycle as some pane's. `kind.ts` already anticipates the symptom —
    its `ignore` decision exists partly for "a foreign nested `claude -p`".
- **`--tools ""`** — the documented form ("Use `""` to disable all tools"). A call
  whose entire job is to return six words has no business holding a file handle.
  Preferred over a `--settings` deny-list, which would enumerate vendor tool names
  and rot as that set changes. Note `--max-turns` does **not** exist in the
  installed CLI.

### 2b. The child's environment is an allow-list, and it has a trap in it

`runExec` (`packages/platform/darwin/src/exec.ts:210`) **replaces** the
environment rather than merging it — `{...opts.env, PATH: execPath(…)}`, with the
comment "the caller's env is kept exactly as given except for PATH". Only
`runGit` merges. So a naming call inherits *nothing* unless we pass it, which is
better than stripping: `SHEPHERD_TAB_ID`, `SHEPHERD_SOCK`, `SHEPHERD_CTL_SOCK` and
`NODE_OPTIONS` are absent because nothing is present, and the hook correlation is
severed by construction rather than by remembering a deny-list.

The trap is what the CLI needs in that empty environment, and it was measured
rather than guessed:

| env | Result |
|---|---|
| `HOME` + `PATH` | **"Not logged in · Please run /login"**, 2.09s |
| `HOME` + `PATH` + `LOGNAME` | **"Not logged in · Please run /login"** |
| `HOME` + `PATH` + `USER` | answers normally |

So the allow-list is exactly **`{ HOME, USER }`** — `PATH` is `runExec`'s. `USER`
is load-bearing for the keychain lookup that OAuth needs, and `LOGNAME` is not a
substitute for it. Getting this wrong does not fail loudly: it produces a
perfectly quick "please run /login" that reads exactly like a machine that was
never authenticated.

`HOME` is `ctx.homeDir`. `USER` has no counterpart on `ExtensionContext`, and an
extension may not reach `node:os` (`boundaries.js` denies it, and `homeDir` exists
for precisely that reason). Hence **D25**.

Two more things the spawn does itself:

- **cwd is `agents-core`'s `dataDir`**, never a repo — defence in depth behind
  `--safe-mode`, and it keeps the call away from a repo's git state. `dataDir` is
  not created for you (`ExtensionContext`), so `complete.ts` creates it on first
  use.
- **stdout is capped** (4 KiB) before `parse` sees it.

### 3. Configuring the model

One optional key in `agents-core`'s own KV: `{ kind?: string, model?: string }`.
Absent, the default kind's declared `quickModel` wins. Set through an
`agents.quickModel` command, reachable from `shepherd` like every other verb.

The `kind` half is not speculative — §7c says "which kind runs is the consumer's
choice or, omitted, the user's configured default", and the smoke test needs it
(§Testing).

### 4. Naming a task

**The model returns a short title, not a slug.** `slugify` already makes
traversal unrepresentable and `uniqueSlug` already resolves collisions once (D8);
handing that pipeline a good six-word title yields a good branch for free, and
fixes the sidebar row as a side effect — the row label is `task.title`, which is
currently the first 72 characters of your paragraph.

Four parts:

1. **`tasks.suggestName`**, a command mirroring `tasks.suggestRepos` exactly: the
   composer asks its own extension a question, and the extension asks the model
   (D5's pattern — the page cannot reach the point, and must not learn how).
   `tasks` adds `agents` to its manifest permissions.
2. **The composer** fires it on the brief's existing `onBlur` and on a ~2s idle
   pause, with the `asked.current` sequence counter already in the file deciding
   which answer is still wanted. It renders one dim line under the brief: the
   braille spinner (`useBrailleFrame` — Rule 7; pulses and shimmer are banned)
   with `naming…`, replaced by `→ <slug>` when an answer lands. Read-only.
3. **`tasks.create` accepts an optional `name`** — what the composer already has
   — beside `title`/`brief`, exactly as `--repo` and the repo field are two doors
   into one verb. The CLI gets `--name` for free.
4. **The race, when Create was pressed and no name has landed.** Below.

### 5. The race

`tasks.create` stays synchronous and stays optimistic (D12): the record is
written with the heuristic name and returned immediately, and provisioning fills
in behind it. Inside `runProvision`, before the first git write:

```
create ──▶ record + row visible (0ms)
           │
           ├─ name ask ────────────────▶ ~6s ──┐
           └─ readRepoRefs(repo 0) ─▶ ~2.5s ───┤
                                               ▼
                              addWorktree (0.16s) ── good branch

deadline (4s) blown ─▶ keep the heuristic slug ── okay branch
```

`provisionRepo` splits into two functions, which is the only structural change
to a file whose comments are load-bearing:

- **`readRepoRefs(process, repo, timeoutMs)`** — the opportunistic fetch and the
  four ref reads (`for-each-ref` ×2, `worktree list --porcelain`,
  `symbolic-ref`). Needs only `repo.path`, which is why it can run before a name
  exists.
- **`addWorktree(process, repo, branch, dest, refs)`** — `resolveBranch` and the
  `gitWrite`. Needs the name.

`runProvision` starts `readRepoRefs` for the first repo, then awaits the pending
name with a 4s deadline, then proceeds. The loop stays sequential and per-repo
("in order of landing") and per-repo state reporting is untouched; repos 1..n
have their name already and read their own refs as they always did.

**Two clocks, deliberately.** The ask's own timeout is ~15s — it may outlive the
composer that started it. How long *provisioning* will wait for it is 4s. A
consumer's patience and a call's lifetime are different facts, and collapsing
them is how the 4s deadline would silently become the ask's timeout for every
other consumer.

### 6. The slug's one permitted change

D8 says the slug is derived once and stored, because a re-derived slug would let
two tasks with one title share a directory. That stands. What this adds is a
single, bounded exception, and it is stated as an invariant rather than left
implicit:

> **The slug may change exactly once, before the first git write, and never
> after.**

At that moment the record has empty `sessions` and no `archives`, nothing on disk
is named after it, and no pane has a cwd inside it. The rewrite re-checks
`takenSlugs()` (a concurrent create may have taken the name in between) and calls
`store.put` once. After the first `worktree add`, the slug is immutable — which
is what keeps every consequence of a rename (`git branch -m`, `git worktree
move`, moving the task root and re-synthesizing its `CLAUDE.md` and symlinks,
re-seeding `~/.claude.json` trust, a running agent's cwd) out of this design
entirely.

No schema change. `slug` stays required and stays a string.

### 7. When the name arrives late

A name that misses the 4s deadline — or the CLI path, where nobody was typing and
there was no speculation window — still updates `task.title`. That is display
only: it reaches the sidebar row and the pane titles, and a pane is already
renameable through `layout.rename` (the call `startSession` already makes). The
slug and the branch keep the heuristic name.

So the slow path costs a branch name and never a row label.

### 8. The fallback you actually see

`heuristicName(brief)` — a pure function, because the fallback is what you get
whenever the model is slow, off, or unauthenticated, and today's is bad. Strips
leading filler (`#shepherd`, `I wanna`, `I want to`, `can you`, `please`, `let's`),
takes the first sentence, caps at ~6 words for the slug. `titleOf` keeps its
current job for the title.

## Decisions

- **D16 — the seam is a command, not an exported method.** Only the dispatcher
  can enforce `agents`, and `CommandSpec.permission` is where that happens. As a
  bonus, a consumer needs no `dependencies` entry.
- **D17 — `agents-core` owns the spawn, and therefore gains `process.exec`
  (ADR 0038).** The alternative is each kind spawning for itself, which is the
  exact failure §7c invoked to justify the seam ("if every extension hand-rolls
  it, they each do it badly and differently") — the deadline, the output cap, the
  concurrency limit, the env stripping and the never-throws contract all want one
  owner. The cost is real: the extension that is deliberately the only writer of
  `attention` takes the heaviest grant in the vocabulary. Confined by three
  rules: exec lives in one file, argv comes only from a registered kind, and a
  caller's influence is limited to the prompt text.
- **D18 — the model returns a title; `slugify` derives the branch.** One call
  answers both needs, and the careful pipeline (D8) is reused rather than
  bypassed. Asking for a kebab-case name and back-deriving a human title would
  make the sidebar read like a branch list.
- **D19 — nothing is ever renamed.** The slug's one permitted change (§6) is the
  whole of the mutability, and it is bounded to a window in which nothing on disk
  or on screen refers to it.
- **D20 — two clocks: the ask's timeout (~15s) and provisioning's patience
  (4s).** An ask may outlive the composer that started it.
- **D21 — the composer's ask is provisioning's ask.** `tasks` keeps a
  single-entry cache of `{ brief, promise }`, so a request still in flight when
  Create is pressed is awaited rather than duplicated. Without this, the exact
  case the speculation exists for — Create pressed a second before the answer
  lands — spends the budget twice and waits ~6s from scratch.
- **D22 — the ask is rate-limited by content, not by a timer alone.** Only asked
  when the brief is ≥24 characters, only re-asked when it has changed by ≥20
  characters since the last ask, single-flight per brief. §7c named budget as the
  reason `agents` is its own permission; a per-keystroke debounce on a paragraph
  would spend it several times per task.
- **D23 — an in-flight call cannot be cancelled, and that is stated rather than
  hidden.** `ExecOptions` *does* carry a `signal`, but `createProcess`
  (`packages/app/src/ext-host/api.ts:722`) honours it on this side only: "an
  `AbortSignal` is not clonable, so it is honoured here: an already-aborted call
  fails without sending anything. (Aborting a call already in flight is not yet
  expressible — there is no cancel frame.)" So passing a signal buys a pre-flight
  refusal and nothing more: a ~6s naming call whose composer has closed runs to
  completion and has its answer dropped by the sequence counter. The signal is
  passed anyway, because a queued call that nobody wants any more should not
  start. Adding a cancel frame to `ProcessAPI` is a kernel change this feature
  does not need.
- **D25 — `ExtensionContext` gains `userName`.** `USER` is required for the CLI's
  OAuth to find its credentials (§2b), the child environment is an allow-list, and
  an extension cannot compute the value: `boundaries.js` denies `node:os`, which is
  the same reason `homeDir` is on the context — "the host resolves it … an
  extension may not reach `node:os` and so cannot compute a path". Reading the
  `process` global instead would pass lint (only `document`/`window`/`navigator`
  are restricted globals) and would still be the thing that rule exists to
  prevent. One field, resolved host-side, next to the one whose comment already
  argues for it.
- **D24 — a failed model call logs at `info`, not `warn`.** An unavailable model
  is not a fault of the task, and provisioning's warn channel is for things a
  user should act on (a repo that failed, a hook that complained).

## Failure modes

| What fails | What happens |
|---|---|
| no kind registers a `headless` half | `no-kind`; heuristic name; one info line |
| `claude` missing, or not authenticated | `failed`; heuristic name |
| the model answers after 4s | heuristic branch, model title |
| the model answers junk (backticks, quotes, a refusal, a paragraph) | `readName` sanitizes; unusable → heuristic. **Observed in three of seven measured calls: the answer came back wrapped in backticks.** This is the most likely defect in the whole feature and it is the cheapest to table-test |
| the model answers something that slugifies to nothing | `slugify`'s existing `FALLBACK` (`task`), then `uniqueSlug` |
| the brief is empty | no ask (D22); Create is already disabled |
| `USER` missing from the child env | "Not logged in · Please run /login" in ~2s — indistinguishable from an unauthenticated machine, which is why §2b's allow-list is asserted by a test rather than trusted |
| two creates race for one name | `uniqueSlug` at both the write and the rewrite |

## Testing

**Pure and table-driven** (the bulk of it, and where the bugs will be):
`readName` sanitation — backticks, quotes, trailing periods, multi-line, a
refusal sentence, an over-long answer, path-traversal junk; `heuristicName` over
real briefs including this document's own; `namingPrompt` stability; the argv
builder, asserting the hardening flags and the stripped variables are all
present.

**`agents-core`**: `complete` over a fake `ProcessAPI` — deadline, empty stdout,
non-zero exit, no kind, a kind with no `headless` half, the output cap, the
concurrency limit.

**The race**: `runProvision` with an injected name promise that resolves before
and after the deadline. Asserts the slug is committed once and never after the
first git write.

**Smoke — and this one is required, not optional.** `CLAUDE.md` is explicit: "a
green unit suite is not a working app, and this repo has the scars… run `pnpm
smoke:m3` before calling any task/layout/composer work done", and the scar it
names is precisely a test that supplied both halves of a correlation. The race
test above supplies both halves. So `smoke:m3` gains a case that creates a task
through the real composer and asserts the branch **on disk** carries the model's
name.

It must not depend on the network to do it. `diagnostics` — dev-gated already —
registers a stub kind whose `headless` half echoes a fixed name, and the smoke
run selects it with `agents.quickModel { kind: 'diagnostics.stub' }`. That is
why the `kind` half of the override is in scope (§3): the alternative is a test
hook inside production code.

## Files

**`v2/packages/sdk`** — `ExtensionContext.userName` (D25). `AgentCapabilities` is
already there.

**`v2/packages/app`** — `ext-host`/`ext-host-process` fill `userName` when they
build a context, beside `homeDir`.

**`v2/extensions/agents-core`**
- `src/manifest.ts` — `agents.complete`, `agents.quickModel`; `process.exec` added
- `src/kind.ts` — the `headless` half
- `src/complete.ts` — **new**, the only file that spawns: deadline, cap,
  concurrency, env stripping
- `src/quick-model.ts` — **new**, pure: resolve override + kind → `{kind, model}`

**`v2/extensions/claude-code`**
- `src/index.ts` / `src/kind.ts` — the `headless` half and its argv

**`v2/extensions/tasks`**
- `src/manifest.ts` — `tasks.suggestName`; `agents` permission
- `src/model/naming.ts` — **new**, pure: `namingPrompt`, `readName`, `heuristicName`
- `src/index.ts` — `tasks.suggestName`; `name` on `create`; the pending-name
  cache (D21); the deadline and the one permitted `store.put` (D19/§6)
- `src/provision.ts` — split into `readRepoRefs` and `addWorktree`
- `ui/composer.tsx` — the ask on idle, which draws nothing

**`v2/extensions/diagnostics`** — the stub kind, for smoke

**`v2/tests`** — the `smoke:m3` case

**Docs** — ADR 0038; `docs/control-cli.md` for `agents quick-model`; `CLAUDE.md`'s
v2 section, since `agents-core` holding `process.exec` is exactly the kind of
fact that file exists to record.

## Deferred

- `stream`, its normalized event union and `raw` — until a consumer renders a
  live agent (§7c's third tier).
- A real settings system, with the quick model as one of its rows.
- A faster transport. **Not `--bare`** — the org pin forbids its auth mode and a
  key cannot satisfy it (§Measurements), so that door is closed for as long as
  this laptop is managed. The remaining route is a direct API call registered as
  its own kind, at which point the 4s deadline stops being reachable and no
  consumer changes. ~5.5s of the current ~6s is network, so a faster *transport*
  is the only thing left that could matter; there is no flag left to find.
- Other consumers: commit messages, a pane's title. The seam is the same line;
  each is its own small piece of work.
- `CLAUDE_CONFIG_DIR` in the allow-list. v1 has Claude profiles
  (`ClaudeProfiles.swift`) and v2 has no counterpart yet; when it gets one, the
  naming call has to run under the selected profile's config dir, which is one
  more entry in §2b's allow-list and a fact only `claude-code` may know.
