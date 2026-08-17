# Session search — the rail filters, the overlay holds results

**Date:** 2026-08-13
**Status:** design agreed, not yet planned
**Touches:** `extensions/tasks`, a new `extensions/recall`, `packages/ui/src/command-palette.*`, `packages/app/src/renderer/view-dock.tsx`

---

## What this is

`recall` is a Python CLI (`~/Home/dev/tools/recall/recall.py`, 922 lines) that reads
past Claude Code chats out of `~/.claude/projects/**/*.jsonl` and throws away every
tool call and tool result, leaving user text, assistant text, AI and custom titles,
agent names, and `/recap` summaries. Its search greps that stripped text and prints
a session header plus `[role] …snippet…` lines.

The rail's search box does something much smaller: `tasks.filter` (`index.ts:3072`)
fuzzy-matches the query against `"<title> <repo names>"` and keeps the matching
task ids in a set (`index.ts:3467`). It filters rows that already exist and can
never surface anything that is not already a row.

This design brings recall's corpus into Shepherd without pretending the rail can
display it.

## The split, and why

**A task row is a title. A transcript hit is four things** — which task, which
session, the line that matched, and when. Those need two lines and roughly 500px.

The rail is **264px** (`metrics.ts:140`, `band.rail: 20.31` → 264px). The search
field's own padding is `space-lg + space-md` = 21px a side, leaving 222px of
content; at `body` (13px sans) that is ~34 characters, and a snippet indented under
a session row has ~31. recall's snippet window is ±60 characters — **up to 120**.
Drawing a hit in the rail means truncating the exact string the user searched for.

So the split is by what a result *is*:

- **The rail field filters the rows already there.** Titles only, in place,
  hierarchy and grouping intact, no results list, no new surface. Unchanged from
  today except that its divider keeps stating the true total (`2 of 28`). This is
  the one search a 264px column can answer honestly.
- **One row admits the limit.** `12 in transcripts`, at the foot of the filtered
  list, with a `⇧⌘F` keycap as its `meta`. It says the matches exist without
  pretending to show them, and it carries the query into the overlay so nothing is
  retyped. The rail never grows.

  **The count is matched lines across every task's sessions, not a count of
  sessions and not a subset of the filtered rows.** It is deliberately unrelated to
  what the rail is currently showing: its whole job is to report what the title
  filter cannot see, so scoping it to the rows already visible would make it
  redundant. The overlay's own header states the split (`12 in 4 sessions`), which
  is where the second number belongs.
- **The overlay holds the results.** `CommandPalette` already gives us the 620px
  `lg` modal pinned at 12vh, the magnifier-and-field query row, group heads that
  appear only when a group has matches, mousemove-not-mouseenter selection, and
  close-on-activate. Session search is a **second scope inside it**, not a third
  surface.

## Scope: Claude Code sessions only

This searches agent transcripts. It does **not** search terminal scrollback, and
that is a boundary rather than a first cut.

A non-agent pane has no transcript. Its lines live in xterm's in-memory
`scrollback: 5000` (`xterm-terminal.ts:58`), and the only serializer in the tree —
`@xterm/addon-serialize` — is used by `core/src/session/mirror.ts` for the live
attach mirror and never written to disk. A `zsh` pane's `cd ~/dev/shepherd && git
pull` is gone when the pane closes and was never in a file. Searching it is a
separate feature with a real persistence bill.

## Archived tasks are searchable, and are most of the value

The open question at design time was whether a shipped task's history survives.
It does, because **transcripts are not a terminal's property**. Claude Code writes
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` and never deletes it. It
lives outside `~/.shepherd` entirely, so nothing in the archive path — closing
panes, removing worktrees, pinning snapshot commits — can reach it.

Measured: **33 task project-dirs have a deleted worktree and an intact
transcript**, including `update-shepherd-with-shepherd-design`,
`genuine-question-with-shepherd` and `fix-git-pulling-in-cli`. One
(`need-to-fix-the-naming-prompt-shepherd-v2`) holds 15. If archived tasks were
excluded this feature would lose most of its corpus.

## Where the code lives

**A new `extensions/recall`, registering into a point `tasks` defines.** Not inside
`tasks`, and not in core.

