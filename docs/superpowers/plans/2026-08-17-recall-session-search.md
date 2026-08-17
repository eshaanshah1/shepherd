# Session Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The rail's search field filters task titles in place, and one foot row (`12 in transcripts`) opens a ⇧⌘F overlay holding recall-shaped hits from every Claude Code session a task owns.

**Architecture:** A new headless `extensions/recall` owns `~/.claude/projects` — the JSONL parser, the stripped-text index, the matcher. It registers into `tasks.transcriptSearch`, a point `tasks` defines, so `tasks` never learns what a Claude transcript is. The index parses each session once (481 MB of JSONL → 14.8 MB of text) and re-reads only bytes past a stored offset, because session files are append-only. The overlay is a contributed `surface: 'overlay'` view owned by `tasks`, built on `CommandPalette`.

**Tech Stack:** TypeScript, Node (`node:fs` only — `os`/`worker_threads` are denied to extensions), React 19 for the two `ui/` halves, vitest.

**Spec:** [`docs/superpowers/specs/2026-08-13-recall-session-search-design.md`](../specs/2026-08-13-recall-session-search-design.md)

## Global Constraints

- **Every command runs from `v2/` and takes `env -u NODE_OPTIONS`.** An ambient `NODE_OPTIONS` makes Electron exit 9 before our code runs.
- **`extensions/**` may import `@shepherd/sdk` and nothing else** (plus `import type` of another extension). `fs`/`path`/`url` are allowed; `os`, `node:os`, `child_process`, `node:process`, `worker_threads`, `node:v8`, `node:vm` are denied. An extension cannot compute `$HOME` — use `ctx.homeDir`.
- **An extension's `ui/` half may additionally import `react` and `@shepherd/ui`.** The `src/` half must never import react.
- **One extension may TYPE-import another and never VALUE-import it.** Cross-extension ids are local string constants pinned by `manifest.test.ts`.
- **No hex literals outside `packages/design-tokens`.** Every colour and length is a token.
- **Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.**
- **Snippet radius is 60 characters each side** — recall's own window (`recall.py:527`).
- **Default matches per session is 3** — recall's `--matches-per-session` default.
- **Transcript matching is case-insensitive literal substring.** Not fuzzy, not regex. Title/repo matching stays `fuzzyFilter`.
- **Claude Code sessions only.** No terminal scrollback anywhere in this feature.
- **Copy rules:** sentence case, no emoji, 1–3 word labels. The foot row reads `12 in transcripts`; the overlay group heads read `Transcripts` and `Tasks`.

---

## File Structure

**New package — `extensions/recall/`** (headless: no `ui/` half at all)

| file | responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | package wiring, copied from `extensions/worktree-hook` |
| `src/manifest.ts` | id, manifest, the local copy of the point id |
| `src/index.ts` | `activate` — builds the index, registers the provider |
| `src/model/record.ts` | pure: one JSONL record → user text / assistant text / recap / timestamp |
| `src/model/session.ts` | pure: fold lines into a `SessionDigest`; incremental by construction |
| `src/model/search.ts` | pure: digest + query → matches with snippet windows |
| `src/model/project-dir.ts` | pure: cwd ⇄ project folder name, and the prefix rule |
| `src/store.ts` | the only file that touches `fs`: walk, mtime/size/offset cache, persist |

**Modified**

| file | change |
|---|---|
| `packages/sdk/src/segments.ts` (new) | `DisplaySegment` / `segmentsOf` / `segmentsOfRange`, moved out of `tasks` |
| `packages/sdk/src/index.ts` | export the above |
| `extensions/tasks/src/model/match-display.ts` | re-export from the sdk instead of defining |
| `extensions/tasks/src/manifest.ts` | the point id, its types, the new command + view names |
| `extensions/tasks/src/index.ts` | define the point, query it, emit the foot row, register the overlay view |
| `extensions/tasks/ui/transcript-count.tsx` (new) | the foot row component — raises the overlay |
| `extensions/tasks/ui/session-search.tsx` (new) | the overlay: `CommandPalette` with transcript hits |
| `packages/ui/src/command-palette.tsx` | `detail` / `meta` / `note` on an item; externally-supplied results |
| `packages/ui/src/command-palette.css` | pixel cap; scope the leading-slot hide to command rows |
| `packages/app/src/ext-host/builtins.ts` | register `recall`'s module |
| `packages/app/src/main/index.ts` | register `recall`'s manifest (both lists) |

---

## Task 1: Move the segment helper into the sdk

`segmentsOf` currently lives in `extensions/tasks/src/model/match-display.ts`. The palette needs it too, and `packages/ui` may not import an extension. This is the move `fuzzy.ts` already made, for the same stated reason — one matcher, one highlighter.

**Files:**
- Create: `packages/sdk/src/segments.ts`
- Create: `packages/sdk/src/segments.test.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `extensions/tasks/src/model/match-display.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DisplaySegment { text: string; matched: boolean }`, `segmentsOf(text: string, positions: readonly number[]): readonly DisplaySegment[]`, `segmentsOfRange(text: string, at: readonly [number, number]): readonly DisplaySegment[]`.

- [ ] **Step 1: Write the failing test**

`packages/sdk/src/segments.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { segmentsOf, segmentsOfRange } from './segments.ts';

describe('segmentsOf', () => {
  it('merges adjacent hits into one run', () => {
    expect(segmentsOf('shepherd', [0, 1, 2, 3])).toEqual([
      { text: 'shep', matched: true },
      { text: 'herd', matched: false },
    ]);
  });

  it('returns one unmatched run when nothing hit', () => {
    expect(segmentsOf('shepherd', [])).toEqual([{ text: 'shepherd', matched: false }]);
  });

  it('drops out-of-range and duplicate positions', () => {
    expect(segmentsOf('ab', [0, 0, 99, -1])).toEqual([
      { text: 'a', matched: true },
      { text: 'b', matched: false },
    ]);
  });

  it('returns no segments for empty text', () => {
    expect(segmentsOf('', [])).toEqual([]);
  });
});

describe('segmentsOfRange', () => {
  it('cuts a contiguous run into three parts', () => {
    expect(segmentsOfRange('set band.rail to 264', [4, 8])).toEqual([
      { text: 'set ', matched: false },
      { text: 'band', matched: true },
      { text: '.rail to 264', matched: false },
    ]);
  });

  it('omits an empty leading part when the match starts at 0', () => {
    expect(segmentsOfRange('shepherd narrower', [0, 8])).toEqual([
      { text: 'shepherd', matched: true },
      { text: ' narrower', matched: false },
    ]);
  });

  it('clamps a range that runs past the end', () => {
    expect(segmentsOfRange('abc', [1, 99])).toEqual([
      { text: 'a', matched: false },
      { text: 'bc', matched: true },
    ]);
  });

  it('returns one unmatched run for an inverted range', () => {
    expect(segmentsOfRange('abc', [2, 1])).toEqual([{ text: 'abc', matched: false }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/sdk test -- segments`
Expected: FAIL — `Cannot find module './segments.ts'`

- [ ] **Step 3: Write the implementation**

`packages/sdk/src/segments.ts`:

```ts
/**
 * Text cut into alternating unmatched/matched runs — what a highlighter draws.
 *
 * It lives in the sdk for `fuzzy.ts`'s reason, and this is the same move: it was
 * `extensions/tasks/src/model/match-display.ts`, written for the repo picker's
 * field, and the ⌘K palette's transcript rows now need the identical treatment
 * from `packages/ui` — which may not import an extension. A second implementation
 * would be a second opinion about which characters were the match.
 */

export interface DisplaySegment {
  readonly text: string;
  /** Whether the query hit these characters — the run to paint. */
  readonly matched: boolean;
}

/**
 * Cut `text` into runs, merging adjacent hits so `shep` is one span and not four.
 *
 * Out-of-range and duplicate positions are dropped rather than trusted: they
 * arrive from a suggestion provider this code has never seen, and an index past
 * the end would otherwise slice an empty span into the middle of the text.
 */
export function segmentsOf(text: string, positions: readonly number[]): readonly DisplaySegment[] {
  const hit = new Set(positions.filter((at) => Number.isInteger(at) && at >= 0 && at < text.length));
  if (hit.size === 0) return text === '' ? [] : [{ text, matched: false }];

  const segments: DisplaySegment[] = [];
  let start = 0;
  for (let at = 1; at <= text.length; at++) {
    if (at < text.length && hit.has(at) === hit.has(start)) continue;
    segments.push({ text: text.slice(start, at), matched: hit.has(start) });
    start = at;
  }
  return segments;
}

/**
 * One CONTIGUOUS run, as a substring match produces — `[start, end)`.
 *
 * Separate from `segmentsOf` rather than expressed through it: a transcript hit
 * knows its own bounds, and expanding them into a list of every index in between
 * only to have the merge loop collapse them again is work that can disagree with
 * itself at the edges.
 *
 * A range that is inverted or entirely past the end yields one unmatched run —
 * the same answer as "no match", because a highlight nobody can place is not one
 * to invent.
 */
export function segmentsOfRange(text: string, at: readonly [number, number]): readonly DisplaySegment[] {
  if (text === '') return [];
  const start = Math.max(0, Math.min(at[0], text.length));
  const end = Math.max(start, Math.min(at[1], text.length));
  if (start >= end) return [{ text, matched: false }];

  const segments: DisplaySegment[] = [];
  if (start > 0) segments.push({ text: text.slice(0, start), matched: false });
  segments.push({ text: text.slice(start, end), matched: true });
  if (end < text.length) segments.push({ text: text.slice(end), matched: false });
  return segments;
}
```

- [ ] **Step 4: Export from the barrel**

Add to `packages/sdk/src/index.ts`, beside the `fuzzy` exports:

```ts
export type { DisplaySegment } from './segments.ts';
export { segmentsOf, segmentsOfRange } from './segments.ts';
```

- [ ] **Step 5: Point `tasks` at the sdk copy**

In `extensions/tasks/src/model/match-display.ts`, delete the local `DisplaySegment` interface and the `segmentsOf` function body, and replace them with a re-export so every existing importer keeps working:

```ts
import { collapseHome } from './repo-path.ts';
import { segmentsOf, type DisplaySegment } from '@shepherd/sdk';

export type { DisplaySegment };
export { segmentsOf };
```

Keep `MatchDisplay` and `displayMatch` exactly as they are — they are about a repo PATH (home collapsing) and belong here.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/sdk test -- segments`
Expected: PASS, 8 tests

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- match-display`
Expected: PASS — the existing `match-display.test.ts` still green against the moved helper

- [ ] **Step 7: Typecheck and commit**

```bash
cd v2 && env -u NODE_OPTIONS pnpm typecheck
git add packages/sdk/src/segments.ts packages/sdk/src/segments.test.ts packages/sdk/src/index.ts extensions/tasks/src/model/match-display.ts
git commit -m "refactor(sdk): move segmentsOf into the sdk and add segmentsOfRange

The palette needs the same highlighter the repo picker uses, and
packages/ui may not import an extension. Same move fuzzy.ts made.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: The `recall` package, and its record filters

Scaffold the package and port recall.py's record classification (`is_real_user_text`, `assistant_text`, `away_summary_text`, `parse_iso_ts`). These four decide what a transcript *is*, and every later task rests on them.

**Files:**
- Create: `extensions/recall/package.json`, `extensions/recall/tsconfig.json`, `extensions/recall/vitest.config.ts`
- Create: `extensions/recall/src/model/record.ts`
- Create: `extensions/recall/src/model/record.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `userText(rec: unknown): string | null`, `assistantText(rec: unknown): string | null`, `awaySummaryText(rec: unknown): string | null`, `parseIsoTs(value: unknown): number | null` (epoch ms), `recordType(rec: unknown): string | null`.

- [ ] **Step 1: Create the package files**

`extensions/recall/package.json`:

```json
{
  "name": "@shepherd/ext-recall",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "shepherd.recall — reads past Claude Code sessions and answers tasks' transcript searches.",
  "//exports": "No `./ui`: this extension draws nothing. The overlay is tasks' surface; this half is the reader.",
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" },
    "./manifest": { "types": "./src/manifest.ts", "default": "./src/manifest.ts" },
    "./model": { "types": "./src/model/index.ts", "default": "./src/model/index.ts" }
  },
  "//dependencies": "@shepherd/ext-tasks is TYPE-ONLY — `import type` and nothing else. The runtime relationship is the point id plus the manifest's `dependencies` entry.",
  "shepherd": {
    "id": "shepherd.recall",
    "name": "Recall",
    "version": "0.1.0",
    "api": "^1.0.0",
    "activation": ["onStartup"],
    "permissions": ["storage"],
    "dependencies": ["shepherd.tasks"],
    "contributes": {}
  },
  "scripts": {
    "typecheck": "tsc -b",
    "test": "vitest run"
  },
  "dependencies": {
    "@shepherd/ext-tasks": "workspace:*",
    "@shepherd/sdk": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

`extensions/recall/tsconfig.json` — copy `extensions/worktree-hook/tsconfig.json` verbatim, then delete any `ui`-related entry from `include`/`references` if present (this package has no `ui/`).

`extensions/recall/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/ext-recall',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 2: Write the failing test**

`extensions/recall/src/model/record.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assistantText, awaySummaryText, parseIsoTs, recordType, userText } from './record.ts';

describe('userText', () => {
  it('returns a typed user message', () => {
    expect(userText({ type: 'user', message: { role: 'user', content: 'fix the width' } })).toBe('fix the width');
  });

  it('rejects a tool_result record, whose content is a list', () => {
    const rec = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } };
    expect(userText(rec)).toBeNull();
  });

  it('rejects a record that is only a system reminder', () => {
    const rec = { type: 'user', message: { role: 'user', content: '<system-reminder>be good</system-reminder>' } };
    expect(userText(rec)).toBeNull();
  });

  it('keeps real text that merely CONTAINS a reminder', () => {
    const rec = { type: 'user', message: { role: 'user', content: 'do it <system-reminder>x</system-reminder>' } };
    expect(userText(rec)).toBe('do it <system-reminder>x</system-reminder>');
  });

  it('rejects local command stdout', () => {
    const rec = { type: 'user', message: { role: 'user', content: '<local-command-stdout>hi</local-command-stdout>' } };
    expect(userText(rec)).toBeNull();
  });

  it('rejects whitespace-only text', () => {
    expect(userText({ type: 'user', message: { role: 'user', content: '   ' } })).toBeNull();
  });

  it('rejects a non-user record', () => {
    expect(userText({ type: 'assistant', message: { role: 'assistant', content: [] } })).toBeNull();
  });
});

describe('assistantText', () => {
  it('joins every text block with a blank line', () => {
    const rec = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'first' },
          { type: 'tool_use', name: 'Bash', input: {} },
          { type: 'text', text: 'second' },
        ],
      },
    };
    expect(assistantText(rec)).toBe('first\n\nsecond');
  });

  it('returns null when there is no text block', () => {
    const rec = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } };
    expect(assistantText(rec)).toBeNull();
  });

  it('ignores thinking blocks', () => {
    const rec = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } };
    expect(assistantText(rec)).toBeNull();
  });
});

