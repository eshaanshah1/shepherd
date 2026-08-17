# A Claude Code transcript parser — one fold, two tiers

**Date:** 2026-08-17
**Status:** design agreed, not yet planned
**Touches:** `extensions/recall` → renamed `extensions/transcripts`, plus the seven files that name it (`packages/app/package.json`, `ext-host/builtins.ts` + its test, `main/index.ts`, the extension's own `package.json` / `vitest.config.ts` / `manifest.ts`). Not `boundaries.js`: its per-extension `denyExact` list covers only extensions with a `ui` half, and this one draws nothing.
**Predecessor:** [`2026-08-13-recall-session-search-design.md`](2026-08-13-recall-session-search-design.md) — that design still holds; this one widens the module underneath it.
**Prior art:** [stablyai/orca](https://github.com/stablyai/orca), `src/main/native-chat/**` and `src/main/claude-usage/**`.

---

## 1. What this is, and what already exists

Shepherd already parses Claude Code transcripts. `extensions/recall/src/model/`
folds `~/.claude/projects/**/*.jsonl` into a `SessionDigest` — user text,
assistant text, titles, agent name, `/recap` summaries — and its own header
states the reason it keeps so little: *"481 MB of session files hold 14.8 MB of
conversation — tool calls and tool output are the other 97%."*

That is the right parser for search and the wrong one for everything else. It
cannot say which tool ran, what it returned, how many tokens a session cost, or
whether the last turn finished. This design adds the tier that answers those,
**without giving up the property that makes search fast**.

The shape is one parser and two projections:

- the **full parse** — every content block, every tool call and result, usage,
  lifecycle — streamed on demand, never cached to disk;
- the **digest** — today's search shape, *derived from* the full parse rather
  than produced by a second reader, and cached exactly as today.

Deriving rather than duplicating is the load-bearing decision. Two parsers over
one file format drift, and the drift is invisible: search would quietly stop
agreeing with what a rendered transcript shows.

## 2. What the corpus actually contains

Measured on this machine, 2026-08-17, `~/.claude/projects`:

| | |
|---|---|
| project directories | 141 |
| `.jsonl` files, total | 864 |
| `.jsonl` files recall sees (it does not recurse) | 718 |
| on disk | 469 MB |
| `subagents/` directories | 29 |

Four findings changed this design. Three of them contradict something.

### 2.1 Thirteen record types exist; orca decodes two

Across a 40-file sample:

```
2604 assistant     390 ai-title            125 file-history-snapshot
1660 user          375 permission-mode      122 pr-link
 433 last-prompt   375 mode                  82 file-history-delta
 415 attachment    195 queue-operation       15 agent-name
 176 system
```

Orca's `decodeClaudeTranscriptLine` returns `null` for every `type` that is not
`user` or `assistant`. Recall handles six (`user`, `assistant`, `system`,
`ai-title`, `custom-title`, `agent-name`). Neither reads `attachment`,
`last-prompt`, `pr-link`, or the `file-history-*` pair.

**Decision:** the parser keeps a typed union of what it understands and a
`type: 'unknown'` fallback carrying the raw record. It does not silently drop.
Dropping is what makes a format parser rot — the next Claude Code release adds a
record type and nothing anywhere says so. An unknown record costs one object and
is invisible to every consumer that does not ask for it.

### 2.2 Assistant rows are duplicated ~2×, and naive token sums are wrong by 2.7×

In one 200 KB+ session (`30b2cf57…`):

- assistant records: **434**
- distinct `message.id`: **203**

Summing `message.usage.output_tokens` across every row gives **732,808**.
Grouping by `message.id` and taking the max per group gives **273,005**.

**Naive summing over-counts by 2.7×.** This is the single most valuable thing to
port from orca, and it is not a theoretical concern — it is the difference
between a usage number that is useful and one that is fiction. Orca's rule, which
this design adopts wholesale: dedupe on `message.id:requestId`, falling back to
`msg:<id>` then `uuid:<id>`, and take `Math.max` per field on collision, because
a later duplicate row can carry *more* complete usage than the first.

### 2.3 `isSidechain` does not appear; subagent turns live only in sibling files

Orca reads an `isSidechain` flag on records. In this corpus it appears **zero**
times — including in a session that demonstrably ran subagents (`204c2bc8…`, 1.2
MB, with a populated `subagents/` directory beside it).

Subagent conversation lives entirely in sibling files, at a layout confirmed here:

```
<projects>/<encoded-dir>/<session-uuid>.jsonl
<projects>/<encoded-dir>/<session-uuid>/subagents/agent-<id>.jsonl
```

A sampled subagent file holds `assistant`, `user` and `attachment` records — an
ordinary transcript, not a special format.

**Decision:** subagents are a **file-discovery** concern, not a record-flag one.
The parser finds them by path and parses each with the same fold. The
`isSidechain` field is still read when present (older or future versions may
carry it) but nothing depends on it.

Note this also means recall is not miscounting subagents today — it does not
recurse, so it simply never sees them. 864 files exist; it reads 718.

### 2.4 Orca's session-id warning does not reproduce here

Orca's `agent-session-resume.ts` warns that *"recent Claude Code versions name
the transcript file with a UUID that differs from the hook `session_id`, so
reconstructing the path from `id` alone fails."*

Checked against 120 files on this machine: `sessionId` inside the file equals the
filename stem in **120 of 120**.

**Decision:** the divergence is not designed around. The parser still accepts an
explicit `transcriptPath` from a caller that has one, because a caller holding
the authoritative path should never be made to guess — but id→path discovery
stays the ordinary route, and no code compensates for a divergence this corpus
does not show. If it appears later, the escape hatch is already there.

## 3. Module shape

The extension is renamed **`recall` → `transcripts`** (`shepherd.recall` →
`shepherd.transcripts`). It is one extension, one walk of the corpus, one index.
The name is changing now because it is about to stop being a search extension and
the rename is a handful of references today.

Placement was decided against two alternatives:

- **A second extension** owning the parse, with `transcripts` consuming it, is
  barred by cost rather than taste: `boundaries.js` permits only *type* imports
  between extensions, so every file's parse would cross a port, and two
  extensions would each walk 469 MB.
- **A shared package** under `packages/` would allow value imports and a clean
  boundary, but it puts a vendor's file format in the kernel layer — the one
  thing the moat argument in `CLAUDE.md` forbids. It would need its own ADR
  arguing the exception, and there is no need to spend that.

The vendor's format belongs in an extension, and this is the extension that
already reads it.

```
extensions/transcripts/
  src/
    model/          # pure. one record -> typed values. no IO.
      record.ts     #   safe accessors over `unknown` (exists today)
      blocks.ts     #   content blocks
      message.ts    #   record -> TranscriptMessage
      noise.ts      #   harness-injected-turn classifier
      lifecycle.ts  #   working | completed | interrupted
      usage.ts      #   tokens + the dedup rule of §2.2
    parse/
      session.ts    #   the fold: chunk -> ParsedSession
      digest.ts     #   ParsedSession -> SessionDigest (the search projection)
      subagents.ts  #   sibling-file discovery, §2.3
    store.ts        # the index. caches digests only.
    watch.ts        # the live tail
    index.ts        # activate: the search point, the commands, the events
```

### 3.1 `model/` — pure, and every function takes `unknown`

The existing rule stands and is restated because it is the reason this layer
survives format drift: *a record is a line of somebody else's file format, so a
cast here would be a promise this code cannot keep.* Everything returns `null`
rather than throwing.

**`blocks.ts`** decodes a content array into
`text | thinking | tool-call | tool-result | image`. The one subtlety worth
porting verbatim is orca's `toolResultOutput`: a `tool_result`'s `content` is a
string, *or* an array of blocks, *or* an object with `text`/`content`, depending
on which tool produced it. All three appear in practice.

**`message.ts`** produces a `TranscriptMessage`:

```ts
interface TranscriptMessage {
  readonly uuid: string;
  readonly parentUuid: string | null;   // threading
  readonly role: 'user' | 'assistant' | 'tool' | 'system';
  readonly blocks: readonly Block[];
  readonly ts: number | null;
  readonly model: string | null;
  readonly usage: Usage | null;
  readonly isMeta: boolean;
  readonly isCompactSummary: boolean;
}
```

Two rules come straight from orca and both are non-obvious:

- **An injected meta turn keeps only its `tool-result` blocks.** Claude marks
  injected turns (`isMeta`, `isSynthetic`, `isCompactSummary`), but a tool result
  arriving inside one is genuine output and must stay visible. Dropping the whole
  record loses real work.
- **A user record whose blocks are all tool-results has the role `tool`,** not
  `user`. It is the harness returning output to the model, not a person typing.

**`noise.ts`** replaces recall's current filter, which is a real defect. Today:

```ts
const withoutTags = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();
if (withoutTags === '') return null;
```

A prompt whose entire content is a markup snippet — pasting `<div>hi</div>`, or
two XML fragments and nothing else — reduces to the empty string and the turn is
dropped from the index. The comment above it shows the intent was right ("one
that merely CONTAINS a tag is a person who pasted something") and the
implementation does not reach it.

The replacement is orca's approach: an **allowlist of tag names actually observed
from harnesses** (`system-reminder`, `task-notification`, `local-command-stdout`,
`command-name`, `bash-input`, `agent-message`, …) plus a short list of observed
prefixes (`[request interrupted`, `caveat: the messages below were generated…`,
the compact-continuation opener). An unknown kebab tag stays a user turn. Orca's
own comment states the stake precisely: *"a real prompt starting with a custom
`<my-element>` … is a genuine user turn, and misclassifying it would hide the
turn."* The lowercased copy used for classification is capped at 256 characters,
so a multi-KB paste stays O(1).

**`lifecycle.ts`** derives `working | completed | interrupted` from a record.
Terminal stop reasons are `end_turn | max_tokens | stop_sequence | refusal`. The
backup rule matters more than the main one: a row with **no** `stop_reason`
counts as completed only if it has renderable content *and no `tool_use` block* —
otherwise a pre-tool assistant row settles the turn before the tool has run.

This is a second opinion on agent state, independent of hooks. Shepherd's live
state comes from the socket and `StopPolicy`, and `CLAUDE.md` already warns that
the daemon's sweep "detects *claude exited*, not *the turn ended*" and must not
be reached for as a corrector. A transcript-derived lifecycle is the corrector
that warning asks for. **This design produces it and stops there** — wiring it
into `agents-core` is a separate decision with its own precedence question, and
is explicitly out of scope (§7).

### 3.2 `parse/` — one fold

`absorb(base, chunk) -> ParsedSession` keeps the contract `absorbLines` already
has, and keeps it for the same reason its header gives: *"the way to guarantee
the incremental path agrees with the cold path is to have only one path. There is
no `parseWholeFile` beside this; a cold parse is a fold over an empty digest."*
A trailing partial line is dropped, not parsed, and the caller's offset advances
only past complete lines.

```ts
interface ParsedSession {
  readonly sessionId: string;
  readonly filePath: string;
  readonly cwd: string | null;
  readonly gitBranch: string | null;
  readonly version: string | null;
  readonly messages: readonly TranscriptMessage[];
  readonly unknown: readonly UnknownRecord[];   // §2.1
  readonly lifecycle: Lifecycle | null;         // the latest marker
  readonly usage: UsageRollup;                  // deduped, by model
  readonly firstTs: number | null;
  readonly lastTs: number | null;
}
```

`digest.ts` projects that to the existing `SessionDigest`. Nothing else produces
a digest.

### 3.3 `store.ts` — the index caches digests only

The tier split lives here and it is a hard rule. The manifest comment that
governs it is already written: *"the index is a CACHE … 14.8 MB of transcript
text is exactly what `tasks/store.ts` forbids putting there — no transcripts, no
diffs, no file contents, ever."* A cached full parse would be the other 97% and
would violate it directly.

So: **the full parse is streamed on demand and never written to disk.** The index
keeps the digest, per file, keyed by path with `size` and `mtimeMs`, exactly as
today.

Two changes:

- The walk descends **one named level, not recursively**: for a session file
  `<enc>/<uuid>.jsonl` it also looks in `<enc>/<uuid>/subagents/`. Anything else
  under `<enc>/` is left alone. Subagent files are attributed to their parent
  session rather than listed as sessions of their own, and the predicate is exact
  — `agent-` prefix, `.jsonl` extension — so a count and a listing can never
  disagree.
- A **generation counter**. A refresh that began before an invalidation must not
  write its now-stale result back. Orca hit this: *"a scan that started before an
  invalidation carries the old generation and must not write its result back —
  otherwise a delete's invalidation is silently undone by an in-flight scan that
  resolves just after it."* Recall is already vulnerable: `refresh` awaits between
  files and a keystroke can supersede it mid-walk.

### 3.4 `watch.ts` — the live tail

`fs.watch` on the containing directory, debounced ~150 ms, coalescing bursts. Per
watch the state is `{ offset, pending }` and it runs through **the same fold** as
a cold read — a tailer with its own parser is the drift of §1 in miniature.

`node:fs` is available: `boundaries.js`'s `OS_APIS` denies `os`,
`child_process`, `worker_threads`, `v8`, `vm` — not `fs`. No new permission is
needed; the manifest keeps `storage` alone.

Two guards ported from orca, both cheap and both about failure rather than
success:

- an oversized single record is **dropped** rather than buffered without bound;
- the read stream is destroyed in a `finally`, so an early bail cannot leak a
  file descriptor.

Unsubscribe must be race-safe against an in-flight read — orca carries a
dedicated test for that race, and this design carries one too (§6).

The scheduler runs on the extension host's own thread, which also serves the
rail's tree. `store.ts` already documents why that thread must not be held
(`worker_threads` is denied to extensions) and yields between files; the watcher
inherits the same obligation.

### 3.5 `index.ts` — the seams

Unchanged: registration into `tasks.transcriptSearch`. Its behaviour does not
change; only its innards do.

Added, as commands:

| command | answers |
|---|---|
| `transcripts.read` | one session, fully parsed |
| `transcripts.usage` | the deduped rollup for a session or a directory |
| `transcripts.watch` / `.unwatch` | start/stop a tail |

`transcripts.read` returns the parent session alone by default and its subagent
sessions only when asked (`{ subagents: true }`), because a caller rendering a
conversation and a caller totalling tokens want opposite answers and neither
should pay for the other's. `transcripts.usage` counts subagents **always** —
their tokens were spent on the parent's behalf, and a total that omitted them
would be the §2.2 mistake in a different disguise.

Added, as events on `EventAPI` (`emit`/`on`, topic-based):

| topic | payload |
|---|---|
| `transcripts.appended` | `{ sessionId, messages }` |
| `transcripts.lifecycle` | `{ sessionId, state, turnId, ts }` |

A consumer subscribes; the parser owns the watcher and the offset. This keeps
offset state in exactly one place, which is the property a pull-based API would
give away.

## 4. Errors

Every layer returns `null` rather than throwing, and the reasons are one per
layer:

- a malformed line **skips**; one bad record may not fail a file;
- a missing projects directory is *"a machine where nobody has run the agent
  yet, not an error worth failing a search over"* — recall's existing words;
- a file that **shrank** was rewritten rather than appended to, so the stored
  digest describes bytes that no longer exist: re-parse from zero;
- an unreadable cache is a cold start, which is correct and merely slower.

## 5. What this is not

Named because each is a plausible next step that would change the shape:

- **No UI.** No transcript viewer, no usage panel. This module ends at data and
  events. A view is a separate design against the surfaces ADR 0044 opened.
- **No dollar costs.** Token counts, not money. Pricing needs a table that goes
  stale, and where it lives is its own decision.
- **No wiring into `agents-core`.** §3.1 produces a lifecycle; deciding whether
  it outranks a hook is a precedence question that belongs with ADR 0004's
  ordering guard, not here.
- **No second vendor.** The format knowledge here is Claude Code's. A Codex
  parser is a sibling module, not a generalisation of this one — orca keeps four
  decoders side by side rather than one abstract reader, and it is right to.

## 6. Testing

Pure-model unit tests per file, following the repo's existing pattern. Three
tests carry more weight than the rest:

- **The derivation test.** For each fixture, `digest(parse(f))` equals what
  today's parser produces on the same file. This is what makes the restructure
  provably behaviour-preserving for search, and it is the reason to write it
  before touching `record.ts`.
- **The mid-record append test.** Append bytes that end mid-record; assert the
  offset did not advance past them and the next append parses the whole record
  once. This is the contract between `absorb` and `completeBytes`, and it is the
  one that silently corrupts an index when it breaks.
- **The unsubscribe race test.** Dispose a watch while a read is in flight;
  assert no emit lands afterwards and no descriptor leaks.

A fixture corpus of real, anonymised sessions is checked in, covering: a tool
loop, an interrupt, a compaction/continuation, a session with a populated
`subagents/` directory, a session with duplicate assistant rows (with its known
naive and deduped token totals asserted — §2.2), and **a user turn whose entire
content is a markup snippet**, which is the regression test for §3.1's defect.

## 7. Open question, deliberately left open

Whether the transcript-derived lifecycle should correct `agents-core`'s
hook-derived state, and which wins when they disagree. This design makes the
signal available and takes no position. It is recorded here so the next person
does not read the silence as an oversight.