`tasks` must not learn what a Claude transcript is. `store.ts` states the rule for
`resumeTarget` — "opaque here (D11) … the moment this extension reads it, it has
learned about a vendor" — and a JSONL parser tracking a vendor's evolving record
types is that failure in its most durable form.

The rule is not absolute, and the spec should say so rather than overstate it:
`tasks/src/trust.ts` already writes `~/.claude.json` to pre-trust directories it
generated. That is a narrow, one-shot write of a fact `tasks` itself owns. An index
that parses a vendor's file format on every keystroke is a different animal, and it
is also the piece most likely to be wanted elsewhere (⌘K, a future
"search everything" surface, a second agent vendor).

```
tasks  ──defines──▶  tasks.transcriptSearch      (a question, not steps)
                            ▲
recall ──registers──────────┘                    (owns ~/.claude, the parser, the index)
```

This is exactly the `agents-core` defines / `claude-code` registers shape already in
`builtins.ts`, and it follows `REPO_SUGGESTIONS_POINT`'s stated rule — **publish
questions, not steps.** A future agent vendor registers its own provider and the
rail keeps working.

Points share one `PointRegistry` in a single address space (`ext-host/api.ts`), so a
provider call is a direct function call — no serialization, and an `AbortSignal`
crosses fine.

```ts
interface TranscriptSearchProvider {
  search(q: TranscriptQuery): Promise<readonly TranscriptHit[]>;
}

interface TranscriptQuery {
  readonly query: string;
  readonly dirs: readonly string[];      // task root + worktrees
  readonly maxPerSession?: number;       // default 3, recall's own
  readonly signal?: AbortSignal;         // the keystroke that superseded this one
}

interface TranscriptHit {
  readonly dir: string;                  // maps the hit back to a task
  readonly sessionId: string;
  readonly title?: string;
  readonly when: number;
  readonly total: number;                // for `4 more`
  readonly matches: readonly {
    readonly source: 'user' | 'assistant' | 'title' | 'recap' | 'agent';
    readonly text: string;
    readonly at: readonly [number, number];   // the run to highlight
  }[];
}
```

**A hit carries no Shepherd role, deliberately.** `orchestrator` / `workstream` is
`tasks`'s own fact, held in `task.sessions[].role`; a transcript reader that
returned it would have to know what a task is. `tasks` joins the hit's `sessionId`
against its own record to label the row, and a session it does not track — one
started by hand in the worktree, which the dir-scoping deliberately includes —
falls back to the short id alone.

`recall` declares `dependencies: [TASKS_ID]` so the point exists before it
registers. `tasks` must treat a missing provider as "no transcript hits" and keep
filtering titles — the rail's own search may never depend on another extension
being alive.

### Path resolution

`recall` composes `${ctx.homeDir}/.claude/projects` itself. `ctx.homeDir` exists for
precisely this, and its own doc says why the kernel hands over raw home rather than
a menu: *"naming another program's file in this interface would make the kernel the
authority on that program's layout, and it is the extension that knows the vendor."*
`boundaries.js` denies `os`/`node:os` to `extensions/**`; `fs` and `path` are
allowed.

**Match on the recorded `cwd`, not on the encoded folder name.** Every transcript
record carries `cwd`. The folder name is an undocumented lossy transform, and
recall.py gets it wrong today: `encode_project_name` (recall.py:339) replaces only
`/`, but Claude Code replaces `.` as well — `/Users/me/.shepherd/…` becomes
`-Users-me--shepherd-…` with a double dash, not `-Users-me-.shepherd-…`. The
consequence is live and silent: `recall list` inside any Shepherd task prints
"no sessions found" and exits 0, while `--project all` finds the session. Use the
folder name as a cheap prefilter at most; `cwd` is ground truth. (The Python CLI
should get the one-line fix independently.)

## The index

recall re-reads every file on every invocation. That is right for a CLI and wrong
for a box that must answer on each keystroke — `12 in transcripts` has to be true
while typing, so moving results into the overlay does **not** remove this work.

Four properties, and the first is why the rest are affordable.

**1. Strip once.** Measured on the real corpus: **779 files, 481 MB of JSONL, which
strips to 14.8 MB of conversation text — 3.1%.** Tool calls and tool output are 97%
of those bytes and recall discards all of them. A full cold parse took 2.8s in
Python. Stripped text for the whole machine fits in memory, and a substring scan
over 15 MB is single-digit milliseconds.