describe('awaySummaryText', () => {
  it('strips the recap trailer', () => {
    const rec = { type: 'system', subtype: 'away_summary', content: 'shipped it (disable recaps in /config)' };
    expect(awaySummaryText(rec)).toBe('shipped it');
  });

  it('ignores a system record of another subtype', () => {
    expect(awaySummaryText({ type: 'system', subtype: 'other', content: 'x' })).toBeNull();
  });
});

describe('parseIsoTs', () => {
  it('parses a Z-suffixed stamp to epoch ms', () => {
    expect(parseIsoTs('2026-08-13T14:02:03.000Z')).toBe(Date.parse('2026-08-13T14:02:03.000Z'));
  });

  it('returns null for junk and for absent', () => {
    expect(parseIsoTs('not a date')).toBeNull();
    expect(parseIsoTs(undefined)).toBeNull();
  });
});

describe('recordType', () => {
  it('reads the type of an object and nothing else', () => {
    expect(recordType({ type: 'ai-title' })).toBe('ai-title');
    expect(recordType(null)).toBeNull();
    expect(recordType('nope')).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-recall test`
Expected: FAIL — `Cannot find module './record.ts'`

- [ ] **Step 4: Write the implementation**

`extensions/recall/src/model/record.ts`:

```ts
/**
 * One JSONL record → the text a person actually said or read.
 *
 * Ported from `recall.py`'s record filters, and the filtering IS the feature:
 * measured on a real corpus, 481 MB of session files hold 14.8 MB of
 * conversation — tool calls and tool output are the other 97%. Everything
 * downstream of this file operates on the 3%.
 *
 * Every function takes `unknown`. A record is a line of somebody else's file
 * format, so a cast here would be a promise this code cannot keep.
 */

const RECAP_TAIL = /\s*\(disable recaps in \/config\)\s*$/;

/** A well-formed record's `type`, or null for anything that is not an object. */
export function recordType(rec: unknown): string | null {
  if (typeof rec !== 'object' || rec === null) return null;
  const type = (rec as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

function messageOf(rec: unknown): Record<string, unknown> | null {
  if (typeof rec !== 'object' || rec === null) return null;
  const message = (rec as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  return message as Record<string, unknown>;
}

/**
 * The user's typed text, or null if this is not a real user turn.
 *
 * Three things wear the `user` type and are not: a tool_result record (whose
 * `content` is a LIST of blocks rather than a string — which is the whole test),
 * a hook or system-reminder stub, and the echo of a slash command's output.
 */
export function userText(rec: unknown): string | null {
  if (recordType(rec) !== 'user') return null;
  const message = messageOf(rec);
  if (message === null || message.role !== 'user') return null;
  const content = message.content;
  if (typeof content !== 'string') return null;

  const text = content.trim();
  if (text === '') return null;

  // A record whose every character sits inside a tag pair is machinery. One that
  // merely CONTAINS a tag is a person who pasted something, and is kept whole.
  const withoutTags = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();
  if (withoutTags === '') return null;

  if (text.startsWith('<local-command-stdout>') && text.includes('</local-command-stdout>')) return null;
  return text;
}

/** Every `text` block of an assistant turn, joined. Thinking is not text. */
export function assistantText(rec: unknown): string | null {
  if (recordType(rec) !== 'assistant') return null;
  const message = messageOf(rec);
  if (message === null || !Array.isArray(message.content)) return null;

  const parts: string[] = [];
  for (const block of message.content) {
    if (typeof block !== 'object' || block === null) continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== 'text' || typeof typed.text !== 'string') continue;
    const text = typed.text.trim();
    if (text !== '') parts.push(text);
  }
  return parts.length === 0 ? null : parts.join('\n\n');
}

/** A `/recap` away-summary, with the UI trailer removed. */
export function awaySummaryText(rec: unknown): string | null {
  if (recordType(rec) !== 'system') return null;
  const typed = rec as { subtype?: unknown; content?: unknown };
  if (typed.subtype !== 'away_summary' || typeof typed.content !== 'string') return null;
  const text = typed.content.replace(RECAP_TAIL, '').trim();
  return text === '' ? null : text;
}

/** An ISO stamp → epoch ms. Null rather than NaN, so a caller cannot compare junk. */
export function parseIsoTs(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-recall test`
Expected: PASS, 15 tests

- [ ] **Step 6: Commit**

```bash
git add extensions/recall
git commit -m "feat(recall): the package, and the record filters ported from recall.py

Tool calls and tool output are 97% of a session file's bytes. These four
functions are what discards them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Fold lines into a session digest

A digest is everything the search and the row need from one session. `absorbLines` takes a digest and a chunk of new text and returns the digest that includes it — which is what makes the append-only optimisation possible later, with no separate incremental code path to drift.

**Files:**
- Create: `extensions/recall/src/model/session.ts`
- Create: `extensions/recall/src/model/session.test.ts`

**Interfaces:**
- Consumes: `userText`, `assistantText`, `awaySummaryText`, `parseIsoTs`, `recordType` from Task 2.
- Produces:
  - `Turn { source: 'user' | 'assistant' | 'recap'; ts: number | null; text: string }`
  - `SessionDigest { sessionId; cwd: string | null; gitBranch: string | null; aiTitle: string | null; customTitle: string | null; agentName: string | null; recap: string | null; firstTs: number | null; lastTs: number | null; userTurns: number; assistantTurns: number; turns: readonly Turn[] }`
  - `emptyDigest(sessionId: string): SessionDigest`
  - `absorbLines(base: SessionDigest, chunk: string): SessionDigest`
  - `bestTitle(digest: SessionDigest): string | null`
  - `isEmptyDigest(digest: SessionDigest): boolean`

- [ ] **Step 1: Write the failing test**

`extensions/recall/src/model/session.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { absorbLines, bestTitle, emptyDigest, isEmptyDigest } from './session.ts';

const line = (rec: unknown): string => `${JSON.stringify(rec)}\n`;

const user = (text: string, ts = '2026-08-13T10:00:00.000Z'): string =>
  line({ type: 'user', timestamp: ts, cwd: '/w/task', gitBranch: 'main', message: { role: 'user', content: text } });

const assistant = (text: string, ts = '2026-08-13T10:01:00.000Z'): string =>
  line({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }] } });

describe('absorbLines', () => {
  it('counts turns and collects their text in order', () => {
    const d = absorbLines(emptyDigest('abc'), user('hello') + assistant('hi back'));
    expect(d.userTurns).toBe(1);
    expect(d.assistantTurns).toBe(1);
    expect(d.turns.map((t) => [t.source, t.text])).toEqual([
      ['user', 'hello'],
      ['assistant', 'hi back'],
    ]);
  });

  it('is incremental — folding two chunks equals folding one', () => {
    const whole = absorbLines(emptyDigest('abc'), user('one') + assistant('two'));
    const split = absorbLines(absorbLines(emptyDigest('abc'), user('one')), assistant('two'));
    expect(split).toEqual(whole);
  });

  it('takes cwd and branch from the first record that carries them', () => {
    const d = absorbLines(emptyDigest('abc'), user('hello'));
    expect(d.cwd).toBe('/w/task');
    expect(d.gitBranch).toBe('main');
  });

  it('tracks the first and last timestamp across chunks', () => {
    const d = absorbLines(
      emptyDigest('abc'),
      user('early', '2026-08-13T09:00:00.000Z') + assistant('late', '2026-08-13T11:00:00.000Z'),
    );
    expect(d.firstTs).toBe(Date.parse('2026-08-13T09:00:00.000Z'));
    expect(d.lastTs).toBe(Date.parse('2026-08-13T11:00:00.000Z'));
  });

  it('keeps the newest recap when a session has several', () => {
    const chunk =
      line({ type: 'system', subtype: 'away_summary', timestamp: '2026-08-13T10:00:00.000Z', content: 'older' }) +
      line({ type: 'system', subtype: 'away_summary', timestamp: '2026-08-13T12:00:00.000Z', content: 'newer' });
    expect(absorbLines(emptyDigest('abc'), chunk).recap).toBe('newer');
  });

  it('records a recap as a searchable turn as well', () => {
    const chunk = line({ type: 'system', subtype: 'away_summary', content: 'shipped it' });
    expect(absorbLines(emptyDigest('abc'), chunk).turns).toEqual([
      { source: 'recap', ts: null, text: 'shipped it' },
    ]);
  });

  it('reads the title records', () => {
    const chunk = line({ type: 'ai-title', aiTitle: 'A' }) + line({ type: 'agent-name', agentName: 'orch' });
    const d = absorbLines(emptyDigest('abc'), chunk);
    expect(d.aiTitle).toBe('A');
    expect(d.agentName).toBe('orch');
  });

  it('skips malformed lines instead of throwing', () => {
    const d = absorbLines(emptyDigest('abc'), 'not json\n' + user('real') + '{"broken":\n');
    expect(d.userTurns).toBe(1);
  });

  it('ignores a trailing partial line so a growing file is not half-parsed', () => {
    // A file being appended to can end mid-record. The chunk carries no newline
    // after it, which is the only signal that it is incomplete.
    const d = absorbLines(emptyDigest('abc'), user('complete') + '{"type":"user","mess');
    expect(d.userTurns).toBe(1);
  });
});

describe('bestTitle', () => {
  it('prefers a custom title over the AI one', () => {
    const d = { ...emptyDigest('abc'), aiTitle: 'ai', customTitle: 'mine' };
    expect(bestTitle(d)).toBe('mine');
  });

  it('falls back to the AI title, then to null', () => {
    expect(bestTitle({ ...emptyDigest('abc'), aiTitle: 'ai' })).toBe('ai');
    expect(bestTitle(emptyDigest('abc'))).toBeNull();
  });
});

describe('isEmptyDigest', () => {
  it('is true for a session with no turns, titles or recap', () => {
    expect(isEmptyDigest(emptyDigest('abc'))).toBe(true);
    expect(isEmptyDigest(absorbLines(emptyDigest('abc'), user('x')))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-recall test -- session`
Expected: FAIL — `Cannot find module './session.ts'`

- [ ] **Step 3: Write the implementation**

`extensions/recall/src/model/session.ts`:

```ts
import { assistantText, awaySummaryText, parseIsoTs, recordType, userText } from './record.ts';

/**
 * One session, reduced to what a search and a result row need.
 *
 * **`absorbLines` is a fold, and that is the whole design.** Session files are
 * append-only, so re-reading one that gained 3 KB should cost 3 KB — and the way
 * to guarantee the incremental path agrees with the cold path is to have only
 * one path. There is no `parseWholeFile` beside this; a cold parse is a fold over
 * an empty digest.
 */

export interface Turn {
  readonly source: 'user' | 'assistant' | 'recap';
  readonly ts: number | null;
  readonly text: string;
}

export interface SessionDigest {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly gitBranch: string | null;
  readonly aiTitle: string | null;
  readonly customTitle: string | null;
  readonly agentName: string | null;
  readonly recap: string | null;
  /** When the newest recap was written — so a later chunk cannot lose to an older one. */
  readonly recapTs: number | null;
  readonly firstTs: number | null;
  readonly lastTs: number | null;
  readonly userTurns: number;
  readonly assistantTurns: number;
  readonly turns: readonly Turn[];
}

export function emptyDigest(sessionId: string): SessionDigest {
  return {
    sessionId,
    cwd: null,
    gitBranch: null,
    aiTitle: null,
    customTitle: null,
    agentName: null,
    recap: null,
    recapTs: null,
    firstTs: null,
    lastTs: null,
    userTurns: 0,
    assistantTurns: 0,
    turns: [],
  };
}

export function bestTitle(digest: SessionDigest): string | null {
  return digest.customTitle ?? digest.aiTitle ?? null;
}

/** Nothing was said and nothing was named — recall.py drops such a file entirely. */
export function isEmptyDigest(digest: SessionDigest): boolean {
  return (
    digest.turns.length === 0 &&
    digest.aiTitle === null &&
    digest.customTitle === null &&
    digest.recap === null
  );
}

/**
 * Fold a chunk of JSONL text into a digest.
 *
 * **A trailing partial line is dropped, not parsed.** The caller may hand us
 * bytes from a file an agent is writing to right now, so the last line can be
 * half a record; only a terminating newline says a line is complete. The dropped
 * bytes are re-read next time because the caller's offset advances only past what
 * was consumed (see `store.ts`).
 */
export function absorbLines(base: SessionDigest, chunk: string): SessionDigest {
  let { cwd, gitBranch, aiTitle, customTitle, agentName, recap, recapTs, firstTs, lastTs, userTurns, assistantTurns } =
    base;
  const turns: Turn[] = [...base.turns];

  const lines = chunk.split('\n');
  // The tail after the final newline is incomplete by definition. A chunk that
  // ends ON a newline leaves an empty final element, which this also drops.
  lines.pop();

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;

    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    const type = recordType(rec);
    if (type === 'ai-title') {
      const value = (rec as { aiTitle?: unknown }).aiTitle;
      if (typeof value === 'string' && value !== '') aiTitle = value;
      continue;
    }
    if (type === 'custom-title') {
      const value = (rec as { customTitle?: unknown }).customTitle;
      if (typeof value === 'string' && value !== '') customTitle = value;
      continue;
    }
    if (type === 'agent-name') {
      const value = (rec as { agentName?: unknown }).agentName;
      if (typeof value === 'string' && value !== '') agentName = value;
      continue;
    }

    const ts = parseIsoTs((rec as { timestamp?: unknown }).timestamp);
    if (ts !== null) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }

    const summary = awaySummaryText(rec);
    if (summary !== null) {
      if (recapTs === null || (ts !== null && ts >= recapTs)) {
        recap = summary;
        recapTs = ts;
      }
      turns.push({ source: 'recap', ts, text: summary });
      continue;
    }

    if (cwd === null) {
      const value = (rec as { cwd?: unknown }).cwd;
      if (typeof value === 'string' && value !== '') cwd = value;
    }
    if (gitBranch === null) {
      const value = (rec as { gitBranch?: unknown }).gitBranch;
      if (typeof value === 'string' && value !== '') gitBranch = value;
    }

    const asUser = userText(rec);
    if (asUser !== null) {
      userTurns += 1;
      turns.push({ source: 'user', ts, text: asUser });
      continue;
    }

    const asAssistant = assistantText(rec);
    if (asAssistant !== null) {
      assistantTurns += 1;
      turns.push({ source: 'assistant', ts, text: asAssistant });
    }
  }

  return {
    sessionId: base.sessionId,
    cwd,
    gitBranch,
    aiTitle,
    customTitle,
    agentName,
    recap,
    recapTs,
    firstTs,
    lastTs,
    userTurns,
    assistantTurns,
    turns,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-recall test -- session`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add extensions/recall/src/model/session.ts extensions/recall/src/model/session.test.ts
git commit -m "feat(recall): fold JSONL lines into a session digest

absorbLines is a fold so the cold parse and the incremental one are the
same code. A trailing partial line is dropped, since a file being
appended to can end mid-record.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Match a query against a digest

Case-insensitive literal substring, over turns and over the side fields recall also searches (recap, both titles, agent name). Produces the snippet window and the highlight range.

**Files:**
- Create: `extensions/recall/src/model/search.ts`
- Create: `extensions/recall/src/model/search.test.ts`

**Interfaces:**
- Consumes: `SessionDigest`, `Turn` from Task 3.
- Produces:
  - `MatchSource = 'user' | 'assistant' | 'recap' | 'title' | 'agent'`
  - `SessionMatch { source: MatchSource; text: string; at: readonly [number, number] }`
  - `snippetAround(text: string, start: number, end: number, radius?: number): SessionMatch['text'] extends never ? never : { text: string; at: readonly [number, number] }` — see the concrete signature in the implementation: `{ text: string; at: readonly [number, number] }`
  - `matchesIn(digest: SessionDigest, query: string, max?: number): readonly SessionMatch[]`
  - `countMatches(digest: SessionDigest, query: string): number`

- [ ] **Step 1: Write the failing test**

`extensions/recall/src/model/search.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { countMatches, matchesIn, snippetAround } from './search.ts';
import { absorbLines, emptyDigest, type SessionDigest } from './session.ts';

const line = (rec: unknown): string => `${JSON.stringify(rec)}\n`;
const withTurns = (...texts: string[]): SessionDigest =>
  absorbLines(
    emptyDigest('abc'),
    texts.map((t) => line({ type: 'user', message: { role: 'user', content: t } })).join(''),
  );

describe('snippetAround', () => {
  it('keeps 60 characters each side and elides nothing when the text is short', () => {
    const out = snippetAround('set band.rail to 264', 4, 8);
    expect(out.text).toBe('set band.rail to 264');
    expect(out.at).toEqual([4, 8]);
  });

  it('windows a long line and moves the range with it', () => {
    const text = `${'a'.repeat(200)}NEEDLE${'b'.repeat(200)}`;
    const out = snippetAround(text, 200, 206, 10);
    expect(out.text).toBe(`${'a'.repeat(10)}NEEDLE${'b'.repeat(10)}`);
    expect(out.at).toEqual([10, 16]);
    expect(out.text.slice(out.at[0], out.at[1])).toBe('NEEDLE');
  });

  it('collapses newlines so a snippet is one line', () => {
    const out = snippetAround('first\nsecond NEEDLE', 13, 19);
    expect(out.text).toBe('first second NEEDLE');
    expect(out.text.slice(out.at[0], out.at[1])).toBe('NEEDLE');
  });
});

describe('matchesIn', () => {
  it('finds a case-insensitive substring in a user turn', () => {
    const hits = matchesIn(withTurns('i wanna add Recall to shepherd'), 'recall');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.source).toBe('user');
    expect(hits[0]?.text.slice(hits[0].at[0], hits[0].at[1])).toBe('Recall');
  });

  it('returns nothing for a query that is absent', () => {
    expect(matchesIn(withTurns('nothing here'), 'recall')).toEqual([]);
  });

  it('treats regex metacharacters as literal text', () => {
    expect(matchesIn(withTurns('a.b'), 'a.b')).toHaveLength(1);
    expect(matchesIn(withTurns('axb'), 'a.b')).toEqual([]);
  });

  it('caps at max and defaults that cap to 3', () => {
    const many = withTurns('recall', 'recall', 'recall', 'recall', 'recall');
    expect(matchesIn(many, 'recall')).toHaveLength(3);
    expect(matchesIn(many, 'recall', 2)).toHaveLength(2);
  });

  it('puts side-field matches before body matches, recall-style', () => {
    const digest: SessionDigest = { ...withTurns('recall in a turn'), aiTitle: 'recall in the title' };
    const hits = matchesIn(digest, 'recall');
    expect(hits[0]?.source).toBe('title');
    expect(hits.at(-1)?.source).toBe('user');
  });

  it('matches the recap and the agent name', () => {
    const digest: SessionDigest = { ...emptyDigest('abc'), recap: 'ported recall', agentName: 'recall-bot' };
    expect(matchesIn(digest, 'recall').map((m) => m.source)).toEqual(['recap', 'agent']);
  });

  it('returns nothing for an empty query rather than everything', () => {
    expect(matchesIn(withTurns('recall'), '   ')).toEqual([]);
  });

  it('finds only the FIRST match within one turn, so one turn is one row', () => {
    expect(matchesIn(withTurns('recall and recall again'), 'recall')).toHaveLength(1);
  });
});

describe('countMatches', () => {
  it('counts every matching turn, ignoring the per-session cap', () => {
    const many = withTurns('recall', 'recall', 'recall', 'recall', 'recall');
    expect(countMatches(many, 'recall')).toBe(5);
  });

  it('counts side fields too', () => {
    const digest: SessionDigest = { ...withTurns('recall'), recap: 'recall' };
    expect(countMatches(digest, 'recall')).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-recall test -- search`
Expected: FAIL — `Cannot find module './search.ts'`

- [ ] **Step 3: Write the implementation**

`extensions/recall/src/model/search.ts`:

```ts
import { bestTitle, type SessionDigest } from './session.ts';

/**
 * Matching a query against a digest — case-insensitive LITERAL substring.
 *
 * Not fuzzy, deliberately. Fuzzy is right for a title, where you are aiming at a
 * name you half remember; over prose it matches almost everything, because any
 * five letters appear in order somewhere in a paragraph. recall's own contract is
 * a grep and this keeps it.
 *
 * Not regex either, for now: the box is a box a person types a phrase into, and a
 * stray `(` would otherwise be a thrown exception on a keystroke. `/pattern` mode
 * is a recorded follow-up in the spec.
 */

export type MatchSource = 'user' | 'assistant' | 'recap' | 'title' | 'agent';

export interface SessionMatch {
  readonly source: MatchSource;
  /** The snippet, already windowed and flattened to one line. */
  readonly text: string;
  /** The run to highlight, as offsets into `text`. */
  readonly at: readonly [number, number];
}

/** recall's own window: 60 characters each side of the hit. */
export const SNIPPET_RADIUS = 60;

/** recall's own `--matches-per-session` default. */
export const DEFAULT_MATCHES_PER_SESSION = 3;

/**
 * A window around a hit, flattened to one line, with the range moved to match.
 *
 * The flattening happens BEFORE the window is cut, so the returned offsets index
 * the string that is actually drawn. Collapsing whitespace afterwards would shift
 * every character left by an unknown amount and put the highlight on the wrong
 * word — which is the one bug a highlighter must not have, because it looks like
 * a wrong search result rather than a wrong offset.
 */
export function snippetAround(
  text: string,
  start: number,
  end: number,
  radius: number = SNIPPET_RADIUS,
): { readonly text: string; readonly at: readonly [number, number] } {
  // Flatten first, tracking where the hit lands. Runs of whitespace become one
  // space, so the offsets are recomputed rather than adjusted.
  const before = text.slice(0, start).replace(/\s+/g, ' ');
  const hit = text.slice(start, end).replace(/\s+/g, ' ');
  const after = text.slice(end).replace(/\s+/g, ' ');

  const from = Math.max(0, before.length - radius);
  const head = before.slice(from);
  const tail = after.slice(0, radius);

  return { text: `${head}${hit}${tail}`, at: [head.length, head.length + hit.length] };
}

function firstIndex(haystack: string, needle: string): number {
  return haystack.toLowerCase().indexOf(needle);
}

/**
 * Every field this searches, in the order recall prints them: the side fields
 * that describe the session, then the body.
 *
 * A session found by its title should say so first — that is why it matched, and
 * a body snippet above it would be answering a question nobody asked.
 */
function sideFields(digest: SessionDigest): readonly { readonly source: MatchSource; readonly text: string }[] {
  const fields: { readonly source: MatchSource; readonly text: string }[] = [];
  if (digest.recap !== null) fields.push({ source: 'recap', text: digest.recap });
  const title = bestTitle(digest);
  if (title !== null) fields.push({ source: 'title', text: title });
  if (digest.agentName !== null) fields.push({ source: 'agent', text: digest.agentName });
  return fields;
}

/**
 * Up to `max` matches, side fields first.
 *
 * **One match per turn.** A turn that says `recall` four times is one place you
 * would go to read it, so four rows would be four ways to open the same session
 * at the same moment — and they would crowd out the other sessions the cap is
 * there to make room for.
 */
export function matchesIn(
  digest: SessionDigest,
  query: string,
  max: number = DEFAULT_MATCHES_PER_SESSION,
): readonly SessionMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === '' || max <= 0) return [];

  const out: SessionMatch[] = [];

  for (const field of sideFields(digest)) {
    if (out.length >= max) return out;
    const at = firstIndex(field.text, needle);
    if (at === -1) continue;
    const window = snippetAround(field.text, at, at + needle.length);
    out.push({ source: field.source, text: window.text, at: window.at });
  }

  for (const turn of digest.turns) {
    if (out.length >= max) return out;
    const at = firstIndex(turn.text, needle);
    if (at === -1) continue;
    const window = snippetAround(turn.text, at, at + needle.length);
    out.push({ source: turn.source, text: window.text, at: window.at });
  }

  return out;
}

/**
 * How many places in this session match — uncapped.
 *
 * The rail's `n in transcripts` row is a claim about what exists, so it counts
 * past the display cap. Capping it would make the row agree with the overlay's
 * row count and disagree with the truth.
 */
export function countMatches(digest: SessionDigest, query: string): number {
  const needle = query.trim().toLowerCase();
  if (needle === '') return 0;

  let count = 0;
  for (const field of sideFields(digest)) {
    if (firstIndex(field.text, needle) !== -1) count += 1;
  }
  for (const turn of digest.turns) {
    if (firstIndex(turn.text, needle) !== -1) count += 1;
  }
  return count;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-recall test -- search`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add extensions/recall/src/model/search.ts extensions/recall/src/model/search.test.ts
git commit -m "feat(recall): match a query against a digest, recall-style

Literal case-insensitive substring, side fields before body, one match
per turn, and a snippet flattened before it is windowed so the highlight
offsets index the string that is drawn.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Map a working directory to its project folder

Claude Code names a project folder by replacing both `/` and `.` with `-`. recall.py replaces only `/`, which is why `recall list` inside any Shepherd task finds nothing. This encodes correctly, and treats the folder name as a **prefilter** — the authority on which session belongs where is the `cwd` recorded inside the file.

**Files:**
- Create: `extensions/recall/src/model/project-dir.ts`
- Create: `extensions/recall/src/model/project-dir.test.ts`
- Create: `extensions/recall/src/model/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `encodeProjectDir(path: string): string`, `folderMatchesAny(folder: string, dirs: readonly string[]): boolean`, `cwdIsUnder(cwd: string | null, dirs: readonly string[]): boolean`.

- [ ] **Step 1: Write the failing test**

`extensions/recall/src/model/project-dir.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cwdIsUnder, encodeProjectDir, folderMatchesAny } from './project-dir.ts';

describe('encodeProjectDir', () => {
  it('replaces slashes AND dots, which is the bug recall.py has', () => {
    expect(encodeProjectDir('/Users/me/.shepherd/v2/tasks/fix-login')).toBe(
      '-Users-me--shepherd-v2-tasks-fix-login',
    );
  });

  it('encodes an ordinary path with no dots', () => {
    expect(encodeProjectDir('/Users/me/dev/shepherd')).toBe('-Users-me-dev-shepherd');
  });

  it('drops a trailing slash so one directory has one name', () => {
    expect(encodeProjectDir('/Users/me/dev/')).toBe(encodeProjectDir('/Users/me/dev'));
  });
});

describe('folderMatchesAny', () => {
  const root = '/Users/me/.shepherd/v2/tasks/fix-login';

  it('matches the task root exactly', () => {
    expect(folderMatchesAny('-Users-me--shepherd-v2-tasks-fix-login', [root])).toBe(true);
  });

  it('matches a worktree BENEATH the root, without being told about it', () => {
    expect(folderMatchesAny('-Users-me--shepherd-v2-tasks-fix-login-api', [root])).toBe(true);
  });

  it('does not match a sibling task whose name merely starts the same', () => {
    // `fix-login-2` encodes to `…-fix-login-2`, which IS the prefix plus `-2`.
    // That is the accepted cost of prefix matching: cwd decides in the end.
    expect(folderMatchesAny('-Users-me--shepherd-v2-tasks-other', [root])).toBe(false);
  });

  it('matches nothing when no dirs are given', () => {
    expect(folderMatchesAny('-Users-me-dev', [])).toBe(false);
  });
});

describe('cwdIsUnder', () => {
  const root = '/Users/me/.shepherd/v2/tasks/fix-login';

  it('accepts the directory itself', () => {
    expect(cwdIsUnder(root, [root])).toBe(true);
  });

  it('accepts a subdirectory, so an agent that cd-ed still counts', () => {
    expect(cwdIsUnder(`${root}/api/src`, [root])).toBe(true);
  });

  it('rejects a sibling that shares a name prefix', () => {
    expect(cwdIsUnder(`${root}-2`, [root])).toBe(false);
  });

  it('rejects a null cwd', () => {
    expect(cwdIsUnder(null, [root])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-recall test -- project-dir`
Expected: FAIL — `Cannot find module './project-dir.ts'`

- [ ] **Step 3: Write the implementation**

`extensions/recall/src/model/project-dir.ts`:

```ts
/**
 * A working directory ⇄ the folder Claude Code keeps its sessions in.
 *
 * **Claude Code replaces `/` AND `.` with `-`.** Measured:
 * `/Users/me/.shepherd/v2/tasks/x` is stored as
 * `-Users-me--shepherd-v2-tasks-x` — note the double dash where `/.` was.
 * `recall.py`'s `encode_project_name` replaces only `/`, which is why
 * `recall list` inside any Shepherd task prints "no sessions found" and exits 0
 * while `--project all` finds the session immediately.
 *
 * **This encoding is a PREFILTER and never the authority.** It is an
 * undocumented transform in somebody else's program and it is lossy — two paths
 * differing only in `/` vs `.` collide. Every record carries a real `cwd`, so
 * `cwdIsUnder` is what actually decides which task a session belongs to; the
 * folder name only narrows which folders are worth opening.
 */

function normalize(path: string): string {
  return path.replace(/\/+$/, '');
}

export function encodeProjectDir(path: string): string {
  return normalize(path).replace(/[/.]/g, '-');
}

/**
 * Is this project folder worth opening for any of `dirs`?
 *
 * Prefix rather than equality, so a task's ROOT also selects the worktrees
 * beneath it — `…-fix-login` selects `…-fix-login-api` — and a caller does not
 * have to enumerate them. It over-selects (a sibling task named `fix-login-2`
 * encodes to the same prefix plus `-2`), which costs a few files parsed that
 * `cwdIsUnder` then rejects.
 */
export function folderMatchesAny(folder: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => {
    const encoded = encodeProjectDir(dir);
    return folder === encoded || folder.startsWith(`${encoded}-`);
  });
}

/** Is `cwd` one of `dirs`, or inside one? Segment-boundary exact — no prefix trap. */
export function cwdIsUnder(cwd: string | null, dirs: readonly string[]): boolean {
  if (cwd === null) return false;
  const here = normalize(cwd);
  return dirs.some((dir) => {
    const base = normalize(dir);
    return here === base || here.startsWith(`${base}/`);
  });
}
```

`extensions/recall/src/model/index.ts`:

```ts
export { assistantText, awaySummaryText, parseIsoTs, recordType, userText } from './record.ts';
export { absorbLines, bestTitle, emptyDigest, isEmptyDigest, type SessionDigest, type Turn } from './session.ts';
export {
  countMatches,
  matchesIn,
  snippetAround,
  DEFAULT_MATCHES_PER_SESSION,
  SNIPPET_RADIUS,
  type MatchSource,
  type SessionMatch,
} from './search.ts';
export { cwdIsUnder, encodeProjectDir, folderMatchesAny } from './project-dir.ts';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-recall test`
Expected: PASS — all four model suites green

- [ ] **Step 5: Commit**

```bash
git add extensions/recall/src/model/project-dir.ts extensions/recall/src/model/project-dir.test.ts extensions/recall/src/model/index.ts
git commit -m "feat(recall): encode a cwd to its project folder, correctly

Claude Code replaces / AND . with -; recall.py replaces only /, which is
why it is blind inside every Shepherd task. The folder name is a
prefilter — the recorded cwd decides.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: The index — the only file that touches the filesystem

Walks the project folders, keeps a digest per session keyed on `(size, mtimeMs)`, re-reads only bytes past a stored offset, persists to `ctx.dataDir`, yields between files, and honours an `AbortSignal`.

**Files:**
- Create: `extensions/recall/src/store.ts`
- Create: `extensions/recall/src/store.test.ts`

**Interfaces:**
- Consumes: `absorbLines`, `emptyDigest`, `isEmptyDigest`, `SessionDigest`, `folderMatchesAny`, `cwdIsUnder` from Tasks 3 and 5.
- Produces:
  - `IndexedSession { path: string; digest: SessionDigest }`
  - `RecallIndex { refresh(dirs, signal?): Promise<void>; sessionsIn(dirs): readonly IndexedSession[]; save(): void }`
  - `createIndex(opts: { projectsDir: string; cacheFile: string; fs?: IndexFs; log?: (msg: string) => void }): RecallIndex`
  - `IndexFs` — the six calls this needs, so tests need no real disk.

- [ ] **Step 1: Write the failing test**

`extensions/recall/src/store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createIndex, type IndexFs } from './store.ts';

const ROOT = '/Users/me/.shepherd/v2/tasks/fix-login';
const FOLDER = '-Users-me--shepherd-v2-tasks-fix-login';

const rec = (text: string, cwd = ROOT): string =>
  `${JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: text } })}\n`;

/** An in-memory disk: `files` maps a path to its content. */
function fakeFs(files: Record<string, string>): IndexFs & { files: Record<string, string>; reads: string[] } {
  const reads: string[] = [];
  return {
    files,
    reads,
    listDirs: (dir) => (dir === '/projects' ? Object.keys(files).map((p) => p.split('/')[2] ?? '') : []),
    listFiles: (dir) =>
      Object.keys(files)
        .filter((p) => p.startsWith(`${dir}/`) && p.endsWith('.jsonl'))
        .map((p) => p.slice(dir.length + 1)),
    stat: (path) => {
      const content = files[path];
      if (content === undefined) return null;
      return { size: Buffer.byteLength(content), mtimeMs: content.length };
    },
    readRange: (path, from) => {
      reads.push(`${path}@${String(from)}`);
      return (files[path] ?? '').slice(from);
    },
    readText: (path) => files[path],
    writeText: (path, text) => {
      files[path] = text;
    },
  };
}

describe('createIndex', () => {
  it('digests a session in a matching folder', async () => {
    const fs = fakeFs({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('i wanna add recall') });
    const index = createIndex({ projectsDir: '/projects', cacheFile: '/cache.json', fs });

    await index.refresh([ROOT]);
    const sessions = index.sessionsIn([ROOT]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.digest.sessionId).toBe('aaa');
    expect(sessions[0]?.digest.turns[0]?.text).toBe('i wanna add recall');
  });

  it('never opens a folder belonging to another task', async () => {
    const fs = fakeFs({ '/projects/-Users-me-dev-other/bbb.jsonl': rec('unrelated', '/Users/me/dev/other') });
    const index = createIndex({ projectsDir: '/projects', cacheFile: '/cache.json', fs });

    await index.refresh([ROOT]);

    expect(fs.reads).toEqual([]);
    expect(index.sessionsIn([ROOT])).toEqual([]);
  });

  it('re-reads only the bytes a grown file gained', async () => {
    const first = rec('one');
    const fs = fakeFs({ [`/projects/${FOLDER}/aaa.jsonl`]: first });
    const index = createIndex({ projectsDir: '/projects', cacheFile: '/cache.json', fs });

    await index.refresh([ROOT]);
    expect(fs.reads).toEqual([`/projects/${FOLDER}/aaa.jsonl@0`]);

    fs.files[`/projects/${FOLDER}/aaa.jsonl`] = first + rec('two');
    await index.refresh([ROOT]);

    expect(fs.reads).toEqual([
      `/projects/${FOLDER}/aaa.jsonl@0`,
      `/projects/${FOLDER}/aaa.jsonl@${String(Buffer.byteLength(first))}`,
    ]);
    expect(index.sessionsIn([ROOT])[0]?.digest.turns.map((t) => t.text)).toEqual(['one', 'two']);
  });

  it('does not re-read an unchanged file at all', async () => {
    const fs = fakeFs({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('one') });
    const index = createIndex({ projectsDir: '/projects', cacheFile: '/cache.json', fs });

    await index.refresh([ROOT]);
    await index.refresh([ROOT]);

    expect(fs.reads).toHaveLength(1);
  });

  it('re-parses from scratch when a file SHRANK', async () => {
    const fs = fakeFs({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('one') + rec('two') });
    const index = createIndex({ projectsDir: '/projects', cacheFile: '/cache.json', fs });
    await index.refresh([ROOT]);

    fs.files[`/projects/${FOLDER}/aaa.jsonl`] = rec('replaced');
    await index.refresh([ROOT]);

    expect(index.sessionsIn([ROOT])[0]?.digest.turns.map((t) => t.text)).toEqual(['replaced']);
  });

  it('excludes a session whose recorded cwd is outside the dirs', async () => {
    // The folder name matched by prefix; the cwd is the authority and rejects it.
    const fs = fakeFs({ [`/projects/${FOLDER}-2/ccc.jsonl`]: rec('elsewhere', `${ROOT}-2`) });
    const index = createIndex({ projectsDir: '/projects', cacheFile: '/cache.json', fs });

    await index.refresh([ROOT]);

    expect(index.sessionsIn([ROOT])).toEqual([]);
  });

  it('drops a session with no turns, titles or recap', async () => {
    const fs = fakeFs({ [`/projects/${FOLDER}/aaa.jsonl`]: `${JSON.stringify({ type: 'summary' })}\n` });
    const index = createIndex({ projectsDir: '/projects', cacheFile: '/cache.json', fs });

    await index.refresh([ROOT]);

    expect(index.sessionsIn([ROOT])).toEqual([]);
  });

  it('stops early when the signal aborts', async () => {
    const files: Record<string, string> = {};
    for (let n = 0; n < 20; n++) files[`/projects/${FOLDER}/s${String(n)}.jsonl`] = rec(`turn ${String(n)}`);
    const fs = fakeFs(files);
    const index = createIndex({ projectsDir: '/projects', cacheFile: '/cache.json', fs });

    const controller = new AbortController();
    controller.abort();
    await index.refresh([ROOT], controller.signal);

    expect(fs.reads).toEqual([]);
  });

  it('round-trips through the cache file so a restart is not a cold parse', async () => {
    const fs = fakeFs({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('one') });
    const first = createIndex({ projectsDir: '/projects', cacheFile: '/cache.json', fs });
    await first.refresh([ROOT]);
    first.save();

    const reads = fs.reads.length;
    const second = createIndex({ projectsDir: '/projects', cacheFile: '/cache.json', fs });
    await second.refresh([ROOT]);

    expect(fs.reads).toHaveLength(reads);
    expect(second.sessionsIn([ROOT])[0]?.digest.turns[0]?.text).toBe('one');
  });

  it('ignores a cache file written by another version', async () => {
    const fs = fakeFs({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('one') });
    fs.files['/cache.json'] = JSON.stringify({ version: 0, entries: {} });
    const index = createIndex({ projectsDir: '/projects', cacheFile: '/cache.json', fs });

    await index.refresh([ROOT]);

    expect(index.sessionsIn([ROOT])).toHaveLength(1);
  });

  it('survives an unreadable cache file', async () => {
    const fs = fakeFs({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('one') });
    fs.files['/cache.json'] = 'not json';
    const index = createIndex({ projectsDir: '/projects', cacheFile: '/cache.json', fs });

    await expect(index.refresh([ROOT])).resolves.toBeUndefined();
    expect(index.sessionsIn([ROOT])).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-recall test -- store`
Expected: FAIL — `Cannot find module './store.ts'`

- [ ] **Step 3: Write the implementation**

`extensions/recall/src/store.ts`:

```ts
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { absorbLines, emptyDigest, isEmptyDigest, type SessionDigest } from './model/session.ts';
import { cwdIsUnder, folderMatchesAny } from './model/project-dir.ts';

/**
 * The stripped-text index — and the only file in this extension that touches disk.
 *
 * **Why an index at all.** recall re-reads every file on every invocation, which
 * is right for a CLI and wrong for a box that answers on each keystroke: the
 * rail's `n in transcripts` row must be true while you type. Measured on a real
 * corpus, 779 files and 481 MB of JSONL reduce to 14.8 MB of conversation, which
 * fits in memory and greps in single-digit milliseconds.
 *
 * **Why it can be incremental.** Session files are append-only, so an entry
 * remembers how many bytes it has consumed and the next refresh reads from there.
 * A file that gained 3 KB costs 3 KB — which is what keeps this responsive while
 * an agent is writing to the very transcript being searched.
 *
 * **Why the yielding matters.** `boundaries.js` denies `worker_threads` to
 * extensions, so this runs on the extension host's own thread — the thread that
 * also serves the rail's tree. It awaits between files so a cold walk cannot
 * freeze the sidebar, and it checks the abort signal on the way, because the
 * keystroke that asked for this has usually been superseded by another.
 */

const CACHE_VERSION = 1;

/** The filesystem calls this needs — an interface so a test needs no real disk. */
export interface IndexFs {
  listDirs(dir: string): readonly string[];
  listFiles(dir: string): readonly string[];
  stat(path: string): { readonly size: number; readonly mtimeMs: number } | null;
  /** Bytes from `from` to the end, decoded as UTF-8. */
  readRange(path: string, from: number): string;
  readText(path: string): string | undefined;
  writeText(path: string, text: string): void;
}

export interface IndexedSession {
  readonly path: string;
  readonly digest: SessionDigest;
}

export interface RecallIndex {
  /** Bring every session under `dirs` up to date. Resolves early if aborted. */
  refresh(dirs: readonly string[], signal?: AbortSignal): Promise<void>;
  /** What is known right now — never reads disk. */
  sessionsIn(dirs: readonly string[]): readonly IndexedSession[];
  save(): void;
}

interface Entry {
  readonly size: number;
  readonly mtimeMs: number;
  /** Bytes already folded in. A trailing partial line is deliberately NOT counted. */
  readonly consumed: number;
  readonly digest: SessionDigest;
}

export const nodeFs: IndexFs = {
  listDirs: (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  },
  listFiles: (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  },
  stat: (path) => {
    try {
      const st = statSync(path);
      return { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  },
  readRange: (path, from) => {
    try {
      const buffer = readFileSync(path);
      return buffer.subarray(from).toString('utf8');
    } catch {
      return '';
    }
  },
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  writeText: (path, text) => {
    try {
      writeFileSync(path, text, 'utf8');
    } catch {
      // A cache that cannot be written is a slower next launch, not a failure.
    }
  },
};

/**
 * How many bytes of `chunk` end in a complete line.
 *
 * `absorbLines` drops the tail after the last newline, so the offset must stop
 * there too or those bytes are lost forever rather than re-read.
 */
function completeBytes(chunk: string): number {
  const lastBreak = chunk.lastIndexOf('\n');
  return lastBreak === -1 ? 0 : Buffer.byteLength(chunk.slice(0, lastBreak + 1));
}

export function createIndex(opts: {
  readonly projectsDir: string;
  readonly cacheFile: string;
  readonly fs?: IndexFs;
  readonly log?: (message: string) => void;
}): RecallIndex {
  const fs = opts.fs ?? nodeFs;
  const entries = new Map<string, Entry>();
  let loaded = false;
  let dirty = false;

  const load = (): void => {
    if (loaded) return;
    loaded = true;
    const raw = fs.readText(opts.cacheFile);
    if (raw === undefined) return;
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
      if (parsed.version !== CACHE_VERSION) return;
      if (typeof parsed.entries !== 'object' || parsed.entries === null) return;
      for (const [path, value] of Object.entries(parsed.entries as Record<string, Entry>)) {
        entries.set(path, value);
      }
    } catch {
      // A corrupt cache is a cold start, which is correct and merely slower.
      opts.log?.('recall: cache unreadable, reindexing');
    }
  };

  const refresh = async (dirs: readonly string[], signal?: AbortSignal): Promise<void> => {
    load();
    if (dirs.length === 0 || signal?.aborted === true) return;

    for (const folder of fs.listDirs(opts.projectsDir)) {
      if (signal?.aborted === true) return;
      if (!folderMatchesAny(folder, dirs)) continue;

      const dir = `${opts.projectsDir}/${folder}`;
      for (const name of fs.listFiles(dir)) {
        if (signal?.aborted === true) return;

        const path = `${dir}/${name}`;
        const st = fs.stat(path);
        if (st === null) continue;

        const known = entries.get(path);
        if (known !== undefined && known.size === st.size && known.mtimeMs === st.mtimeMs) continue;

        // A file that shrank was rewritten rather than appended to, so the stored
        // digest describes bytes that no longer exist. Start over.
        const grew = known !== undefined && st.size >= known.size;
        const from = grew ? known.consumed : 0;
        const base = grew ? known.digest : emptyDigest(name.replace(/\.jsonl$/, ''));

        const chunk = fs.readRange(path, from);
        entries.set(path, {
          size: st.size,
          mtimeMs: st.mtimeMs,
          consumed: from + completeBytes(chunk),
          digest: absorbLines(base, chunk),
        });
        dirty = true;

        // Yield, so a cold walk of many files cannot hold the thread that draws
        // the rail. `await` on a resolved promise is one macrotask hop.
        await Promise.resolve();
      }
    }
  };

  return {
    refresh,
    sessionsIn: (dirs) => {
      const out: IndexedSession[] = [];
      for (const [path, entry] of entries) {
        if (isEmptyDigest(entry.digest)) continue;
        if (!cwdIsUnder(entry.digest.cwd, dirs)) continue;
        out.push({ path, digest: entry.digest });
      }
      // Newest first, which is the order a person expects to read them in.
      return out.sort((a, b) => (b.digest.lastTs ?? 0) - (a.digest.lastTs ?? 0));
    },
    save: () => {
      if (!dirty) return;
      fs.writeText(opts.cacheFile, JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(entries) }));
      dirty = false;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-recall test -- store`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add extensions/recall/src/store.ts extensions/recall/src/store.test.ts
git commit -m "feat(recall): the incremental transcript index

Keyed on size+mtime, reads only bytes past a stored offset, yields
between files because extensions may not use worker_threads, and honours
an abort signal.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: `tasks` defines the point

The consumer defines the seam and the provider registers into it — the shape `agents-core`/`claude-code` already uses. `tasks` must degrade to title-only filtering when nothing has registered.

**Files:**
- Modify: `extensions/tasks/src/manifest.ts`
- Modify: `extensions/tasks/src/index.ts`
- Modify: `extensions/tasks/src/manifest.test.ts`
- Create: `extensions/tasks/src/model/transcript-rollup.ts`
- Create: `extensions/tasks/src/model/transcript-rollup.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (all from `@shepherd/ext-tasks/manifest`):
  - `TRANSCRIPT_SEARCH_POINT = 'tasks.transcriptSearch'`
  - `TranscriptQuery { query: string; dirs: readonly string[]; maxPerSession?: number; signal?: AbortSignal }`
  - `TranscriptMatch { source: 'user' | 'assistant' | 'recap' | 'title' | 'agent'; text: string; at: readonly [number, number] }`
  - `TranscriptHit { dir: string; sessionId: string; title?: string; when: number; total: number; matches: readonly TranscriptMatch[] }`
  - `TranscriptSearchProvider { search(query: TranscriptQuery): Promise<readonly TranscriptHit[]> }`
  - `TASK_COMMANDS.transcriptHits = 'tasks.transcriptHits'`
  - `TASK_VIEWS.sessionSearch = 'tasks.sessionSearch'`
  - From `./model/transcript-rollup.ts`: `totalMatches(hits: readonly TranscriptHit[]): number`, `hitsByTask(hits, dirsOf): Map<string, readonly TranscriptHit[]>`

- [ ] **Step 1: Write the failing test for the rollup**

`extensions/tasks/src/model/transcript-rollup.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { TranscriptHit } from '../manifest.ts';
import { hitsByTask, totalMatches } from './transcript-rollup.ts';

const hit = (dir: string, total: number): TranscriptHit => ({
  dir,
  sessionId: 'aaa',
  when: 0,
  total,
  matches: [{ source: 'user', text: 'x', at: [0, 1] }],
});

describe('totalMatches', () => {
  it('sums every session total, not the drawn matches', () => {
    expect(totalMatches([hit('/a', 4), hit('/b', 8)])).toBe(12);
  });

  it('is zero for no hits', () => {
    expect(totalMatches([])).toBe(0);
  });
});

describe('hitsByTask', () => {
  it('groups hits under the task whose dirs contain them', () => {
    const dirsOf = new Map([
      ['task-1', ['/w/one', '/w/one/api']],
      ['task-2', ['/w/two']],
    ]);
    const grouped = hitsByTask([hit('/w/one/api', 1), hit('/w/two', 2)], dirsOf);

    expect([...grouped.keys()]).toEqual(['task-1', 'task-2']);
    expect(grouped.get('task-1')).toHaveLength(1);
  });

  it('drops a hit no task claims rather than inventing a group', () => {
    const grouped = hitsByTask([hit('/w/gone', 1)], new Map([['task-1', ['/w/one']]]));
    expect(grouped.size).toBe(0);
  });

  it('gives one task every hit across its dirs', () => {
    const grouped = hitsByTask([hit('/w/one', 1), hit('/w/one/api', 2)], new Map([['task-1', ['/w/one', '/w/one/api']]]));
    expect(grouped.get('task-1')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- transcript-rollup`
Expected: FAIL — `Cannot find module './transcript-rollup.ts'`

- [ ] **Step 3: Add the point's types to the manifest**

Append to `extensions/tasks/src/manifest.ts`:

```ts
/**
 * Any hits in these directories? — the transcript seam.
 *
 * Defined HERE and answered elsewhere, for the reason `REPO_SUGGESTIONS_POINT`
 * states above: **publish questions, not steps.** `tasks` must not learn what a
 * Claude transcript is — `store.ts` calls `resumeTarget` "opaque here (D11) … the
 * moment this extension reads it, it has learned about a vendor", and a JSONL
 * parser tracking somebody else's record types is that failure in its most
 * durable form. `shepherd.recall` registers the built-in provider; a second agent
 * vendor registers its own and the rail keeps working unchanged.
 *
 * The question is coarse on purpose. "Which sessions, and where did they match?"
 * is answerable and stable; a seam per step of reading a file would freeze one
 * vendor's format into this extension's public API.
 */
export const TRANSCRIPT_SEARCH_POINT = 'tasks.transcriptSearch';

export interface TranscriptQuery {
  /** Case-insensitive literal. Not a regex — see `recall`'s matcher. */
  readonly query: string;
  /** Task roots and worktrees. A provider may look beneath them. */
  readonly dirs: readonly string[];
  /** Snippets per session. Absent means the provider's own default (3). */
  readonly maxPerSession?: number;
  /**
   * The keystroke that asked. Providers run in this process, so a real
   * `AbortSignal` crosses — there is no port here to flatten it.
   */
  readonly signal?: AbortSignal;
}

export interface TranscriptMatch {
  readonly source: 'user' | 'assistant' | 'recap' | 'title' | 'agent';
  /** The snippet as it will be drawn: one line, already windowed. */
  readonly text: string;
  /** The run to highlight, as offsets into `text`. */
  readonly at: readonly [number, number];
}

/**
 * One session that matched.
 *
 * **No Shepherd role on it, deliberately.** `orchestrator` / `workstream` is
 * this extension's own fact, held in `task.sessions[].role`; a transcript reader
 * that returned it would have to know what a task is. `tasks` joins `sessionId`
 * against its own record to label the row, and a session it does not track — one
 * started by hand in a worktree — is labelled by its short id alone.
 */
export interface TranscriptHit {
  /** Which requested dir it was found under. Maps the hit back to a task. */
  readonly dir: string;
  readonly sessionId: string;
  readonly title?: string;
  /** Last activity, epoch ms. */
  readonly when: number;
  /** Every match in this session, uncapped — the `4 more` count comes from here. */
  readonly total: number;
  readonly matches: readonly TranscriptMatch[];
}

export interface TranscriptSearchProvider {
  search(query: TranscriptQuery): Promise<readonly TranscriptHit[]>;
}
```

Add to the `TASK_COMMANDS` object:

```ts
  /**
   * The current query's transcript hits — what the overlay draws.
   *
   * A command rather than a prop, for `suggestRepos`' reason (D5): the overlay is
   * a page and cannot reach another extension's point table. It asks its own
   * extension, which asks the provider.
   */
  transcriptHits: 'tasks.transcriptHits',
```

Add to the `TASK_VIEWS` object:

```ts
  sessionSearch: 'tasks.sessionSearch',
```

Add to `contributes.commands` in `tasksManifest`:

```ts
      { id: TASK_COMMANDS.transcriptHits, title: 'Tasks: Search transcripts' },
```

- [ ] **Step 4: Write the rollup implementation**

`extensions/tasks/src/model/transcript-rollup.ts`:

```ts
import type { TranscriptHit } from '../manifest.ts';

/**
 * Turning a flat list of hits into the two things the rail needs: one number,
 * and a grouping by task.
 *
 * Pure, and separate from `index.ts`, because both answers are easy to get subtly
 * wrong — the count must ignore the display cap, and the grouping must not invent
 * a bucket for a hit whose task has been forgotten.
 */

/**
 * Every match that exists, across every session — the `n in transcripts` number.
 *
 * `hit.total`, not `hit.matches.length`: the provider caps what it *draws* at
 * three per session, and a row claiming `3 in transcripts` when twelve exist is
 * the row lying about the thing it was added to report.
 */
export function totalMatches(hits: readonly TranscriptHit[]): number {
  return hits.reduce((sum, hit) => sum + hit.total, 0);
}

/**
 * Group hits by task id, given each task's directories.
 *
 * A hit whose `dir` no task claims is **dropped**. That happens when a task was
 * deleted between the search being issued and its answer arriving, and a bucket
 * keyed on a task nobody can look up would draw a row that cannot be clicked.
 *
 * The longest matching dir wins, so a worktree nested inside another task's root
 * is attributed to the worktree's own task rather than to whichever entry the map
 * happened to yield first.
 */
export function hitsByTask(
  hits: readonly TranscriptHit[],
  dirsOf: ReadonlyMap<string, readonly string[]>,
): Map<string, readonly TranscriptHit[]> {
  const grouped = new Map<string, TranscriptHit[]>();

  for (const hit of hits) {
    let bestTask: string | undefined;
    let bestLength = -1;
    for (const [task, dirs] of dirsOf) {
      for (const dir of dirs) {
        const base = dir.replace(/\/+$/, '');
        if (hit.dir !== base && !hit.dir.startsWith(`${base}/`)) continue;
        if (base.length > bestLength) {
          bestLength = base.length;
          bestTask = task;
        }
      }
    }
    if (bestTask === undefined) continue;

    const list = grouped.get(bestTask);
    if (list === undefined) grouped.set(bestTask, [hit]);
    else list.push(hit);
  }

  return grouped;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- transcript-rollup`
Expected: PASS, 5 tests

- [ ] **Step 6: Define the point in `activate`**

In `extensions/tasks/src/index.ts`, beside the existing `points.define` call for `REPO_SUGGESTIONS_POINT` (near line 818), add:

```ts
  /**
   * The transcript seam. Defined unconditionally — a point with no provider is a
   * question nobody answers yet, which is different from a question nobody asked.
   */
  const transcripts = points.define<TranscriptSearchProvider>(TRANSCRIPT_SEARCH_POINT);
  ctx.subscriptions.push(transcripts);
```

Add `TRANSCRIPT_SEARCH_POINT` and `type TranscriptSearchProvider`, `type TranscriptHit` to the existing import from `./manifest.ts`.

- [ ] **Step 7: Update the manifest parity test**

`extensions/tasks/src/manifest.test.ts` asserts `src/manifest.ts` matches `package.json`'s `shepherd` key. Add the new command to `extensions/tasks/package.json`'s `shepherd.contributes.commands` array so the two agree:

```json
        { "id": "tasks.transcriptHits", "title": "Tasks: Search transcripts" }
```

- [ ] **Step 8: Run the full tasks suite and commit**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test`
Expected: PASS — including `manifest.test.ts`

```bash
git add extensions/tasks/src/manifest.ts extensions/tasks/package.json extensions/tasks/src/index.ts extensions/tasks/src/model/transcript-rollup.ts extensions/tasks/src/model/transcript-rollup.test.ts
git commit -m "feat(tasks): define the tasks.transcriptSearch point

The consumer defines the seam, a vendor registers into it — the
agents-core/claude-code shape. A hit carries no Shepherd role: that is
tasks' own fact, joined here.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: `recall` registers the provider, and the app loads it

Wires the extension end to end: `activate` builds the index from `ctx.homeDir` and `ctx.dataDir`, registers into the point, and the two app-side tables learn about it.

**Files:**
- Create: `extensions/recall/src/manifest.ts`
- Create: `extensions/recall/src/manifest.test.ts`
- Create: `extensions/recall/src/index.ts`
- Create: `extensions/recall/src/index.test.ts`
- Modify: `packages/app/src/ext-host/builtins.ts`
- Modify: `packages/app/src/main/index.ts`
- Modify: `pnpm-workspace.yaml` if `extensions/*` is not already a glob

**Interfaces:**
- Consumes: `createIndex`, `IndexFs` (Task 6); `matchesIn`, `countMatches` (Task 4); `cwdIsUnder` (Task 5); `TRANSCRIPT_SEARCH_POINT`, `TranscriptSearchProvider`, `TranscriptHit`, `TranscriptQuery` (Task 7, type-only).
- Produces: `RECALL_ID = 'shepherd.recall'`, `recallManifest: Manifest`, `activate: ActivateFn`, and `searchWith(index, query): Promise<readonly TranscriptHit[]>` exported for the test.

- [ ] **Step 1: Write the manifest**

`extensions/recall/src/manifest.ts`:

```ts
import type { Manifest } from '@shepherd/sdk';

export const RECALL_ID = 'shepherd.recall';
export const TASKS_ID = 'shepherd.tasks';

/**
 * `tasks.transcriptSearch`, spelled out rather than imported.
 *
 * One extension may TYPE-import another and may not VALUE-import it
 * (`tooling/eslint/boundaries.js`), so the id has to be a local constant. The
 * shape registered with it is type-imported and therefore cannot drift; only
 * this string can, and `manifest.test.ts` pins it against the literal `tasks`
 * declares.
 */
export const TRANSCRIPT_SEARCH_POINT_ID = 'tasks.transcriptSearch';

export const recallManifest: Manifest = {
  id: RECALL_ID,
  name: 'Recall',
  version: '0.1.0',
  api: '^1.0.0',
  activation: ['onStartup'],
  /**
   * `storage` and nothing else. The index is a CACHE and lives in `ctx.dataDir`
   * as a file, not in KV: `ctx.storage` is a write-through mirror shipped across
   * the port at activation, and 14.8 MB of transcript text is exactly what
   * `tasks/src/store.ts` forbids putting there ("no transcripts, ever").
   *
   * No `process.exec`: this reads files. No `views`: it draws nothing — the
   * overlay is `tasks`' surface.
   */
  permissions: ['storage'],
  /** Declared, so the host activates `tasks` first and this can find the point. */
  dependencies: [TASKS_ID],
  contributes: {},
};
```

`extensions/recall/src/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_SEARCH_POINT } from '@shepherd/ext-tasks/manifest';
import pkg from '../package.json' with { type: 'json' };
import { recallManifest, TRANSCRIPT_SEARCH_POINT_ID } from './manifest.ts';

describe('recall manifest', () => {
  it('matches package.json', () => {
    expect(recallManifest).toEqual(pkg.shepherd);
  });

  it('names the point tasks actually defines', () => {
    expect(TRANSCRIPT_SEARCH_POINT_ID).toBe(TRANSCRIPT_SEARCH_POINT);
  });

  it('declares tasks as a dependency, so the point exists at activation', () => {
    expect(recallManifest.dependencies).toContain('shepherd.tasks');
  });
});
```

- [ ] **Step 2: Write the failing test for the provider**

`extensions/recall/src/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createIndex, type IndexFs } from './store.ts';
import { searchWith } from './index.ts';

const ROOT = '/Users/me/.shepherd/v2/tasks/fix-login';
const FOLDER = '-Users-me--shepherd-v2-tasks-fix-login';

const rec = (text: string): string =>
  `${JSON.stringify({ type: 'user', cwd: ROOT, timestamp: '2026-08-13T10:00:00.000Z', message: { role: 'user', content: text } })}\n`;

function fakeFs(files: Record<string, string>): IndexFs {
  return {
    listDirs: () => [FOLDER],
    listFiles: (dir) =>
      Object.keys(files)
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => p.slice(dir.length + 1)),
    stat: (path) => (files[path] === undefined ? null : { size: files[path].length, mtimeMs: 1 }),
    readRange: (path, from) => (files[path] ?? '').slice(from),
    readText: () => undefined,
    writeText: () => undefined,
  };
}

const indexWith = (files: Record<string, string>) =>
  createIndex({ projectsDir: '/projects', cacheFile: '/cache.json', fs: fakeFs(files) });

describe('searchWith', () => {
  it('returns a hit carrying the dir, the session id and the highlight range', async () => {
    const index = indexWith({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('i wanna add recall to shepherd') });

    const hits = await searchWith(index, { query: 'recall', dirs: [ROOT] });

    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit?.dir).toBe(ROOT);
    expect(hit?.sessionId).toBe('aaa');
    expect(hit?.when).toBe(Date.parse('2026-08-13T10:00:00.000Z'));
    const match = hit?.matches[0];
    expect(match?.text.slice(match.at[0], match.at[1])).toBe('recall');
  });

  it('reports the uncapped total beside the capped matches', async () => {
    const index = indexWith({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('recall').repeat(5) });

    const hits = await searchWith(index, { query: 'recall', dirs: [ROOT], maxPerSession: 2 });

    expect(hits[0]?.matches).toHaveLength(2);
    expect(hits[0]?.total).toBe(5);
  });

  it('omits a session that matched nothing', async () => {
    const index = indexWith({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('nothing relevant') });
    expect(await searchWith(index, { query: 'recall', dirs: [ROOT] })).toEqual([]);
  });

  it('answers an empty query with no hits rather than everything', async () => {
    const index = indexWith({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('recall') });
    expect(await searchWith(index, { query: '  ', dirs: [ROOT] })).toEqual([]);
  });

  it('attributes the hit to the longest matching requested dir', async () => {
    const index = indexWith({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('recall') });

    const hits = await searchWith(index, { query: 'recall', dirs: ['/Users/me', ROOT] });

    expect(hits[0]?.dir).toBe(ROOT);
  });

  it('resolves empty when the signal is already aborted', async () => {
    const index = indexWith({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('recall') });
    const controller = new AbortController();
    controller.abort();

    expect(await searchWith(index, { query: 'recall', dirs: [ROOT], signal: controller.signal })).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-recall test -- index`
Expected: FAIL — `searchWith` is not exported

- [ ] **Step 4: Write `activate` and `searchWith`**

`extensions/recall/src/index.ts`:

```ts
import type { ActivateFn } from '@shepherd/sdk';
import type {
  TranscriptHit,
  TranscriptQuery,
  TranscriptSearchProvider,
} from '@shepherd/ext-tasks/manifest';
import { TRANSCRIPT_SEARCH_POINT_ID } from './manifest.ts';
import { countMatches, matchesIn } from './model/search.ts';
import { bestTitle } from './model/session.ts';
import { createIndex, type RecallIndex } from './store.ts';

/**
 * `shepherd.recall` — the reader for past Claude Code sessions.
 *
 * It is its own extension rather than a corner of `tasks` or of `claude-code`,
 * and the design doc argues both halves of that. Against `tasks`: this parses a
 * vendor's file format, which is the knowledge D11 exists to keep out of the task
 * model. Against `claude-code`: that extension is about *running* an agent and
 * activates when a kind is needed, while this must answer for a task shipped
 * weeks ago whose agents are long dead and whose worktrees are gone.
 *
 * It draws nothing. The rail row and the ⇧⌘F overlay are `tasks`' surfaces; what
 * crosses from here is data.
 */

/** The longest requested dir that contains `cwd` — the task it belongs to. */
function attributeTo(cwd: string | null, dirs: readonly string[]): string | null {
  if (cwd === null) return null;
  let best: string | null = null;
  for (const dir of dirs) {
    const base = dir.replace(/\/+$/, '');
    if (cwd !== base && !cwd.startsWith(`${base}/`)) continue;
    if (best === null || base.length > best.length) best = base;
  }
  return best;
}

/**
 * One search, against a given index. Exported so it can be tested without an
 * extension host — `activate` is then only the wiring.
 */
export async function searchWith(index: RecallIndex, query: TranscriptQuery): Promise<readonly TranscriptHit[]> {
  const needle = query.query.trim();
  if (needle === '' || query.dirs.length === 0) return [];
  if (query.signal?.aborted === true) return [];

  await index.refresh(query.dirs, query.signal);
  if (query.signal?.aborted === true) return [];

  const hits: TranscriptHit[] = [];
  for (const session of index.sessionsIn(query.dirs)) {
    const matches = matchesIn(session.digest, needle, query.maxPerSession);
    if (matches.length === 0) continue;

    const dir = attributeTo(session.digest.cwd, query.dirs);
    if (dir === null) continue;

    const title = bestTitle(session.digest);
    hits.push({
      dir,
      sessionId: session.digest.sessionId,
      ...(title === null ? {} : { title }),
      when: session.digest.lastTs ?? 0,
      total: countMatches(session.digest, needle),
      matches,
    });
  }
  return hits;
}

export const activate: ActivateFn = (ctx, api) => {
  const { points } = api.proposed;

  /**
   * `~/.claude/projects`, composed here rather than handed over resolved.
   *
   * `ctx.homeDir`'s own doc says why the kernel gives raw home instead of a menu
   * of paths: "naming another program's file in this interface would make the
   * kernel the authority on that program's layout, and it is the extension that
   * knows the vendor." This is that extension.
   */
  const index = createIndex({
    projectsDir: `${ctx.homeDir}/.claude/projects`,
    cacheFile: `${ctx.dataDir}/index.json`,
    log: (message) => ctx.log.info(message),
  });

  const point = points.get<TranscriptSearchProvider>(TRANSCRIPT_SEARCH_POINT_ID);
  if (point === undefined) {
    /**
     * Reachable when `tasks` is disabled or failed to activate. Logged rather
     * than thrown: a throwing `activate` is a startup failure, and searching
     * transcripts is not load-bearing for anything else in the app.
     */
    ctx.log.warn(`nothing defines ${TRANSCRIPT_SEARCH_POINT_ID} — transcript search is off`);
    return;
  }

  ctx.subscriptions.push(
    point.register({
      search: async (query) => {
        const hits = await searchWith(index, query);
        // Persist AFTER answering: the walk is the expensive half and the caller
        // is waiting on it, while the cache only has to be right before the next
        // launch.
        index.save();
        return hits;
      },
    }),
  );
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-recall test`
Expected: PASS — all six suites

- [ ] **Step 6: Register the extension with the app**

In `packages/app/src/ext-host/builtins.ts`, add the import and the map entry:

```ts
import { activate as recall } from '@shepherd/ext-recall';
import { RECALL_ID } from '@shepherd/ext-recall/manifest';
```

```ts
  [RECALL_ID, recall],
```

In `packages/app/src/main/index.ts`, add the manifest import beside the others (line ~33) and add `recallManifest` to **both** manifest arrays (lines ~1236 and ~1259):

```ts
import { recallManifest } from '@shepherd/ext-recall/manifest';
```

Add `"@shepherd/ext-recall": "workspace:*"` to the `dependencies` of `packages/app/package.json`.

- [ ] **Step 7: Verify the whole tree, then commit**

Run: `env -u NODE_OPTIONS pnpm install`
Run: `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`
Expected: all green. If lint objects to an import in `extensions/recall`, the fix is the import, never the rule.

```bash
git add extensions/recall packages/app/src/ext-host/builtins.ts packages/app/src/main/index.ts packages/app/package.json pnpm-lock.yaml
git commit -m "feat(recall): register the provider and load the extension

activate composes ~/.claude/projects from ctx.homeDir, since an
extension may not reach node:os and the kernel deliberately hands over
raw home rather than another program's layout.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: The rail asks, and one foot row reports

`tasks` runs the transcript search alongside its title filter, debounced, and emits a single `quiet` `foot` row when there are hits. The row is drawn by a contributed component so it can raise the overlay.

**Files:**
- Modify: `extensions/tasks/src/index.ts`
- Create: `extensions/tasks/ui/transcript-count.tsx`
- Create: `extensions/tasks/ui/transcript-count.test.tsx`
- Modify: `packages/app/src/renderer/extension-ui.ts` (the row-component table)

**Interfaces:**
- Consumes: `TRANSCRIPT_SEARCH_POINT`, `TranscriptHit` (Task 7); `totalMatches` (Task 7).
- Produces: the `tasks.transcriptHits` command answering `{ query: string; total: number; hits: readonly TranscriptHit[] }`; a row component registered as `tasks.transcriptCount`.

- [ ] **Step 1: Write the failing test for the row component**

`extensions/tasks/ui/transcript-count.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TranscriptCountRow } from './transcript-count.tsx';

describe('TranscriptCountRow', () => {
  it('states the count in sentence case', () => {
    render(<TranscriptCountRow data={{ total: 12 }} />);
    expect(screen.getByRole('button', { name: /12 in transcripts/i })).toBeTruthy();
  });

  it('says one match in the singular', () => {
    render(<TranscriptCountRow data={{ total: 1 }} />);
    expect(screen.getByRole('button', { name: /1 in transcripts/i })).toBeTruthy();
  });

  it('raises the session-search view when clicked', () => {
    const raised: unknown[] = [];
    const listener = (event: Event): void => raised.push((event as CustomEvent).detail);
    window.addEventListener('sh:raise-view', listener);

    render(<TranscriptCountRow data={{ total: 3 }} />);
    screen.getByRole('button').click();

    expect(raised).toEqual(['tasks.sessionSearch']);
    window.removeEventListener('sh:raise-view', listener);
  });

  it('draws nothing at all for a zero count', () => {
    const { container } = render(<TranscriptCountRow data={{ total: 0 }} />);
    expect(container.firstChild).toBeNull();
  });

  it('draws nothing when handed data of the wrong shape', () => {
    const { container } = render(<TranscriptCountRow data={{ nope: true }} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the shortcut as a keycap', () => {
    render(<TranscriptCountRow data={{ total: 3 }} />);
    expect(screen.getByText('⇧⌘F')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- transcript-count`
Expected: FAIL — `Cannot find module './transcript-count.tsx'`

- [ ] **Step 3: Write the row component**

`extensions/tasks/ui/transcript-count.tsx`:

```tsx
import type { ReactElement } from 'react';
import { KeyCap, Row } from '@shepherd/ui';

/**
 * `12 in transcripts` — the row that admits what the rail cannot show.
 *
 * A transcript hit is four things (which task, which session, the line, when) and
 * needs two lines and about 500px. The rail is 264px with a 21px-padded field, so
 * a snippet indented under a session has ~31 characters against recall's 120: a
 * hit drawn here would truncate the exact string you searched for. So the rail
 * says how many exist and hands the query to a surface that can hold them.
 *
 * **It is a component rather than a plain row because only the renderer can raise
 * an overlay.** `sh:raise-view` is the event the shell already listens for —
 * `empty-state.tsx` dispatches the same one for the composer — and a `TreeItem`'s
 * `command` is invoked in the extension host, which has no way to reach the modal
 * layer.
 */

export interface TranscriptCountData {
  readonly total: number;
}

function totalOf(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const total = (data as { total?: unknown }).total;
  // Props cross an IPC port and arrive as `unknown`; a cast here would be a
  // promise the wire does not keep.
  return typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : null;
}

export function TranscriptCountRow({ data }: { readonly data: unknown }): ReactElement | null {
  const total = totalOf(data);
  if (total === null) return null;

  const open = (): void =>
    window.dispatchEvent(new CustomEvent('sh:raise-view', { detail: 'tasks.sessionSearch' }));

  /*
   * `role`, `tabIndex` and `onClick` are the CALLER's to supply — `Row` is a
   * `div` extending `ComponentPropsWithRef<'div'>` and says so at row.tsx:44.
   * A row that is clickable and does not say it is a button is a row a keyboard
   * cannot reach.
   */
  return (
    <Row
      quiet
      gutter={false}
      role="button"
      tabIndex={0}
      meta={<KeyCap>⇧⌘F</KeyCap>}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
    >
      {`${String(total)} in transcripts`}
    </Row>
  );
}
```

**Verified prop names** (do not guess these; they were read off the source): `Row` exposes `leading`, `meta`, `actions`, `selected`, `quiet`, `gutter`, `entering` and extends `ComponentPropsWithRef<'div'>` (`packages/ui/src/row.tsx:71`). `KeyCap` takes its keys as **children**, not a `keys` prop — it extends `ComponentPropsWithRef<'kbd'>` (`packages/ui/src/keycap.tsx:25`).

- [ ] **Step 4: Register the component in the renderer's table**

The table is **`packages/app/src/renderer/extension-ui.ts`** — not `view-dock.tsx`. It maps `'tasks.card': TaskCard` at line 57. Add beside it:

```tsx
  'tasks.transcriptCount': TranscriptCountRow,
```

with the import following whatever form the `TaskCard` import above it takes (`@shepherd/ext-tasks/ui` — the renderer may import an extension's `/ui` subpath and nothing else). Re-export `TranscriptCountRow` from `extensions/tasks/ui/index.ts` if that barrel is what the subpath resolves to.

- [ ] **Step 5: Run test to verify it passes**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- transcript-count`
Expected: PASS, 6 tests

- [ ] **Step 6: Run the search from the filter command**

In `extensions/tasks/src/index.ts`, beside the `query` variable (near line 3068), add the hit cache and the debounced search. The tree provider reads `transcriptTotal` and appends the row; the `transcriptHits` command answers the overlay.

```ts
  /**
   * The current query's transcript hits.
   *
   * Held beside `query` and never stored, for `query`'s own reason: it is a
   * property of a list somebody is looking at right now.
   */
  let hits: readonly TranscriptHit[] = [];
  let hitsFor = '';
  let searching: AbortController | undefined;

  /**
   * Ask the provider, debounced, and redraw when the answer lands.
   *
   * **The title filter never waits on this.** Fuzzy matching over titles is
   * synchronous and instant, so the rows render on the keystroke; the count row
   * appears a beat later. A search that blocked the filter would make every
   * keystroke as slow as the disk.
   */
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const searchTranscripts = (): void => {
    if (debounce !== undefined) clearTimeout(debounce);
    searching?.abort();

    if (query === '') {
      hits = [];
      hitsFor = '';
      return;
    }

    debounce = setTimeout(() => {
      const provider = transcripts.first();
      if (provider === undefined) return;

      const asked = query;
      const controller = new AbortController();
      searching = controller;

      const dirs = [...taskDirs().values()].flat();
      void provider
        .search({ query: asked, dirs, signal: controller.signal })
        .then((answer) => {
          // A superseded keystroke's answer must not overwrite a newer one.
          if (controller.signal.aborted || asked !== query) return;
          hits = answer;
          hitsFor = asked;
          changed();
        })
        .catch((error: unknown) => {
          ctx.log.warn(`transcript search failed: ${String(error)}`);
        });
    }, 120);
  };
```

Add a helper beside it that answers "which directories does each task own":

```ts
  /**
   * Each task's directories — its root, and one worktree per repo beneath it.
   *
   * The root is `ctx.dataDir`-derived exactly as provisioning derives it, so this
   * must use the same helper rather than re-deriving a path (D1b: an extension
   * cannot resolve a path, and a second derivation is a second chance to be
   * wrong). Reuse whatever `provision` already calls to locate a task root.
   */
  const taskDirs = (): ReadonlyMap<string, readonly string[]> => {
    const out = new Map<string, readonly string[]>();
    for (const task of store.list()) {
      const root = taskRootPath(task.id);
      out.set(task.id, [root, ...task.repos.map((repo) => `${root}/${repo.name}`)]);
    }
    return out;
  };
```

> `taskRootPath` is the existing helper `provision.ts` uses to locate a task root. Find its real name in `extensions/tasks/src/index.ts` and use it — do not introduce a second way to compute that path.

Call `searchTranscripts()` from the `filter` command handler, right after `changed()`:

```ts
        query = next;
        changed();
        searchTranscripts();
        return { query };
```

- [ ] **Step 7: Emit the foot row and register the command**

In the tree provider, after the shipped region's rows are pushed, append:

```ts
            /*
             * The one row that reports what the rail cannot draw. `foot` so it
             * sits at the physical bottom rather than merely last, `quiet`
             * because it is a control on the list rather than an entry in it.
             */
            if (query !== '' && hitsFor === query) {
              const total = totalMatches(hits);
              if (total > 0) {
                rows.push({
                  id: 'transcripts',
                  label: `${String(total)} in transcripts`,
                  foot: true,
                  quiet: true,
                  gutter: false,
                  component: 'tasks.transcriptCount',
                  data: { total },
                });
              }
            }
```

Register the command the overlay calls:

```ts
  ctx.subscriptions.push(
    commands.register(TASK_COMMANDS.transcriptHits, {
      // No title in the palette: it answers a page's question and means nothing
      // without a query somebody has typed.
      schema: s.object({}),
      handler: () => ({ query, total: totalMatches(hits), hits: hitsFor === query ? hits : [] }),
    }),
  );
```

- [ ] **Step 8: Verify and commit**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test`
Run: `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint`
Expected: green

```bash
git add extensions/tasks packages/app/src/renderer/extension-ui.ts
git commit -m "feat(tasks): one foot row reports the transcript matches

Debounced beside the title filter, never in front of it. The row is a
component because only the renderer can raise the overlay.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: The palette learns a two-line row

`CommandPalette` currently draws one-line rows, filters internally with `fuzzyFilter`, and caps its list at ten row-heights. Session search needs a two-line row, externally-supplied results, a pixel cap, and the leading slot it currently hides.

**Files:**
- Modify: `packages/ui/src/command-palette.tsx`
- Modify: `packages/ui/src/command-palette.css`
- Modify: `packages/ui/src/command-palette.test.tsx`

**Interfaces:**
- Consumes: `DisplaySegment`, `segmentsOfRange` (Task 1).
- Produces, added to `PaletteCommand`:
  - `detail?: readonly DisplaySegment[]` — the matched line, pre-segmented
  - `meta?: string` — right-aligned, tabular (a time)
  - `note?: string` — right-aligned under `meta` (`4 more`)
- Produces, added to `CommandPaletteProps`:
  - `query?: string`, `onQueryChange?: (query: string) => void` — controlled query
  - `filtered?: boolean` — when true, `commands` is already the result set and internal fuzzy filtering is skipped

- [ ] **Step 1: Write the failing test**

Append to `packages/ui/src/command-palette.test.tsx`:

```tsx
  it('draws a detail line with the matched run marked', () => {
    render(
      <CommandPalette
        open
        onOpenChange={() => {}}
        onRun={() => {}}
        filtered
        commands={[
          {
            id: 'a',
            title: 'Make Shepherd narrower',
            detail: [
              { text: 'set band.rail to 264 so ', matched: false },
              { text: 'shepherd', matched: true },
              { text: ' titles stop truncating', matched: false },
            ],
            meta: '14:02',
            note: '4 more',
          },
        ]}
      />,
    );

    expect(screen.getByText('shepherd')).toHaveClass('sh-ui-palette__hit');
    expect(screen.getByText('14:02')).toBeTruthy();
    expect(screen.getByText('4 more')).toBeTruthy();
  });

  it('does not filter internally when `filtered` is set', async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        open
        onOpenChange={() => {}}
        onRun={() => {}}
        filtered
        commands={[{ id: 'a', title: 'nothing like the query' }]}
      />,
    );

    await user.type(screen.getByRole('combobox'), 'zzz');

    // The provider decided this row matches; the palette must not overrule it.
    expect(screen.getByText('nothing like the query')).toBeTruthy();
  });

  it('reports query changes when controlled', async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    render(
      <CommandPalette
        open
        onOpenChange={() => {}}
        onRun={() => {}}
        commands={[]}
        query=""
        onQueryChange={onQueryChange}
      />,
    );

    await user.type(screen.getByRole('combobox'), 'r');

    expect(onQueryChange).toHaveBeenCalledWith('r');
  });

  it('opens with a controlled query already in the field', () => {
    render(
      <CommandPalette open onOpenChange={() => {}} onRun={() => {}} commands={[]} query="shepherd" onQueryChange={() => {}} />,
    );
    expect(screen.getByRole('combobox')).toHaveValue('shepherd');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ui test -- command-palette`
Expected: FAIL — `detail` is not a known prop; the controlled-query assertions fail

- [ ] **Step 3: Extend `PaletteCommand` and the props**

In `packages/ui/src/command-palette.tsx`, add to `PaletteCommand`:

```ts
  /**
   * A second line under the title — the transcript line that matched, cut into
   * runs so the hit can be painted.
   *
   * Pre-segmented by whoever searched, deliberately: this component has no
   * matcher and must not acquire one. A palette that re-derived the highlight
   * would be a second opinion about which characters were the match, which is
   * the drift `segmentsOfRange` living in the sdk exists to prevent.
   */
  readonly detail?: readonly DisplaySegment[];
  /** Right-aligned, tabular — a time. Display only. */
  readonly meta?: string;
  /** Right-aligned under `meta` — `4 more`. Display only. */
  readonly note?: string;
```

Add to `CommandPaletteProps`:

```ts
  /**
   * The query, when the caller owns it — which it does whenever the results come
   * from somewhere else and have to be re-fetched as you type.
   *
   * Uncontrolled by default, so the ⌘K palette is untouched.
   */
  readonly query?: string;
  readonly onQueryChange?: (query: string) => void;
  /**
   * `commands` is already the result set — do not filter it here.
   *
   * A transcript search runs in an extension over 14.8 MB of text it holds and
   * this component holds none of it, so the rows arriving are the answer. Running
   * `fuzzyFilter` over them again would drop rows whose match is in the body and
   * not the title, which is most of them.
   */
  readonly filtered?: boolean;
```

Make the query controlled-or-not and skip filtering when told:

```ts
  const [ownQuery, setOwnQuery] = useState('');
  const controlled = props.query !== undefined;
  const query = controlled ? props.query : ownQuery;
  const setQuery = (next: string): void => {
    if (!controlled) setOwnQuery(next);
    props.onQueryChange?.(next);
  };

  const matches = useMemo(
    () => (props.filtered === true ? commands : fuzzyFilter(query, commands, (command) => command.title)),
    [query, commands, props.filtered],
  );
```

In the reopen-clean effect, do not clear a controlled query — the caller decides what it opens with:

```ts
  useEffect(() => {
    if (!open) return;
    if (!controlled) setOwnQuery('');
    setActive(0);
    // …
  }, [open, controlled]);
```

Render the two extra lines inside the row, under the title:

```tsx
        {command.detail === undefined ? null : (
          <span className="sh-ui-palette__detail">
            {command.detail.map((segment, at) => (
              <span key={at} className={segment.matched ? 'sh-ui-palette__hit' : undefined}>
                {segment.text}
              </span>
            ))}
          </span>
        )}
```

with `meta` and `note` in the row's trailing cell.

- [ ] **Step 4: Fix the two CSS defects**

In `packages/ui/src/command-palette.css`:

Replace the row cap (line ~63). Counting rows stops meaning anything once two heights exist:

```css
/*
 * Ten rows' worth of height, as a LENGTH.
 *
 * It was `calc(10 * var(--sh-row-height))` — ten because that is where you stop
 * reading and type instead. That reasoning is about how much list a person will
 * scan, not about a row count, and transcript hits are two lines: the same ten
 * rows of pixels hold about seven of them. So the ceiling stays the same size and
 * stops claiming to be a number of rows.
 */
  max-height: calc(10 * var(--sh-row-height));
```

(keep the value; change only the comment — and then scope the leading-slot hide, which is the real fix)

Replace the blanket leading-slot hide (line ~110-119):

```css
/*
 * The leading slot is hidden for COMMAND rows only.
 *
 * It used to be hidden for every row in the list, on the grounds that "in a
 * palette no row will ever have a status" — which stopped being true when
 * `PaletteCommand.mark` was added for §1's `Jump to` rows, and this rule has been
 * quietly hiding the marks the component passes ever since. A transcript hit
 * carries the same mark the rail draws for its task, so the slot has to arrive.
 */
.sh-ui-palette__list .sh-ui-palette__item--plain .sh-ui-row__leading {
  display: none;
}
```

and set `sh-ui-palette__item--plain` on a row with neither `icon`, `mark`, nor `detail`.

Add the detail line's own type, in tokens only:

```css
/*
 * The matched line. `small` rather than `body` so the title stays the thing you
 * read first, and mono because it is quoted machine-and-human text rather than a
 * label this app wrote.
 */
.sh-ui-palette__detail {
  display: block;
  font-family: var(--sh-font-mono);
  font-size: var(--sh-font-size-small);
  line-height: var(--sh-line-height);
  color: var(--sh-text-mute);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/*
 * The hit — ONE STEP UP THE INK RAMP, and no ground at all.
 *
 * The mock drew a blue wash behind the match. There is no accent role in
 * `roles.ts` to draw it with (checked: no `accent` token exists, and the only
 * `wash` roles are `sceneGlow` and `scrim`, neither of which is a text
 * highlight), and `fillActive` is spoken for — its job is "an active row, the one
 * the keyboard is on, in a menu or a palette", which is the row this sits inside.
 *
 * So the highlight is a luminance step, which is how this language distinguishes
 * everything else: the line is `textMute` and the match is `text`. Same move as
 * the shipped region recessing by ink rather than opacity, and the bordered field
 * recessing by luminance rather than a shadow. No new token, no sixth hue.
 */
.sh-ui-palette__hit {
  color: var(--sh-text);
}
```

> **This is the one deliberate deviation from the mock, and it is worth confirming.** If a tinted ground is wanted, it needs a real role in `packages/design-tokens/src/roles.ts` with a job written down and a per-mode wash value — which is its own conversation, not a line snuck into a stylesheet. Do not add a hex literal here; `packages/ui` is the design system and a colour outside the tokens is a defect that shows up the moment the theme flips.

- [ ] **Step 5: Run test to verify it passes**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ui test -- command-palette`
Expected: PASS — the four new tests plus every existing one

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ui test -- refusals`
Expected: PASS — the stylesheet-level refusals still hold over the new rules

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/command-palette.tsx packages/ui/src/command-palette.css packages/ui/src/command-palette.test.tsx
git commit -m "feat(ui): two-line palette rows, and stop hiding the leading slot

The blanket .sh-ui-row__leading hide predates PaletteCommand.mark and
has been hiding marks the component passes. Detail lines arrive
pre-segmented: this component has no matcher and must not grow one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 11: The overlay

A contributed `surface: 'overlay'` view owned by `tasks`, keyed `CmdOrCtrl+Shift+F`, built on the palette. It opens with the rail's query already in the field and re-asks as you type.

**Files:**
- Create: `extensions/tasks/ui/session-search.tsx`
- Create: `extensions/tasks/ui/session-search.test.tsx`
- Modify: `extensions/tasks/src/index.ts`
- Modify: `packages/app/src/renderer/extension-ui.ts`

**Interfaces:**
- Consumes: `CommandPalette`, `PaletteCommand` (Task 10); `segmentsOfRange` (Task 1); the `tasks.transcriptHits` command (Task 9); `ExtensionViewProps`.
- Produces: `SessionSearchView` registered as `tasks.sessionSearch`.

- [ ] **Step 1: Register the view**

In `extensions/tasks/src/index.ts`, beside the composer's `registerViewType`:

```ts
  ctx.subscriptions.push(
    views.registerViewType(TASK_VIEWS.sessionSearch, {
      kind: 'component',
      component: TASK_VIEWS.sessionSearch,
      surface: 'overlay',
      /*
       * ⇧⌘F, and the two keys it is deliberately not.
       *
       * ⌘F stays pane-local: `find-bar.tsx` argues that a find spanning panes
       * answers with a count across screens you cannot see. ⌘K is commands. ⇧⌘F
       * is what every editor already binds to "find across everything", so it is
       * the one gesture a person arrives with.
       */
      key: 'CmdOrCtrl+Shift+F',
      title: 'Session search',
    }),
  );
```

- [ ] **Step 2: Write the failing test**

`extensions/tasks/ui/session-search.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ok } from '@shepherd/sdk';
import { SessionSearchView } from './session-search.tsx';

const hit = (over: Record<string, unknown> = {}) => ({
  dir: '/w/one',
  sessionId: 'a3f81c2b3c4d',
  title: 'Recall in task search',
  when: Date.parse('2026-08-13T14:02:00.000Z'),
  total: 5,
  matches: [{ source: 'user', text: 'i wanna add recall to shepherd', at: [12, 18] }],
  ...over,
});

const answering = (value: unknown) => vi.fn().mockResolvedValue(ok(value));

describe('SessionSearchView', () => {
  it('opens with the rail query already in the field', async () => {
    const invoke = answering({ query: 'recall', total: 5, hits: [hit()] });
    render(<SessionSearchView invoke={invoke} done={() => {}} />);

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('recall'));
  });

  it('draws one row per match, with the session and the highlighted line', async () => {
    const invoke = answering({ query: 'recall', total: 5, hits: [hit()] });
    render(<SessionSearchView invoke={invoke} done={() => {}} />);

    await waitFor(() => expect(screen.getByText('Recall in task search')).toBeTruthy());
    expect(screen.getByText('recall')).toHaveClass('sh-ui-palette__hit');
    // The short id, never a pane: a pane does not survive a restart and does not
    // exist for an archived task.
    expect(screen.getByText(/a3f81c/)).toBeTruthy();
  });

  it('shows how many more matches that session holds', async () => {
    const invoke = answering({ query: 'recall', total: 5, hits: [hit()] });
    render(<SessionSearchView invoke={invoke} done={() => {}} />);

    await waitFor(() => expect(screen.getByText('4 more')).toBeTruthy());
  });

  it('omits the more-count when every match is shown', async () => {
    const invoke = answering({ query: 'recall', total: 1, hits: [hit({ total: 1 })] });
    render(<SessionSearchView invoke={invoke} done={() => {}} />);

    await waitFor(() => expect(screen.getByText(/recall/)).toBeTruthy());
    expect(screen.queryByText(/more/)).toBeNull();
  });

  it('falls back to the short id when a session has no title', async () => {
    const invoke = answering({ query: 'recall', total: 1, hits: [hit({ title: undefined })] });
    render(<SessionSearchView invoke={invoke} done={() => {}} />);

    await waitFor(() => expect(screen.getByText(/a3f81c/)).toBeTruthy());
  });

  it('says so when nothing matched', async () => {
    const invoke = answering({ query: 'zzz', total: 0, hits: [] });
    render(<SessionSearchView invoke={invoke} done={() => {}} />);

    await waitFor(() => expect(screen.getByText(/No matching/i)).toBeTruthy());
  });

  it('survives a refused command instead of throwing', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: false, error: { code: 'nope', message: 'no' } });
    render(<SessionSearchView invoke={invoke} done={() => {}} />);

    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- session-search`
Expected: FAIL — `Cannot find module './session-search.tsx'`

- [ ] **Step 4: Write the view**

`extensions/tasks/ui/session-search.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { segmentsOfRange } from '@shepherd/sdk';
import { CommandPalette, type PaletteCommand } from '@shepherd/ui';
import type { ExtensionViewProps } from '@shepherd/sdk';
import { TASK_COMMANDS } from '../src/manifest.ts';
import type { TranscriptHit } from '../src/manifest.ts';

/**
 * ⇧⌘F — the surface a transcript hit actually fits on.
 *
 * The rail filters titles in place and reports a count; this is where the count
 * is spent. It is the `CommandPalette` rather than a new component because the
 * palette already owns everything hard about this shape: the 620px `lg` modal
 * pinned at 12vh, the query row, group heads that appear only when a group has
 * matches, mousemove-not-mouseenter selection, and close-on-activate. Session
 * search is a second scope inside it, not a third surface.
 */

const HITS = TASK_COMMANDS.transcriptHits;

interface Answer {
  readonly query: string;
  readonly total: number;
  readonly hits: readonly TranscriptHit[];
}

/** `unknown` off a port, read defensively — `ok` says the call worked, not the shape. */
function readAnswer(value: unknown): Answer | null {
  if (typeof value !== 'object' || value === null) return null;
  const typed = value as { query?: unknown; total?: unknown; hits?: unknown };
  if (typeof typed.query !== 'string' || typeof typed.total !== 'number') return null;
  if (!Array.isArray(typed.hits)) return null;
  return { query: typed.query, total: typed.total, hits: typed.hits as readonly TranscriptHit[] };
}

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * One palette row per MATCH, not per session.
 *
 * A session that matched in three places is three places you might want to land,
 * and collapsing them to one row would make the choice for you. The session is
 * named on each of them, which is what keeps the rows attributable.
 */
function rowsOf(hits: readonly TranscriptHit[]): readonly PaletteCommand[] {
  return hits.flatMap((hit) => {
    const short = hit.sessionId.slice(0, 6);
    const label = hit.title ?? short;
    const extra = hit.total - hit.matches.length;

    return hit.matches.map((match, at) => ({
      id: `${hit.sessionId}:${String(at)}`,
      title: label,
      group: 'Transcripts',
      detail: segmentsOfRange(match.text, [match.at[0], match.at[1]]),
      meta: hit.when === 0 ? undefined : clock.format(new Date(hit.when)),
      // The session's identity, and never a pane id: a pane does not survive a
      // restart and does not exist at all for an archived task, which is most of
      // what this searches.
      ...(at === 0 && extra > 0 ? { note: `${String(extra)} more` } : {}),
      ...(hit.title === undefined ? {} : { shortcut: short }),
    }));
  });
}

export function SessionSearchView({ invoke, done }: ExtensionViewProps): ReactElement {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [query, setQuery] = useState<string | undefined>(undefined);

  /**
   * Ask on mount, so the overlay opens on the rail's query.
   *
   * This is the whole reason `12 in transcripts` carries the query: the field is
   * pre-filled and nothing is retyped. The rail's own query is authoritative
   * until the user types here.
   */
  useEffect(() => {
    let live = true;
    void invoke(HITS, {}).then((result) => {
      if (!live || !result.ok) return;
      const next = readAnswer(result.value);
      if (next === null) return;
      setAnswer(next);
      setQuery((current) => current ?? next.query);
    });
    return () => {
      live = false;
    };
  }, [invoke]);

  const onQueryChange = useCallback(
    (next: string) => {
      setQuery(next);
      // The rail's filter command is what owns the query, so typing here moves
      // the rail too — one query, two views of it.
      void invoke(TASK_COMMANDS.filter, { query: next }).then(() => invoke(HITS, {})).then((result) => {
        if (!result.ok) return;
        const parsed = readAnswer(result.value);
        if (parsed !== null) setAnswer(parsed);
      });
    },
    [invoke],
  );

  const rows = useMemo(() => rowsOf(answer?.hits ?? []), [answer]);

  return (
    <CommandPalette
      open
      filtered
      query={query ?? ''}
      onQueryChange={onQueryChange}
      onOpenChange={(next) => {
        if (!next) done();
      }}
      commands={rows}
      onRun={() => {
        // Opening the session AT THE LINE is a recorded follow-up; for now the
        // overlay closes and the rail is already filtered to the task.
        done();
      }}
      placeholder="Search sessions…"
      emptyLabel="No matching transcript"
    />
  );
}
```

- [ ] **Step 5: Register the component in the renderer's table**

Add to the same table Task 9 touched, `packages/app/src/renderer/extension-ui.ts`:

```tsx
  'tasks.sessionSearch': SessionSearchView,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-tasks test -- session-search`
Expected: PASS, 7 tests

- [ ] **Step 7: Full verification**

Run: `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`
Expected: green

Run: `env -u NODE_OPTIONS pnpm smoke:m3`
Expected: green. **A green unit suite is not a working app** — this repo's archive-on-close bug passed every unit test because each supplied both halves of the correlation.

- [ ] **Step 8: Drive the real app**

```bash
env -u NODE_OPTIONS pnpm ship --dev
```

Then in Shep Night, by hand:
1. Type a word you know appears in a past session into the rail's field. Rows filter on the keystroke; `n in transcripts` appears a beat later.
2. Click that row. The overlay opens with the query already in the field.
3. Press ⇧⌘F from the terminal with the rail empty. The overlay opens empty.
4. Press ⌘F. The find bar opens, not the overlay.
5. Click into the rail's search field. **The overlay must not open.**
6. Search for a word from a **shipped** task. It must appear — 33 of them have intact transcripts and deleted worktrees.

- [ ] **Step 9: Commit**

```bash
git add extensions/tasks packages/app/src/renderer/extension-ui.ts
git commit -m "feat(tasks): the session-search overlay on ⇧⌘F

One row per match, not per session. Opens on the rail's query so nothing
is retyped. ⌘F stays pane-local and focusing the rail field never opens
this.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 12: Fix `recall.py`'s project encoding

Separate repo (`~/Home/dev/tools/recall`), one line, and worth doing while it is in mind: today `recall list` inside any Shepherd task prints "no sessions found" and exits 0.

**Files:**
- Modify: `~/Home/dev/tools/recall/recall.py:339-342`

- [ ] **Step 1: Reproduce the bug**

```bash
cd /Users/eshaannileshshah/.shepherd/v2/tasks/integrate-recall-into-task-search
recall list --limit 2
```

Expected: `no sessions found`

```bash
recall list --project all --limit 1
```

Expected: a session in this very directory — proving the corpus is there and only the encoding is wrong.

- [ ] **Step 2: Fix `encode_project_name`**

```python
def encode_project_name(path: str) -> str:
    """Encode a filesystem path to the Claude projects folder name.

    Both `/` and `.` become `-`. Measured against a real projects dir:
    `/Users/me/.shepherd/v2/tasks/x` is stored as
    `-Users-me--shepherd-v2-tasks-x` — note the double dash where `/.` was.
    Replacing only `/` made every `--project` lookup on a dotted path miss,
    which meant `recall list` inside any Shepherd task (all of which live under
    `~/.shepherd`) printed "no sessions found" and exited 0.
    """
    abs_path = os.path.abspath(os.path.expanduser(path))
    return re.sub(r"[/.]", "-", abs_path)
```

- [ ] **Step 3: Verify the fix**

```bash
cd /Users/eshaannileshshah/.shepherd/v2/tasks/integrate-recall-into-task-search
recall list --limit 2
```

Expected: this task's sessions, with no `--project` flag

```bash
cd ~/Home/dev/tools/recall && recall list --limit 1
```

Expected: still works for an undotted path — the fix must not break the common case

- [ ] **Step 4: Commit in that repo**

```bash
cd ~/Home/dev/tools/recall
git add recall.py
git commit -m "fix: encode . as well as / in project folder names

Claude Code replaces both. Replacing only / made every --project lookup
on a dotted path miss, so `recall list` inside any ~/.shepherd task
printed 'no sessions found' and exited 0.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage** — every section of the design doc maps to a task:

| spec section | task |
|---|---|
| The split, and why (rail filters, foot row, overlay) | 9, 11 |
| Scope: Claude Code sessions only | 2 (the record filters are the boundary), 8 |
| Archived tasks searchable | 6 (`sessionsIn` never consults a worktree) |
| Where the code lives — new extension, the point | 7, 8 |
| Path resolution — `cwd` over folder name | 5, 6 |
| recall.py's encoding bug | 5 (correct version), 12 (the CLI fix) |
| The index — strip once, offsets, task dirs only, cheap query first | 3, 6, 9 |
| The overlay — palette reuse, leading slot, pixel cap, `segmentsOfRange` | 10, 11 |
| Session label is `role · short-id`, never a pane | 11 |
| Matching — fuzzy titles, literal transcripts | 4, 9 (the title filter is untouched), 10 (`filtered`) |
| Keys — ⇧⌘F, ⌘F untouched, rail focus never opens | 11 (steps 1 and 8) |
| Testing list | tests in 2–6, 9–11; smoke in 11 |
| Deferred items | not implemented, and named in the code comments that would otherwise invite them |

**One gap found and left deliberate:** the spec's test list includes "the rail never changes height when a query matches transcripts". That is a property of the *rendered rail*, which no unit test in this tree can see — the composer shipped three defects that 2,000 green tests could not, all of them properties of CSS. It is step 8.1 of Task 11's manual pass instead, which is the honest place for it.

**Type consistency** — checked across tasks: `SessionDigest` gained `recapTs` in Task 3 and every later reference goes through `absorbLines`/`bestTitle` rather than constructing one; `SessionMatch` (recall's internal name) is mapped to `TranscriptMatch` (the point's name) in Task 8's `searchWith`, and the two have identical shapes so the mapping is a rename at the boundary, not a conversion; `matchesIn(digest, query, max)` is called with `query.maxPerSession` which is `number | undefined`, and the parameter's default handles that; `totalMatches`/`hitsByTask` are used in Task 9 with the signatures Task 7 defines. `hitsByTask` is defined and tested in Task 7 but not yet consumed — it is what a follow-up needs to nest hits under task rows, and Task 9 uses only `totalMatches`. Flagging rather than deleting: it is five lines with a test, and removing it would leave the grouping to be re-derived.

**Placeholder scan** — clean, with two deliberate "find the real name" notes (Task 9's `taskRootPath`, Task 9's `Row` props). Both are cases where guessing a name would be worse than telling the implementer to read the file, and both name the file to read.

---

Plan complete and saved to `docs/superpowers/plans/2026-08-17-recall-session-search.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, reviewed between tasks, fast iteration

**2. Inline Execution** — tasks executed in this session via executing-plans, batch execution with checkpoints

Which approach?
