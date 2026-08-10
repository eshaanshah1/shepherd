# A quick-model seam, and a task that names itself — design

**Date:** 2026-08-10
**Status:** approved, not yet implemented
**Decisions:** continues the v2 D-series (D1–D15, owned by the M0–M3 plans) at **D16**.
**Proposes:** ADR 0037 (`agents-core` gains `process.exec`).

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

| What | Wall clock |
|---|---|
| `claude -p --model claude-haiku-4-5` with the user's normal config | 8.3s, 8.9s, 11.3s |
| the same with MCP stripped (`--strict-mcp-config --mcp-config '{"mcpServers":{}}'`) | 6.6s, 6.9s, 8.3s |
| `claude --bare -p …` | 0.86s — **and it fails** |

Three conclusions, each load-bearing:

- **A quick-model call is a ~7 second call, not a ~500ms one.** ~1.5s of that is
  user CPU; the rest is CLI startup, plugin/hook loading and the network. So
  every consumer must be structurally non-blocking. A timeout is not a design.
- **`--bare` is not available to us.** It reads "Anthropic auth is strictly
  `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings` (OAuth and keychain are
  never read)", so under subscription auth it exits in 0.86s having done nothing.
  It would have skipped hooks, plugin sync, keychain reads and CLAUDE.md
  discovery — everything we want skipped — and we cannot have it. Revisit the day
  a key is in `ctx.secrets`; the seam's shape does not change if so.
- **MCP off is worth ~2–3s** and is free to pass.

Because `--bare` is out, the naming call runs the **full** CLI, and three
consequences follow that the argv has to handle (§Hardening).

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
- **Not a second title field.** The composer's one-field design stays; what it
  gains is a read-only preview of a consequence it currently hides.

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

Because the full CLI runs, `claude-code`'s `argv` and the spawn around it must
neutralize what it loads. Each item below is a measured hazard, not a
precaution:

- **`--strict-mcp-config --mcp-config '{"mcpServers":{}}'`** — worth 2–3s.
- **cwd is `agents-core`'s `dataDir`**, never a repo. The full CLI
  auto-discovers `CLAUDE.md`; this repo's is ~46k tokens. Naming a task must not
  cost a repo's context and latency. `dataDir` is not created for you
  (`ExtensionContext`), so `complete.ts` creates it on first use.
- **`SHEPHERD_TAB_ID`, `SHEPHERD_SOCK` and `SHEPHERD_CTL_SOCK` are stripped from
  the child env.** The full CLI loads hooks, including Shepherd's own
  `report.sh`, which reads exactly those variables and would report this nested
  call's lifecycle as some pane's. `kind.ts` already anticipates the symptom —
  its `ignore` decision exists partly for "a foreign nested `claude -p`" — but
  the fix belongs at the spawn, where the correlation is severed rather than
  filtered afterwards.
- **`NODE_OPTIONS` is stripped**, for the reason the whole repo strips it.
- **Tools are denied outright**, via
  `--settings '{"permissions":{"deny":["Bash","Edit","Write","Read","Glob","Grep","WebFetch","WebSearch","Task"]}}'`.
  A call whose entire job is to return six words has no business holding a file
  handle. This exact form is measured working (7.5s, answer returned). Note
  `--max-turns` does **not** exist in the installed CLI, and `--allowed-tools` is
  variadic so it has no empty form — the deny list is the mechanism, and the list
  is a `claude-code` fact that moves when the vendor's tool set does.
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
           ├─ name ask ────────────────▶ ~7s ──┐
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
  (ADR 0037).** The alternative is each kind spawning for itself, which is the
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
  lands — spends the budget twice and waits ~7s from scratch.
- **D22 — the ask is rate-limited by content, not by a timer alone.** Only asked
  when the brief is ≥24 characters, only re-asked when it has changed by ≥20
  characters since the last ask, single-flight per brief. §7c named budget as the
  reason `agents` is its own permission; a per-keystroke debounce on a paragraph
  would spend it several times per task.
- **D23 — no cancellation, and that is stated rather than hidden.** `ExecOptions`
  carries `timeoutMs` and no abort signal, so a call nobody wants any more runs
  to its own timeout and its answer is dropped by the sequence counter. Adding
  abort to `ProcessAPI` is a kernel change this feature does not need.
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

**`v2/packages/sdk`** — `AgentCapabilities` is already there; nothing to add.

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
- `ui/composer.tsx` — the ask on blur and idle, the preview line

**`v2/extensions/diagnostics`** — the stub kind, for smoke

**`v2/tests`** — the `smoke:m3` case

**Docs** — ADR 0037; `docs/control-cli.md` for `agents quick-model`; `CLAUDE.md`'s
v2 section, since `agents-core` holding `process.exec` is exactly the kind of
fact that file exists to record.

## Deferred

- `stream`, its normalized event union and `raw` — until a consumer renders a
  live agent (§7c's third tier).
- A real settings system, with the quick model as one of its rows.
- A faster transport. If a key ever lands in `ctx.secrets`, `--bare` becomes
  available (0.86s startup) or a direct API call does; either registers as a kind
  and no consumer changes. The 4s deadline simply stops being reachable.
- Other consumers: commit messages, a pane's title. The seam is the same line;
  each is its own small piece of work.