**2. Re-read only what grew.** Session JSONL is append-only. Cache `{mtime, size,
offset}` per file and parse from `offset`; a file that gained 3 KB costs 3 KB. This
is what keeps the box responsive while an agent is actively writing to the
transcript being searched.

**3. Index only directories a task owns.** 172 project dirs exist; the rail cares
only about those matching a task root or worktree. The rest are never opened.

**4. Cheap query first.** Title fuzzy-matching is already instant and stays
synchronous, so the filtered rows render immediately. The transcript pass is
debounced and updates the `n in transcripts` row when it lands. **Typing never
waits on disk.**

Persist the stripped cache under `ctx.dataDir` so a restart is not a cold parse.

**The known risk:** `boundaries.js` denies `worker_threads` to extensions, so this
parses on the extension host's own thread. A cold first index can block the rail.
Mitigation is designed in, not bolted on: chunk the walk, `await` between files,
publish partial counts as they accumulate, and honour the `AbortSignal` when a
keystroke supersedes a query.

## The overlay

`CommandPalette` gains a transcripts scope. Two changes it does not currently
support:

- **The leading slot is hidden and must not be.** `command-palette.css:117` sets
  `.sh-ui-palette__list .sh-ui-row__leading { display: none }` on the grounds that
  "in a palette no row will ever have a status" — while `command-palette.tsx:87`
  documents a `mark` prop that draws a `StateMark` into exactly that slot for §1's
  `Jump to` rows. **The comment is the stale half**; the CSS is currently hiding
  marks the component already passes. Scope the hide to command rows.
- **The cap must become a pixel height.** `command-palette.css:63` sets
  `max-height: calc(10 * var(--sh-row-height))` — ten 34px rows, ten because that is
  where a person stops reading and types instead. A two-line hit is ~50px, so
  counting rows stops meaning anything once two heights exist.

A hit row is two lines: task title + session label on the first, the matched line on
the second with the hit run highlighted, and time plus `4 more` right-aligned.
`match-display.ts` already turns "text plus which characters matched" into
alternating segments (`segmentsOf`) for the repo picker — reuse it rather than
writing a second highlighter, per its own warning that a second matcher is a second
chance to disagree with the ranker.

**The session label is `role · short-id`,** e.g. `orchestrator · a3f81c`. Not a pane
id: panes do not survive a restart and do not exist at all for an archived task,
which is most of the corpus.

## Matching

Two matchers, each where it earns its place:

- **Titles and repo names: fuzzy**, unchanged, so `shpd` still finds shepherd.
- **Transcript text: case-insensitive literal.** Substring, not fuzzy — fuzzy over
  prose produces noise, and recall's own contract is a literal/regex grep.

A task matches if either side hits.

## Keys

- **`⌘F` stays pane-local.** `find-bar.tsx` argues at length that a find spanning
  panes answers with a count across screens you cannot see. It must not be taken.
- **`⌘K` stays commands.**
- **`⇧⌘F` opens session search**, which every editor already agrees on.
- **Focusing the rail field must never open the overlay.** If clicking into it
  teleports you, the rail has no filter — and filtering is the thing done most.
  Only `⇧⌘F` and clicking the `n in transcripts` row open it.

## Testing

- `recall`'s parser against fixture JSONL: tool-result records, hook stubs,
  `<local-command-stdout>`, `ai-title` / `custom-title` / `agent-name`,
  `away_summary`, malformed lines. Ported from recall.py's record filters.
- Incremental parse: a file that grew re-reads only the tail; one rewritten from the
  start is re-parsed whole.
- `cwd` mapping, including a path containing `.` — the case recall.py gets wrong.
- `tasks` with the point undefined still filters titles.
- Palette: a two-line hit row, the pixel cap, and the leading slot drawn.
- The rail never changes height when a query matches transcripts.

## Deferred

- Terminal scrollback (needs durable persistence first).
- Regex mode in the box.
- Global search across sessions with no task.
- Jumping to the exact turn inside a resumed session — the overlay opens the
  session; opening it *at the line* is a follow-up.
