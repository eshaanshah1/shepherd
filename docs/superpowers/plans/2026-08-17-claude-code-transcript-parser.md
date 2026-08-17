# Claude Code Transcript Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Shepherd a full-fidelity Claude Code transcript parser — blocks, tool calls, usage, lifecycle, subagents, live tailing — with today's search digest becoming a projection of it rather than a second reader.

**Architecture:** One incremental fold (`absorb`) over JSONL turns a byte chunk into a `ParsedSession`; `digestOf` projects that to the existing `SessionDigest`. The index caches digests only — a full parse is streamed on demand and never written to disk. A watcher reuses the same fold for live tails and emits appended messages on the event bus.

**Tech Stack:** TypeScript (ESM, `.ts` extensions in imports), vitest, `node:fs`, `@shepherd/sdk`. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-17-claude-code-transcript-parser-design.md`](../specs/2026-08-17-claude-code-transcript-parser-design.md)

## Global Constraints

- **All commands run from `v2/` and take `env -u NODE_OPTIONS`.** An ambient `NODE_OPTIONS` makes Electron exit 9 before any of our code runs.
- **Every model function takes `unknown` and returns `null` on anything unexpected.** A record is a line of somebody else's file format; a cast is a promise this code cannot keep. Never throw from `src/model/**` or `src/parse/**`.
- **Imports inside the extension use explicit `.ts` extensions** (`./record.ts`), matching every existing file.
- **An extension may import `@shepherd/sdk` and nothing else at runtime.** `@shepherd/ext-tasks` is `import type` only.
- **`node:fs` is permitted; `node:os`, `node:child_process`, `node:worker_threads` are not** (`tooling/eslint/boundaries.js`, `OS_APIS`).
- **Nothing may call `Date.now()`** — time comes from `ctx.clock`.
- **The index caches digests only.** No message bodies, no tool output, no blocks in `index.json`, ever.
- **The extension host is single-threaded and also serves the sidebar.** Any loop over files must `await` between items.
- Verification loop for every task: `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `extensions/transcripts/src/model/record.ts` | Safe accessors over `unknown` (exists; gains `stringField`, `boolField`) |
| `extensions/transcripts/src/model/blocks.ts` | Content array → typed blocks; tool-result coercion |
| `extensions/transcripts/src/model/noise.ts` | Harness-injected-turn classifier (tag allowlist + prefixes) |
| `extensions/transcripts/src/model/message.ts` | One record → `TranscriptMessage` |
| `extensions/transcripts/src/model/lifecycle.ts` | One record → `Lifecycle` |
| `extensions/transcripts/src/model/usage.ts` | Usage extraction, dedupe key, rollup |
| `extensions/transcripts/src/parse/session.ts` | The fold: `absorb`, `emptySession`, `completeBytes` |
| `extensions/transcripts/src/parse/digest.ts` | `ParsedSession` → `SessionDigest` |
| `extensions/transcripts/src/parse/subagents.ts` | Sibling subagent-file discovery |
| `extensions/transcripts/src/store.ts` | The digest index (exists; gains generation counter, subagent walk, cache v2) |
| `extensions/transcripts/src/watch.ts` | `fs.watch` + debounce + incremental tail |
| `extensions/transcripts/src/index.ts` | `activate`: search point, commands, events |
| `extensions/transcripts/fixtures/*.jsonl` | Hand-written fixtures, one shape each |

`src/model/session.ts` is deleted at Task 8 (its fold moves to `parse/session.ts`); `src/model/index.ts` becomes the barrel for the whole module.

---

### Task 1: Rename `recall` → `transcripts`

Do this first so every later task writes to its final path.

**Files:**
- Move: `extensions/recall/` → `extensions/transcripts/`
- Modify: `extensions/transcripts/package.json`, `extensions/transcripts/vitest.config.ts`, `extensions/transcripts/src/manifest.ts`
- Modify: `packages/app/package.json:38`, `packages/app/src/ext-host/builtins.ts:14-15`, `packages/app/src/ext-host/builtins.test.ts:8`, `packages/app/src/main/index.ts:37,1293,1332`
- Modify: `extensions/tasks/src/manifest.ts:147` (comment naming `shepherd.recall`)

**Interfaces:**
- Consumes: nothing.
- Produces: package `@shepherd/ext-transcripts`, extension id `shepherd.transcripts`, exported const `TRANSCRIPTS_ID` (replacing `RECALL_ID`), exported const `transcriptsManifest` (replacing `recallManifest`).

- [ ] **Step 1: Move the directory**

```bash
cd v2
git mv extensions/recall extensions/transcripts
```

- [ ] **Step 2: Rename the package and extension id**

In `extensions/transcripts/package.json`, set `"name": "@shepherd/ext-transcripts"`, `"description": "shepherd.transcripts — parses Claude Code transcripts and answers tasks' transcript searches."`, and `"shepherd": { "id": "shepherd.transcripts", "name": "Transcripts", … }` (leave `version`, `api`, `activation`, `permissions`, `dependencies`, `contributes` unchanged).

In `extensions/transcripts/vitest.config.ts`, set `name: '@shepherd/ext-transcripts'`.

In `extensions/transcripts/src/manifest.ts`, rename `RECALL_ID` → `TRANSCRIPTS_ID` with value `'shepherd.transcripts'`, and `recallManifest` → `transcriptsManifest` with `id: TRANSCRIPTS_ID`, `name: 'Transcripts'`.

- [ ] **Step 3: Update the seven consumers**

```bash
cd v2
grep -rl "ext-recall\|RECALL_ID\|recallManifest" \
  packages/app extensions/tasks --include=*.ts --include=*.json \
  | xargs sed -i '' \
    -e 's/@shepherd\/ext-recall/@shepherd\/ext-transcripts/g' \
    -e 's/RECALL_ID/TRANSCRIPTS_ID/g' \
    -e 's/recallManifest/transcriptsManifest/g'
```

Then in `packages/app/src/ext-host/builtins.ts`, rename the local import binding `activate as recall` → `activate as transcripts` and the map entry's value accordingly. In `extensions/tasks/src/manifest.ts:147`, change the prose `shepherd.recall` → `shepherd.transcripts`.

- [ ] **Step 4: Reinstall the workspace link and verify**

```bash
cd v2 && env -u NODE_OPTIONS pnpm install
env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
```
Expected: all pass. No behaviour changed.

- [ ] **Step 5: Confirm nothing still names the old package**

```bash
cd v2 && grep -rn "ext-recall\|RECALL_ID\|recallManifest" --include=*.ts --include=*.json . | grep -v node_modules
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "Rename recall to transcripts, before it stops being a search extension"
```

---

### Task 2: Fixtures and the golden baseline

Records what today's parser produces, so Task 9's rewrite has something to be compared against.

**Files:**
- Create: `extensions/transcripts/fixtures/tool-loop.jsonl`, `interrupt.jsonl`, `compaction.jsonl`, `duplicate-usage.jsonl`, `markup-prompt.jsonl`, `titles-and-recap.jsonl`
- Create: `extensions/transcripts/src/fixtures.ts`
- Create: `extensions/transcripts/src/parse/golden.test.ts`

**Interfaces:**
- Produces: `FIXTURES: readonly string[]` (fixture base names) and `readFixture(name: string): string` from `src/fixtures.ts`.

- [ ] **Step 1: Write the fixtures**

`fixtures/tool-loop.jsonl` — one prompt, a tool call, its result, a final answer:

```jsonl
{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-08-01T10:00:00.000Z","sessionId":"s1","cwd":"/repo","gitBranch":"main","message":{"role":"user","content":"list the files"}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-08-01T10:00:01.000Z","requestId":"r1","message":{"id":"m1","model":"claude-opus-5","stop_reason":"tool_use","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"Looking now."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}
{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-08-01T10:00:02.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"a.ts\nb.ts"}]}}
{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"2026-08-01T10:00:03.000Z","requestId":"r2","message":{"id":"m2","model":"claude-opus-5","stop_reason":"end_turn","usage":{"input_tokens":20,"output_tokens":8,"cache_read_input_tokens":100,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"Two files: a.ts and b.ts."}]}}
```

`fixtures/interrupt.jsonl`:

```jsonl
{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-08-02T10:00:00.000Z","sessionId":"s2","cwd":"/repo","message":{"role":"user","content":"start a long job"}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-08-02T10:00:01.000Z","message":{"id":"m1","model":"claude-opus-5","stop_reason":"tool_use","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"sleep 900"}}]}}
{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-08-02T10:00:02.000Z","message":{"role":"user","content":"[Request interrupted by user]"}}
```

`fixtures/compaction.jsonl`:

```jsonl
{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-08-03T10:00:00.000Z","sessionId":"s3","cwd":"/repo","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context."}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-08-03T10:00:01.000Z","message":{"id":"m1","model":"claude-opus-5","stop_reason":"end_turn","content":[{"type":"text","text":"Picking up where we left off."}]}}
```

`fixtures/duplicate-usage.jsonl` — the same `message.id` twice, the second fuller. Deduped output must be 40, not 55:

```jsonl
{"type":"assistant","uuid":"a1","parentUuid":null,"timestamp":"2026-08-04T10:00:00.000Z","sessionId":"s4","cwd":"/repo","requestId":"r1","message":{"id":"m1","model":"claude-opus-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":15,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"partial"}]}}
{"type":"assistant","uuid":"a2","parentUuid":null,"timestamp":"2026-08-04T10:00:01.000Z","requestId":"r1","message":{"id":"m1","model":"claude-opus-5","stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":40,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"partial and then some"}]}}
```

`fixtures/markup-prompt.jsonl` — the regression fixture for the noise defect. Both user turns must survive:

```jsonl
{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-08-05T10:00:00.000Z","sessionId":"s5","cwd":"/repo","message":{"role":"user","content":"<details><summary>the failing config</summary><code>port: 8080</code></details>"}}
{"type":"user","uuid":"u2","parentUuid":"u1","timestamp":"2026-08-05T10:00:01.000Z","message":{"role":"user","content":"<system-reminder>internal machinery</system-reminder>"}}
{"type":"assistant","uuid":"a1","parentUuid":"u2","timestamp":"2026-08-05T10:00:02.000Z","message":{"id":"m1","model":"claude-opus-5","stop_reason":"end_turn","content":[{"type":"text","text":"Port 8080 is already bound."}]}}
```

`fixtures/titles-and-recap.jsonl`:

```jsonl
{"type":"ai-title","aiTitle":"Fixing the port conflict"}
{"type":"custom-title","customTitle":"port bug"}
{"type":"agent-name","agentName":"Explore"}
{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-08-06T10:00:00.000Z","sessionId":"s6","cwd":"/repo","gitBranch":"fix/port","message":{"role":"user","content":"why is the port taken"}}
{"type":"system","subtype":"away_summary","timestamp":"2026-08-06T10:00:05.000Z","content":"You asked about a port conflict. (disable recaps in /config)"}
```

- [ ] **Step 2: Write the fixture reader**

`src/fixtures.ts`:

```ts
import { readFileSync } from 'node:fs';

/** Every fixture, by base name. Kept as data so a new fixture joins the golden run. */
export const FIXTURES = [
  'tool-loop',
  'interrupt',
  'compaction',
  'duplicate-usage',
  'markup-prompt',
  'titles-and-recap',
] as const;

export function readFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}.jsonl`, import.meta.url), 'utf8');
}
```

- [ ] **Step 3: Write the golden test against TODAY's parser**

`src/parse/golden.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FIXTURES, readFixture } from '../fixtures.ts';
import { absorbLines, emptyDigest } from '../model/session.ts';

/**
 * The baseline. Recorded against the parser as it stands so the rewrite in
 * Task 9 has something to be judged against — every difference must be a
 * reviewed, intended one, not a surprise.
 */
describe('digest golden', () => {
  for (const name of FIXTURES) {
    it(`${name} folds to a stable digest`, () => {
      expect(absorbLines(emptyDigest(name), readFixture(name))).toMatchSnapshot();
    });
  }
});
```

- [ ] **Step 4: Run it to record the snapshots**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test
```
Expected: PASS, with 6 snapshots written to `src/parse/__snapshots__/golden.test.ts.snap`.

- [ ] **Step 5: Read the snapshot and confirm it captures the defect**

Open `src/parse/__snapshots__/golden.test.ts.snap` and confirm the `markup-prompt` entry has `userTurns: 0` — today's filter drops *both* user turns, including the legitimate `<details>` paste. This is the bug Task 3 fixes and Task 9 will show as a diff.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "Record what the digest is today, before anything moves"
```

---

### Task 3: `model/noise.ts` — the harness-tag allowlist

**Files:**
- Create: `extensions/transcripts/src/model/noise.ts`
- Create: `extensions/transcripts/src/model/noise.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isHarnessInjectedText(text: string): boolean`, `HARNESS_TAGS: ReadonlySet<string>`, `CANDIDATE_TAGS: ReadonlySet<string>`.

- [ ] **Step 1: Write the failing test**

`src/model/noise.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isHarnessInjectedText } from './noise.ts';

describe('isHarnessInjectedText', () => {
  it('names an observed harness tag', () => {
    expect(isHarnessInjectedText('<system-reminder>be good</system-reminder>')).toBe(true);
    expect(isHarnessInjectedText('<task-notification>done</task-notification>')).toBe(true);
    expect(isHarnessInjectedText('<local-command-stdout>hi</local-command-stdout>')).toBe(true);
  });

  it('keeps a prompt that is entirely ordinary markup', () => {
    expect(isHarnessInjectedText('<details><summary>cfg</summary></details>')).toBe(false);
    expect(isHarnessInjectedText('<code>port: 8080</code>')).toBe(false);
    expect(isHarnessInjectedText('<my-element>hi</my-element>')).toBe(false);
  });

  it('keeps a real prompt that merely mentions a harness tag', () => {
    expect(isHarnessInjectedText('why does <system-reminder> keep appearing?')).toBe(false);
  });

  it('names the observed prefixes', () => {
    expect(isHarnessInjectedText('[Request interrupted by user]')).toBe(true);
    expect(
      isHarnessInjectedText('This session is being continued from a previous conversation'),
    ).toBe(true);
  });

  it('does not treat a candidate tag as machinery yet', () => {
    expect(isHarnessInjectedText('<teammate-message>hi</teammate-message>')).toBe(false);
  });

  it('is unbothered by leading whitespace and case', () => {
    expect(isHarnessInjectedText('  \n <SYSTEM-REMINDER>x</SYSTEM-REMINDER>')).toBe(true);
  });

  it('is cheap on a huge paste', () => {
    expect(isHarnessInjectedText(`<code>${'x'.repeat(200_000)}</code>`)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test noise
```
Expected: FAIL — cannot resolve `./noise.ts`.

- [ ] **Step 3: Implement**

`src/model/noise.ts`:

```ts
/**
 * Which user-role turns are the harness talking to itself.
 *
 * **An allowlist of tags observed in this corpus, never a shape.** Measured
 * across 720 Claude session files: `<code>` appears 3742 times, `<p>` 3313,
 * `<td>` 3213, `<details>` 433. Treating any paired tag as machinery — which is
 * what this file replaces — deletes a person's pasted config from the index.
 */

/** The eleven attested in this corpus. See the design doc, §2.5. */
export const HARNESS_TAGS: ReadonlySet<string> = new Set([
  'bash-input',
  'bash-stderr',
  'bash-stdout',
  'command-args',
  'command-message',
  'command-name',
  'local-command-caveat',
  'local-command-stdout',
  'system-reminder',
  'task-notification',
  'user-prompt-submit-hook',
]);

/**
 * In orca's list, absent from this corpus.
 *
 * Not enabled: orca's own rule is that only observed tags count, and its list is
 * shared across seven providers, so an entry may be another harness's. Each is a
 * plausible Claude Code feature simply unexercised here — promote one by moving
 * it up, once a transcript shows it.
 */
export const CANDIDATE_TAGS: ReadonlySet<string> = new Set([
  'agent-message',
  'cross-session-message',
  'fork-boilerplate',
  'local-command-stderr',
  'mcp-polling-update',
  'mcp-resource-update',
  'teammate-message',
  'user-memory-input',
]);

const PREFIXES: readonly string[] = [
  '[request interrupted',
  'caveat: the messages below were generated by the user while running local commands',
  'this session is being continued from a previous conversation',
  '<channel source=',
];

/** Only the head is inspected, so a multi-MB paste costs a fixed slice. */
const HEAD = 256;

const LEADING_TAG = /^<([a-z][a-z0-9-]*)[\s>]/;

export function isHarnessInjectedText(text: string): boolean {
  const head = text.slice(0, HEAD).trimStart().toLowerCase();
  if (head === '') return false;

  const tag = LEADING_TAG.exec(head);
  if (tag !== null && HARNESS_TAGS.has(tag[1])) return true;

  return PREFIXES.some((prefix) => head.startsWith(prefix));
}
```

- [ ] **Step 4: Run the tests**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test noise
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Machinery is a named tag, not any tag that closes"
```

---

### Task 4: `model/blocks.ts` — content blocks

**Files:**
- Create: `extensions/transcripts/src/model/blocks.ts`
- Create: `extensions/transcripts/src/model/blocks.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export type Block =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | { readonly type: 'tool-call'; readonly id: string | null; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool-result'; readonly toolUseId: string | null; readonly output: string; readonly isError: boolean }
  | { readonly type: 'image'; readonly path: string | null; readonly url: string | null };

export function toolResultOutput(value: unknown): string;
export function contentBlocks(content: unknown): readonly Block[];
```

- [ ] **Step 1: Write the failing test**

`src/model/blocks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { contentBlocks, toolResultOutput } from './blocks.ts';

describe('toolResultOutput', () => {
  it('takes a plain string', () => {
    expect(toolResultOutput('ok')).toBe('ok');
  });

  it('joins an array of blocks', () => {
    expect(toolResultOutput([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
  });

  it('reads an object with text or content', () => {
    expect(toolResultOutput({ text: 'a' })).toBe('a');
    expect(toolResultOutput({ content: 'b' })).toBe('b');
  });

  it('answers empty for nothing, not "undefined"', () => {
    expect(toolResultOutput(undefined)).toBe('');
    expect(toolResultOutput(null)).toBe('');
  });
});

describe('contentBlocks', () => {
  it('wraps a bare string', () => {
    expect(contentBlocks('hi')).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('decodes each known block kind', () => {
    const blocks = contentBlocks([
      { type: 'text', text: 'a' },
      { type: 'thinking', thinking: 'hmm' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', tool_use_id: 't1', content: 'out', is_error: true },
      { type: 'image', source: { url: 'https://x/y.png' } },
    ]);
    expect(blocks).toEqual([
      { type: 'text', text: 'a' },
      { type: 'thinking', text: 'hmm' },
      { type: 'tool-call', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool-result', toolUseId: 't1', output: 'out', isError: true },
      { type: 'image', path: null, url: 'https://x/y.png' },
    ]);
  });

  it('skips an unknown block rather than failing the record', () => {
    expect(contentBlocks([{ type: 'wat' }, { type: 'text', text: 'a' }])).toEqual([
      { type: 'text', text: 'a' },
    ]);
  });

  it('drops empty text but keeps an empty tool result', () => {
    expect(contentBlocks([{ type: 'text', text: '  ' }])).toEqual([]);
    expect(contentBlocks([{ type: 'tool_result', tool_use_id: 't1', content: '' }])).toEqual([
      { type: 'tool-result', toolUseId: 't1', output: '', isError: false },
    ]);
  });

  it('answers empty for a non-array, non-string', () => {
    expect(contentBlocks(null)).toEqual([]);
    expect(contentBlocks(7)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test blocks
```
Expected: FAIL — cannot resolve `./blocks.ts`.

- [ ] **Step 3: Implement**

`src/model/blocks.ts`:

```ts
import { asRecord, stringOrNull } from './record.ts';

/**
 * One content array → typed blocks.
 *
 * An empty text block is dropped and an empty TOOL RESULT is kept: a tool that
 * returned nothing said something, and a consumer rendering the call needs the
 * result to exist beside it.
 */

export type Block =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly id: string | null;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool-result';
      readonly toolUseId: string | null;
      readonly output: string;
      readonly isError: boolean;
    }
  | { readonly type: 'image'; readonly path: string | null; readonly url: string | null };

/**
 * A tool result's payload, flattened.
 *
 * It is a string, an array of blocks, or an object — which of the three depends
 * on the tool, and all three occur. The fallback stringifies rather than
 * dropping, because an unrenderable result is still evidence the tool ran.
 */
export function toolResultOutput(value: unknown): string {
  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      const rec = asRecord(item);
      const text = stringOrNull(rec?.text) ?? stringOrNull(rec?.content);
      if (text !== null) parts.push(text);
    }
    return parts.join('\n');
  }

  const rec = asRecord(value);
  if (rec !== null) {
    const text = stringOrNull(rec.text) ?? stringOrNull(rec.content);
    if (text !== null) return text;
  }
  return value === undefined || value === null ? '' : JSON.stringify(value);
}

function oneBlock(rec: Record<string, unknown>): Block | null {
  switch (rec.type) {
    case 'text': {
      const text = stringOrNull(rec.text);
      return text !== null && text.trim() !== '' ? { type: 'text', text } : null;
    }
    case 'thinking':
    case 'redacted_thinking': {
      const text = stringOrNull(rec.thinking) ?? stringOrNull(rec.text);
      return text !== null && text.trim() !== '' ? { type: 'thinking', text } : null;
    }
    case 'tool_use':
      return {
        type: 'tool-call',
        id: stringOrNull(rec.id),
        name: stringOrNull(rec.name) ?? 'tool',
        input: rec.input,
      };
    case 'tool_result':
      return {
        type: 'tool-result',
        toolUseId: stringOrNull(rec.tool_use_id),
        output: toolResultOutput(rec.content),
        isError: rec.is_error === true,
      };
    case 'image': {
      const source = asRecord(rec.source);
      const url = stringOrNull(source?.url) ?? stringOrNull(rec.url);
      const path = stringOrNull(rec.path);
      return url === null && path === null ? null : { type: 'image', path, url };
    }
    default:
      return null;
  }
}

export function contentBlocks(content: unknown): readonly Block[] {
  if (typeof content === 'string') {
    return content.trim() === '' ? [] : [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) return [];

  const blocks: Block[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      if (item.trim() !== '') blocks.push({ type: 'text', text: item });
      continue;
    }
    const rec = asRecord(item);
    if (rec === null) continue;
    const block = oneBlock(rec);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}
```

- [ ] **Step 4: Add the accessors `blocks.ts` imports**

Append to `src/model/record.ts`:

```ts
/** An object, or null for anything else — the guard every accessor here starts with. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** A string field, or null. Empty counts as present — only absence is null. */
export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
```

- [ ] **Step 5: Run the tests**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test blocks
```
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "A tool result arrives in three shapes; flatten all of them"
```

---

### Task 5: `model/message.ts` — one record, one message

**Files:**
- Create: `extensions/transcripts/src/model/message.ts`
- Create: `extensions/transcripts/src/model/message.test.ts`

**Interfaces:**
- Consumes: `Block`, `contentBlocks` (Task 4); `isHarnessInjectedText` (Task 3); `asRecord`, `stringOrNull`, `parseIsoTs` (`record.ts`).
- Produces:

```ts
export type Role = 'user' | 'assistant' | 'tool' | 'system';
export interface Usage {
  readonly input: number; readonly output: number;
  readonly cacheRead: number; readonly cacheWrite: number;
}
export interface TranscriptMessage {
  readonly seq: number;
  readonly uuid: string;
  readonly parentUuid: string | null;
  readonly role: Role;
  readonly blocks: readonly Block[];
  readonly ts: number | null;
  readonly model: string | null;
  readonly messageId: string | null;
  readonly requestId: string | null;
  readonly usage: Usage | null;
  readonly isMeta: boolean;
  readonly isCompactSummary: boolean;
  readonly isSidechain: boolean;
  readonly isHarnessNoise: boolean;
}
export function usageOf(message: unknown): Usage | null;
export function toMessage(rec: unknown, seq: number): TranscriptMessage | null;
```

- [ ] **Step 1: Write the failing test**

`src/model/message.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toMessage, usageOf } from './message.ts';

const userRec = {
  type: 'user',
  uuid: 'u1',
  parentUuid: null,
  timestamp: '2026-08-01T10:00:00.000Z',
  message: { role: 'user', content: 'fix the width' },
};

describe('toMessage', () => {
  it('reads a user turn', () => {
    const m = toMessage(userRec, 0);
    expect(m?.role).toBe('user');
    expect(m?.uuid).toBe('u1');
    expect(m?.blocks).toEqual([{ type: 'text', text: 'fix the width' }]);
    expect(m?.isHarnessNoise).toBe(false);
  });

  it('calls a user record of only tool results a tool turn', () => {
    const m = toMessage(
      { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] } },
      1,
    );
    expect(m?.role).toBe('tool');
  });

  it('keeps only the tool results of an injected meta turn', () => {
    const m = toMessage(
      {
        type: 'user',
        uuid: 'u3',
        isMeta: true,
        message: { role: 'user', content: [{ type: 'text', text: 'machinery' }, { type: 'tool_result', tool_use_id: 't1', content: 'real' }] },
      },
      2,
    );
    expect(m?.blocks).toEqual([{ type: 'tool-result', toolUseId: 't1', output: 'real', isError: false }]);
  });

  it('marks harness noise without dropping it', () => {
    const m = toMessage(
      { type: 'user', uuid: 'u4', message: { role: 'user', content: '<system-reminder>x</system-reminder>' } },
      3,
    );
    expect(m?.isHarnessNoise).toBe(true);
    expect(m?.role).toBe('user');
  });

  it('does not mark an ordinary markup paste as noise', () => {
    const m = toMessage(
      { type: 'user', uuid: 'u5', message: { role: 'user', content: '<details><summary>cfg</summary></details>' } },
      4,
    );
    expect(m?.isHarnessNoise).toBe(false);
  });

  it('reads an assistant turn with its model and usage', () => {
    const m = toMessage(
      {
        type: 'assistant',
        uuid: 'a1',
        requestId: 'r1',
        message: {
          id: 'm1',
          model: 'claude-opus-5',
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
          content: [{ type: 'text', text: 'done' }],
        },
      },
      5,
    );
    expect(m?.role).toBe('assistant');
    expect(m?.model).toBe('claude-opus-5');
    expect(m?.messageId).toBe('m1');
    expect(m?.requestId).toBe('r1');
    expect(m?.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 });
  });

  it('falls back to the sequence when a record has no uuid', () => {
    expect(toMessage({ type: 'user', message: { role: 'user', content: 'x' } }, 9)?.uuid).toBe('#9');
  });

  it('refuses a record that is not a turn', () => {
    expect(toMessage({ type: 'ai-title', aiTitle: 'x' }, 0)).toBeNull();
    expect(toMessage(null, 0)).toBeNull();
    expect(toMessage({ type: 'user', uuid: 'u', message: { role: 'user', content: [] } }, 0)).toBeNull();
  });
});

describe('usageOf', () => {
  it('answers null when every field is absent', () => {
    expect(usageOf({ usage: {} })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test message
```
Expected: FAIL — cannot resolve `./message.ts`.

- [ ] **Step 3: Implement**

`src/model/message.ts`:

```ts
import { contentBlocks, type Block } from './blocks.ts';
import { isHarnessInjectedText } from './noise.ts';
import { asRecord, parseIsoTs, stringOrNull } from './record.ts';

export type Role = 'user' | 'assistant' | 'tool' | 'system';

export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface TranscriptMessage {
  /** Position of the record in the file. Stable ordering, and the fallback id. */
  readonly seq: number;
  readonly uuid: string;
  readonly parentUuid: string | null;
  readonly role: Role;
  readonly blocks: readonly Block[];
  readonly ts: number | null;
  readonly model: string | null;
  readonly messageId: string | null;
  readonly requestId: string | null;
  readonly usage: Usage | null;
  readonly isMeta: boolean;
  readonly isCompactSummary: boolean;
  readonly isSidechain: boolean;
  /**
   * Harness machinery wearing a user turn. Marked rather than dropped: a
   * consumer counting turns and a consumer rendering them disagree about it,
   * and the parser has no business picking a side.
   */
  readonly isHarnessNoise: boolean;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function usageOf(message: unknown): Usage | null {
  const usage = asRecord(asRecord(message)?.usage);
  if (usage === null) return null;

  const out: Usage = {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
  };
  return out.input + out.output + out.cacheRead + out.cacheWrite === 0 ? null : out;
}

function textOf(blocks: readonly Block[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

export function toMessage(rec: unknown, seq: number): TranscriptMessage | null {
  const record = asRecord(rec);
  if (record === null) return null;
  if (record.type !== 'user' && record.type !== 'assistant') return null;

  const message = asRecord(record.message);
  const isMeta = record.isMeta === true || record.isSynthetic === true;
  const isCompactSummary = record.isCompactSummary === true;

  const decoded = contentBlocks(message?.content);
  // An injected turn's prose is machinery, but a tool result inside one is real
  // output and stays visible.
  const blocks =
    record.type === 'user' && (isMeta || isCompactSummary)
      ? decoded.filter((block) => block.type === 'tool-result')
      : decoded;
  if (blocks.length === 0) return null;

  const onlyToolResults = blocks.every((block) => block.type === 'tool-result');
  const role: Role =
    record.type === 'assistant' ? 'assistant' : onlyToolResults ? 'tool' : 'user';

  return {
    seq,
    uuid: stringOrNull(record.uuid) ?? `#${seq}`,
    parentUuid: stringOrNull(record.parentUuid),
    role,
    blocks,
    ts: parseIsoTs(record.timestamp),
    model: stringOrNull(message?.model),
    messageId: stringOrNull(message?.id),
    requestId: stringOrNull(record.requestId),
    usage: usageOf(message),
    isMeta,
    isCompactSummary,
    isSidechain: record.isSidechain === true,
    isHarnessNoise: role === 'user' && isHarnessInjectedText(textOf(blocks)),
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test message
```
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "A record becomes a message, and machinery is marked rather than erased"
```

---

### Task 6: `model/lifecycle.ts` — the turn's own account of itself

**Files:**
- Create: `extensions/transcripts/src/model/lifecycle.ts`
- Create: `extensions/transcripts/src/model/lifecycle.test.ts`

**Interfaces:**
- Consumes: `asRecord`, `stringOrNull`, `parseIsoTs` (`record.ts`); `toMessage` (Task 5).
- Produces:

```ts
export type LifecycleState = 'working' | 'completed' | 'interrupted';
export interface Lifecycle {
  readonly state: LifecycleState;
  readonly turnId: string;
  readonly ts: number | null;
}
export function lifecycleOf(rec: unknown, seq: number): Lifecycle | null;
```

- [ ] **Step 1: Write the failing test**

`src/model/lifecycle.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { lifecycleOf } from './lifecycle.ts';

const assistant = (message: Record<string, unknown>): unknown => ({
  type: 'assistant',
  uuid: 'a1',
  timestamp: '2026-08-01T10:00:00.000Z',
  message,
});

describe('lifecycleOf', () => {
  it('completes on a terminal stop reason', () => {
    for (const reason of ['end_turn', 'max_tokens', 'stop_sequence', 'refusal']) {
      expect(lifecycleOf(assistant({ stop_reason: reason, content: [{ type: 'text', text: 'x' }] }), 0)?.state).toBe('completed');
    }
  });

  it('does not complete on tool_use', () => {
    expect(lifecycleOf(assistant({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'B', input: {} }] }), 0)).toBeNull();
  });

  it('completes a row with content and no stop reason', () => {
    expect(lifecycleOf(assistant({ content: [{ type: 'text', text: 'x' }] }), 0)?.state).toBe('completed');
  });

  it('does NOT complete a no-stop-reason row that calls a tool', () => {
    expect(
      lifecycleOf(assistant({ content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 't', name: 'B', input: {} }] }), 0),
    ).toBeNull();
  });

  it('starts working on a real user turn', () => {
    const l = lifecycleOf({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } }, 0);
    expect(l?.state).toBe('working');
    expect(l?.turnId).toBe('u1');
  });

  it('ignores a tool-result user row', () => {
    expect(
      lifecycleOf({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'o' }] } }, 0),
    ).toBeNull();
  });

  it('ignores harness noise, which would re-stick the spinner', () => {
    expect(
      lifecycleOf({ type: 'user', uuid: 'u3', message: { role: 'user', content: '<system-reminder>x</system-reminder>' } }, 0),
    ).toBeNull();
  });

  it('reads an interrupt', () => {
    const l = lifecycleOf({ type: 'user', uuid: 'u4', message: { role: 'user', content: '[Request interrupted by user]' } }, 0);
    expect(l?.state).toBe('interrupted');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test lifecycle
```
Expected: FAIL — cannot resolve `./lifecycle.ts`.

- [ ] **Step 3: Implement**

`src/model/lifecycle.ts`:

```ts
import { toMessage } from './message.ts';
import { asRecord, parseIsoTs, stringOrNull } from './record.ts';

/**
 * The transcript's own account of whether a turn is running.
 *
 * A second opinion on agent state, independent of hooks — which matters because
 * the daemon's sweep detects "claude exited", not "the turn ended". This file
 * produces the signal and takes no position on whether it outranks a hook.
 */

export type LifecycleState = 'working' | 'completed' | 'interrupted';

export interface Lifecycle {
  readonly state: LifecycleState;
  readonly turnId: string;
  readonly ts: number | null;
}

const TERMINAL = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'refusal']);

const INTERRUPT_PREFIX = '[request interrupted';

function hasToolUse(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => asRecord(block)?.type === 'tool_use');
}

function hasRenderable(content: unknown): boolean {
  if (typeof content === 'string') return content.trim() !== '';
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const rec = asRecord(block);
    if (rec === null) return false;
    if (rec.type === 'thinking' || rec.type === 'redacted_thinking') return true;
    return rec.type === 'text' && typeof rec.text === 'string' && rec.text.trim() !== '';
  });
}

export function lifecycleOf(rec: unknown, seq: number): Lifecycle | null {
  const record = asRecord(rec);
  if (record === null) return null;

  const ts = parseIsoTs(record.timestamp);
  const message = asRecord(record.message);

  if (record.type === 'assistant') {
    const stop = message?.stop_reason;
    /**
     * The backup clause is the load-bearing one. A row with no `stop_reason`
     * that also carries a `tool_use` is mid-turn — reading it as done settles
     * the spinner before the tool has run.
     */
    const terminal =
      (typeof stop === 'string' && TERMINAL.has(stop)) ||
      (stop === undefined && hasRenderable(message?.content) && !hasToolUse(message?.content)) ||
      (stop === null && hasRenderable(message?.content) && !hasToolUse(message?.content));
    if (!terminal) return null;
    return {
      state: 'completed',
      turnId: stringOrNull(record.uuid) ?? stringOrNull(message?.id) ?? `#${seq}`,
      ts,
    };
  }

  if (record.type !== 'user') return null;

  const decoded = toMessage(rec, seq);
  if (decoded === null || decoded.role !== 'user') return null;

  const text = decoded.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trimStart()
    .toLowerCase();

  if (text.startsWith(INTERRUPT_PREFIX)) {
    return { state: 'interrupted', turnId: decoded.uuid, ts };
  }
  // Harness noise fires a user turn without being one; treating it as working
  // overwrites a real terminal marker and re-sticks the spinner.
  if (decoded.isHarnessNoise) return null;

  return { state: 'working', turnId: decoded.uuid, ts };
}
```

- [ ] **Step 4: Run the tests**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test lifecycle
```
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "A row that still has a tool to run has not finished its turn"
```

---

### Task 7: `model/usage.ts` — tokens, counted once

**Files:**
- Create: `extensions/transcripts/src/model/usage.ts`
- Create: `extensions/transcripts/src/model/usage.test.ts`

**Interfaces:**
- Consumes: `TranscriptMessage`, `Usage` (Task 5).
- Produces:

```ts
export interface UsageRollup {
  readonly byModel: Readonly<Record<string, Usage>>;
  readonly total: Usage;
}
export const ZERO_USAGE: Usage;
export function dedupeKeyOf(message: TranscriptMessage): string | null;
export function addUsage(a: Usage, b: Usage): Usage;
export function maxUsage(a: Usage, b: Usage): Usage;
export function emptyRollup(): UsageRollup;
export function withUsage(rollup: UsageRollup, model: string | null, usage: Usage): UsageRollup;
```

- [ ] **Step 1: Write the failing test**

`src/model/usage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addUsage, dedupeKeyOf, emptyRollup, maxUsage, withUsage, ZERO_USAGE } from './usage.ts';
import type { TranscriptMessage } from './message.ts';

const msg = (over: Partial<TranscriptMessage>): TranscriptMessage =>
  ({
    seq: 0, uuid: 'u', parentUuid: null, role: 'assistant', blocks: [], ts: null,
    model: null, messageId: null, requestId: null, usage: null,
    isMeta: false, isCompactSummary: false, isSidechain: false, isHarnessNoise: false,
    ...over,
  }) as TranscriptMessage;

describe('dedupeKeyOf', () => {
  it('prefers message id and request id together', () => {
    expect(dedupeKeyOf(msg({ messageId: 'm1', requestId: 'r1' }))).toBe('m1:r1');
  });

  it('falls back to the message id, then the uuid', () => {
    expect(dedupeKeyOf(msg({ messageId: 'm1' }))).toBe('msg:m1');
    expect(dedupeKeyOf(msg({ uuid: 'u1' }))).toBe('uuid:u1');
  });
});

describe('maxUsage', () => {
  it('takes the larger of each field, because a later row can be fuller', () => {
    expect(
      maxUsage({ input: 10, output: 15, cacheRead: 0, cacheWrite: 3 }, { input: 10, output: 40, cacheRead: 5, cacheWrite: 0 }),
    ).toEqual({ input: 10, output: 40, cacheRead: 5, cacheWrite: 3 });
  });
});

describe('addUsage', () => {
  it('sums each field', () => {
    expect(addUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }))
      .toEqual({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44 });
  });
});

describe('withUsage', () => {
  it('accumulates per model and in total', () => {
    let r = emptyRollup();
    r = withUsage(r, 'opus', { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
    r = withUsage(r, 'opus', { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 });
    r = withUsage(r, 'haiku', { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 });
    expect(r.byModel.opus).toEqual({ input: 2, output: 5, cacheRead: 0, cacheWrite: 0 });
    expect(r.byModel.haiku).toEqual({ input: 5, output: 5, cacheRead: 0, cacheWrite: 0 });
    expect(r.total).toEqual({ input: 7, output: 10, cacheRead: 0, cacheWrite: 0 });
  });

  it('files a model-less row under "unknown"', () => {
    expect(withUsage(emptyRollup(), null, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }).byModel.unknown.input).toBe(1);
  });

  it('starts empty', () => {
    expect(emptyRollup().total).toEqual(ZERO_USAGE);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test usage
```
Expected: FAIL — cannot resolve `./usage.ts`.

- [ ] **Step 3: Implement**

`src/model/usage.ts`:

```ts
import type { TranscriptMessage, Usage } from './message.ts';

/**
 * Tokens, counted once.
 *
 * **Claude re-streams an assistant row under the same `message.id`.** Measured
 * on one real session: 434 assistant records, 203 distinct message ids, and
 * summing every row gives 732,808 output tokens where the deduped total is
 * 273,005 — over-counting by 2.7x. Any number derived without this is fiction.
 *
 * The later row wins per field rather than wholesale, because a duplicate can
 * carry a fuller `usage` than the one before it and a missing field reads as 0.
 */

export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface UsageRollup {
  readonly byModel: Readonly<Record<string, Usage>>;
  readonly total: Usage;
}

/** The strongest stable identity the row carries. A fork rewrites `sessionId` but keeps these. */
export function dedupeKeyOf(message: TranscriptMessage): string | null {
  if (message.messageId !== null && message.requestId !== null) {
    return `${message.messageId}:${message.requestId}`;
  }
  if (message.messageId !== null) return `msg:${message.messageId}`;
  return `uuid:${message.uuid}`;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

export function maxUsage(a: Usage, b: Usage): Usage {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
  };
}

export function emptyRollup(): UsageRollup {
  return { byModel: {}, total: ZERO_USAGE };
}

export function withUsage(rollup: UsageRollup, model: string | null, usage: Usage): UsageRollup {
  const key = model ?? 'unknown';
  return {
    byModel: { ...rollup.byModel, [key]: addUsage(rollup.byModel[key] ?? ZERO_USAGE, usage) },
    total: addUsage(rollup.total, usage),
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test usage
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Claude re-streams a row; count its tokens once"
```

---

### Task 8: `parse/session.ts` — the one fold

**Files:**
- Create: `extensions/transcripts/src/parse/session.ts`
- Create: `extensions/transcripts/src/parse/session.test.ts`

**Interfaces:**
- Consumes: `toMessage`, `TranscriptMessage`, `Usage` (Task 5); `lifecycleOf`, `Lifecycle` (Task 6); `dedupeKeyOf`, `emptyRollup`, `maxUsage`, `withUsage`, `UsageRollup` (Task 7); `awaySummaryText`, `recordType`, `parseIsoTs`, `stringOrNull`, `asRecord` (`record.ts`).
- Produces:

```ts
export interface Recap { readonly seq: number; readonly ts: number | null; readonly text: string }
export interface UnknownRecord { readonly seq: number; readonly type: string }
export interface ParsedSession {
  readonly sessionId: string;
  readonly filePath: string;
  readonly cwd: string | null;
  readonly gitBranch: string | null;
  readonly version: string | null;
  readonly aiTitle: string | null;
  readonly customTitle: string | null;
  readonly agentName: string | null;
  readonly messages: readonly TranscriptMessage[];
  readonly recaps: readonly Recap[];
  readonly unknown: readonly UnknownRecord[];
  readonly lifecycle: Lifecycle | null;
  readonly usage: UsageRollup;
  readonly firstTs: number | null;
  readonly lastTs: number | null;
  readonly records: number;
  readonly pendingKey: string | null;
  readonly pendingUsage: Usage | null;
  readonly pendingModel: string | null;
}
export function emptySession(sessionId: string, filePath: string): ParsedSession;
export function absorb(base: ParsedSession, chunk: string): ParsedSession;
export function completeBytes(chunk: string): number;
```

`pendingKey` / `pendingUsage` / `pendingModel` hold the *current* dedupe group. Measured across twelve large sessions: duplicate `message.id` rows are **always consecutive** (zero non-adjacent repeats), so one slot is enough and the cache never grows a per-key map.

- [ ] **Step 1: Write the failing test**

`src/parse/session.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { absorb, completeBytes, emptySession } from './session.ts';
import { readFixture } from '../fixtures.ts';

const fold = (name: string) => absorb(emptySession(name, `/x/${name}.jsonl`), readFixture(name));

describe('absorb', () => {
  it('reads a tool loop into messages, blocks and usage', () => {
    const s = fold('tool-loop');
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(s.cwd).toBe('/repo');
    expect(s.gitBranch).toBe('main');
    expect(s.usage.total).toEqual({ input: 30, output: 13, cacheRead: 100, cacheWrite: 0 });
    expect(s.lifecycle?.state).toBe('completed');
  });

  it('counts a re-streamed row once, taking the fuller usage', () => {
    expect(fold('duplicate-usage').usage.total.output).toBe(40);
  });

  it('keeps a markup paste and marks only the real machinery', () => {
    const s = fold('markup-prompt');
    const users = s.messages.filter((m) => m.role === 'user');
    expect(users).toHaveLength(2);
    expect(users[0].isHarnessNoise).toBe(false);
    expect(users[1].isHarnessNoise).toBe(true);
  });

  it('ends interrupted when the turn was interrupted', () => {
    expect(fold('interrupt').lifecycle?.state).toBe('interrupted');
  });

  it('reads titles and a recap without their UI trailer', () => {
    const s = fold('titles-and-recap');
    expect(s.aiTitle).toBe('Fixing the port conflict');
    expect(s.customTitle).toBe('port bug');
    expect(s.agentName).toBe('Explore');
    expect(s.recaps[0].text).toBe('You asked about a port conflict.');
  });

  it('records an unrecognised type rather than dropping it', () => {
    const s = absorb(emptySession('s', '/x'), '{"type":"pr-link","url":"https://x"}\n');
    expect(s.unknown).toEqual([{ seq: 0, type: 'pr-link' }]);
  });

  it('survives a malformed line', () => {
    const s = absorb(emptySession('s', '/x'), 'not json\n{"type":"user","uuid":"u","message":{"role":"user","content":"hi"}}\n');
    expect(s.messages).toHaveLength(1);
  });

  it('is a fold: two halves equal one whole', () => {
    const text = readFixture('tool-loop');
    const cut = text.indexOf('\n', text.indexOf('\n') + 1) + 1;
    const split = absorb(absorb(emptySession('t', '/x'), text.slice(0, cut)), text.slice(cut));
    expect(split).toEqual(absorb(emptySession('t', '/x'), text));
  });

  it('drops a trailing partial line, and picks it up next time', () => {
    const text = readFixture('tool-loop');
    const mid = text.indexOf('\n') + 10;
    const partial = absorb(emptySession('t', '/x'), text.slice(0, mid));
    expect(partial.messages).toHaveLength(1);
    const rest = absorb(partial, text.slice(completeBytes(text.slice(0, mid))));
    expect(rest.messages).toHaveLength(4);
  });
});

describe('completeBytes', () => {
  it('stops at the last newline', () => {
    expect(completeBytes('a\nb\nc')).toBe(4);
    expect(completeBytes('no newline')).toBe(0);
  });

  it('counts BYTES, not characters', () => {
    expect(completeBytes('é\n')).toBe(3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test parse/session
```
Expected: FAIL — cannot resolve `./session.ts`.

- [ ] **Step 3: Implement**

`src/parse/session.ts`:

```ts
import { lifecycleOf, type Lifecycle } from '../model/lifecycle.ts';
import { toMessage, type TranscriptMessage, type Usage } from '../model/message.ts';
import { asRecord, awaySummaryText, parseIsoTs, recordType, stringOrNull } from '../model/record.ts';
import {
  dedupeKeyOf,
  emptyRollup,
  maxUsage,
  withUsage,
  type UsageRollup,
} from '../model/usage.ts';

/**
 * The one fold. A cold parse is a fold over an empty session.
 *
 * There is deliberately no `parseWholeFile` beside this: the way to guarantee
 * the incremental path agrees with the cold path is to have only one path. A
 * trailing partial line is DROPPED, not parsed — the caller may hand us bytes an
 * agent is writing right now, and `completeBytes` is the other half of that
 * contract.
 */

export interface Recap {
  readonly seq: number;
  readonly ts: number | null;
  readonly text: string;
}

export interface UnknownRecord {
  readonly seq: number;
  readonly type: string;
}

export interface ParsedSession {
  readonly sessionId: string;
  readonly filePath: string;
  readonly cwd: string | null;
  readonly gitBranch: string | null;
  readonly version: string | null;
  readonly aiTitle: string | null;
  readonly customTitle: string | null;
  readonly agentName: string | null;
  readonly messages: readonly TranscriptMessage[];
  readonly recaps: readonly Recap[];
  readonly unknown: readonly UnknownRecord[];
  readonly lifecycle: Lifecycle | null;
  readonly usage: UsageRollup;
  readonly firstTs: number | null;
  readonly lastTs: number | null;
  readonly records: number;
  /**
   * The dedupe group still open.
   *
   * One slot, not a map: measured across twelve large sessions, duplicate
   * `message.id` rows are always CONSECUTIVE — zero non-adjacent repeats. So a
   * group closes the moment a different key arrives, and the cache never carries
   * a per-key table.
   */
  readonly pendingKey: string | null;
  readonly pendingUsage: Usage | null;
  readonly pendingModel: string | null;
}

const KNOWN_SIDE_TYPES = new Set(['user', 'assistant', 'system', 'ai-title', 'custom-title', 'agent-name']);

export function emptySession(sessionId: string, filePath: string): ParsedSession {
  return {
    sessionId,
    filePath,
    cwd: null,
    gitBranch: null,
    version: null,
    aiTitle: null,
    customTitle: null,
    agentName: null,
    messages: [],
    recaps: [],
    unknown: [],
    lifecycle: null,
    usage: emptyRollup(),
    firstTs: null,
    lastTs: null,
    records: 0,
    pendingKey: null,
    pendingUsage: null,
    pendingModel: null,
  };
}

/**
 * How many bytes of `chunk` end in a complete line.
 *
 * `absorb` drops the tail after the last newline, so a caller's offset must stop
 * there too — otherwise those bytes are skipped forever rather than re-read once
 * the rest of the record lands.
 */
export function completeBytes(chunk: string): number {
  const lastBreak = chunk.lastIndexOf('\n');
  return lastBreak === -1 ? 0 : Buffer.byteLength(chunk.slice(0, lastBreak + 1));
}

export function absorb(base: ParsedSession, chunk: string): ParsedSession {
  let { cwd, gitBranch, version, aiTitle, customTitle, agentName } = base;
  let { lifecycle, usage, firstTs, lastTs, records } = base;
  let { pendingKey, pendingUsage, pendingModel } = base;
  const messages: TranscriptMessage[] = [...base.messages];
  const recaps: Recap[] = [...base.recaps];
  const unknown: UnknownRecord[] = [...base.unknown];

  /** Close the open dedupe group, folding its final (maximal) usage into the rollup. */
  const settle = (): void => {
    if (pendingKey === null || pendingUsage === null) return;
    usage = withUsage(usage, pendingModel, pendingUsage);
    pendingKey = null;
    pendingUsage = null;
    pendingModel = null;
  };

  const lines = chunk.split('\n');
  // The tail after the final newline is incomplete by definition. A chunk ending
  // ON a newline leaves an empty final element, which this also drops.
  lines.pop();

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;

    const seq = records;
    records += 1;

    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    const type = recordType(rec);
    const record = asRecord(rec);

    if (type === 'ai-title') {
      aiTitle = stringOrNull(record?.aiTitle) ?? aiTitle;
      continue;
    }
    if (type === 'custom-title') {
      customTitle = stringOrNull(record?.customTitle) ?? customTitle;
      continue;
    }
    if (type === 'agent-name') {
      agentName = stringOrNull(record?.agentName) ?? agentName;
      continue;
    }

    const ts = parseIsoTs(record?.timestamp);
    if (ts !== null) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }

    cwd ??= stringOrNull(record?.cwd);
    gitBranch ??= stringOrNull(record?.gitBranch);
    version ??= stringOrNull(record?.version);

    const summary = awaySummaryText(rec);
    if (summary !== null) {
      recaps.push({ seq, ts, text: summary });
      continue;
    }

    if (type !== null && !KNOWN_SIDE_TYPES.has(type)) {
      unknown.push({ seq, type });
      continue;
    }

    const next = lifecycleOf(rec, seq);
    if (next !== null) lifecycle = next;

    const message = toMessage(rec, seq);
    if (message === null) continue;
    messages.push(message);

    if (message.usage === null) continue;
    const key = dedupeKeyOf(message);
    if (key !== pendingKey) settle();
    pendingKey = key;
    pendingModel = message.model;
    pendingUsage = pendingUsage === null ? message.usage : maxUsage(pendingUsage, message.usage);
  }

  // A chunk boundary must not leave tokens uncounted: the group is settled into
  // the rollup now, and re-settled identically if the next chunk continues it.
  const openKey = pendingKey;
  const openUsage = pendingUsage;
  const openModel = pendingModel;
  settle();

  return {
    sessionId: base.sessionId,
    filePath: base.filePath,
    cwd,
    gitBranch,
    version,
    aiTitle,
    customTitle,
    agentName,
    messages,
    recaps,
    unknown,
    lifecycle,
    usage,
    firstTs,
    lastTs,
    records,
    pendingKey: openKey,
    pendingUsage: openUsage,
    pendingModel: openModel,
  };
}
```

> **Note for the implementer:** settling at the end of a chunk and *also* keeping the open group means a continuing group would be counted twice. Fix this by having `settle()` subtract nothing and instead making the next chunk's first `maxUsage` fold start from `ZERO_USAGE` when `pendingKey` matches — i.e. on entry, if `base.pendingKey !== null`, subtract `base.pendingUsage` from `usage` before folding. Add that as the first statement of `absorb`:
>
> ```ts
> // The previous chunk settled its open group so a reader between chunks sees a
> // true total. If this chunk continues that group, back it out and re-fold.
> if (base.pendingKey !== null && base.pendingUsage !== null) {
>   usage = subtractUsage(usage, base.pendingModel, base.pendingUsage);
> }
> ```
>
> and add `subtractUsage` to `model/usage.ts` as the inverse of `withUsage`. The "two halves equal one whole" test in Step 1 is what proves this correct — do not skip it.

- [ ] **Step 4: Add `subtractUsage` to `model/usage.ts`**

```ts
export function subtractUsage(rollup: UsageRollup, model: string | null, usage: Usage): UsageRollup {
  const key = model ?? 'unknown';
  const current = rollup.byModel[key] ?? ZERO_USAGE;
  const less = (a: Usage, b: Usage): Usage => ({
    input: a.input - b.input,
    output: a.output - b.output,
    cacheRead: a.cacheRead - b.cacheRead,
    cacheWrite: a.cacheWrite - b.cacheWrite,
  });
  return { byModel: { ...rollup.byModel, [key]: less(current, usage) }, total: less(rollup.total, usage) };
}
```

- [ ] **Step 5: Run the tests**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test parse/session
```
Expected: PASS, 12 tests. The "two halves equal one whole" test is the one that matters.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "One fold, and a cold parse is a fold over nothing"
```

---

### Task 9: `parse/digest.ts` — search becomes a projection

**Files:**
- Create: `extensions/transcripts/src/parse/digest.ts`
- Create: `extensions/transcripts/src/parse/digest.test.ts`
- Modify: `extensions/transcripts/src/model/session.ts` (delete `absorbLines`/`emptyDigest`; keep `SessionDigest`, `Turn`, `bestTitle`, `isEmptyDigest`)
- Modify: `extensions/transcripts/src/parse/golden.test.ts` (fold through the new path)

**Interfaces:**
- Consumes: `ParsedSession` (Task 8); `SessionDigest`, `Turn` (`model/session.ts`).
- Produces: `digestOf(session: ParsedSession): SessionDigest`. `SessionDigest` gains `readonly models: readonly string[]` and `readonly usage: UsageRollup`.

- [ ] **Step 1: Widen `SessionDigest` and drop the old fold**

In `src/model/session.ts`: delete `absorbLines` and `emptyDigest`; keep `Turn`, `bestTitle`, `isEmptyDigest`. Add to `SessionDigest`:

```ts
  /** Which models answered, newest-first order irrelevant — for a hit row's badge. */
  readonly models: readonly string[];
  /** Deduped totals. Small enough to cache, which is what makes `transcripts.usage` instant. */
  readonly usage: UsageRollup;
```

- [ ] **Step 2: Write the failing test**

`src/parse/digest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { absorb, emptySession } from './session.ts';
import { digestOf } from './digest.ts';
import { readFixture } from '../fixtures.ts';

const digest = (name: string) => digestOf(absorb(emptySession(name, `/x/${name}.jsonl`), readFixture(name)));

describe('digestOf', () => {
  it('keeps user and assistant prose, in file order', () => {
    const d = digest('tool-loop');
    expect(d.turns.map((t) => t.source)).toEqual(['user', 'assistant', 'assistant']);
    expect(d.userTurns).toBe(1);
    expect(d.assistantTurns).toBe(2);
  });

  it('carries no tool output — the cache stays small', () => {
    expect(JSON.stringify(digest('tool-loop'))).not.toContain('a.ts');
  });

  it('drops harness noise but keeps a markup paste', () => {
    const d = digest('markup-prompt');
    expect(d.userTurns).toBe(1);
    expect(d.turns[0].text).toContain('the failing config');
  });

  it('interleaves a recap in file order', () => {
    const d = digest('titles-and-recap');
    expect(d.turns.map((t) => t.source)).toEqual(['user', 'recap']);
    expect(d.recap).toBe('You asked about a port conflict.');
  });

  it('carries the models and the deduped usage', () => {
    const d = digest('duplicate-usage');
    expect(d.models).toEqual(['claude-opus-5']);
    expect(d.usage.total.output).toBe(40);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test parse/digest
```
Expected: FAIL — cannot resolve `./digest.ts`.

- [ ] **Step 4: Implement**

`src/parse/digest.ts`:

```ts
import type { SessionDigest, Turn } from '../model/session.ts';
import type { ParsedSession } from './session.ts';

/**
 * The search projection.
 *
 * Deliberately the ONLY producer of a digest. Two readers over one file format
 * drift, and the drift is invisible: search would quietly stop agreeing with a
 * rendered transcript about what a session says.
 *
 * Tool calls and tool output are excluded. That is the 97% the index exists not
 * to hold — including them would put transcript bulk in `ctx.dataDir`, which
 * `tasks/store.ts` forbids and which the 14.8 MB measurement is the argument for.
 */
export function digestOf(session: ParsedSession): SessionDigest {
  const turns: Turn[] = [];

  for (const message of session.messages) {
    if (message.isHarnessNoise) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;

    const text = message.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n')
      .trim();
    if (text === '') continue;

    turns.push({ source: message.role, ts: message.ts, text, seq: message.seq });
  }

  for (const recap of session.recaps) {
    turns.push({ source: 'recap', ts: recap.ts, text: recap.text, seq: recap.seq });
  }

  // File order, because that is the order a person read them in.
  turns.sort((a, b) => a.seq - b.seq);

  const latest = session.recaps.at(-1) ?? null;

  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    gitBranch: session.gitBranch,
    aiTitle: session.aiTitle,
    customTitle: session.customTitle,
    agentName: session.agentName,
    recap: latest?.text ?? null,
    recapTs: latest?.ts ?? null,
    firstTs: session.firstTs,
    lastTs: session.lastTs,
    userTurns: turns.filter((t) => t.source === 'user').length,
    assistantTurns: turns.filter((t) => t.source === 'assistant').length,
    turns,
    models: Object.keys(session.usage.byModel).filter((m) => m !== 'unknown'),
    usage: session.usage,
  };
}
```

Add `readonly seq: number` to `Turn` in `model/session.ts` — the sort needs it, and it is the same number a consumer would use to jump to the turn.

- [ ] **Step 5: Repoint the golden test and review the diff**

Rewrite `src/parse/golden.test.ts` to fold through the new path:

```ts
import { describe, expect, it } from 'vitest';
import { FIXTURES, readFixture } from '../fixtures.ts';
import { absorb, emptySession } from './session.ts';
import { digestOf } from './digest.ts';

describe('digest golden', () => {
  for (const name of FIXTURES) {
    it(`${name} folds to a stable digest`, () => {
      expect(digestOf(absorb(emptySession(name, `/x/${name}.jsonl`), readFixture(name)))).toMatchSnapshot();
    });
  }
});
```

Run it and **read every snapshot difference**:

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test golden
```

Expected: FAIL, with differences. Exactly three kinds are intended:
1. `markup-prompt` gains a user turn — the `<details>` paste is no longer deleted. **This is the fix.**
2. Every digest gains `models`, `usage`, and a `seq` on each turn.
3. User turns whose `content` was an array of text blocks now appear (today's `userText` required a string).

Any *other* difference is a regression — stop and fix it rather than re-blessing.

- [ ] **Step 6: Re-bless and verify**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test -u && env -u NODE_OPTIONS pnpm test
```
Expected: PASS.

- [ ] **Step 7: Repoint `store.ts` and `index.ts`, and verify the whole workspace**

In `src/store.ts` replace `absorbLines(base, chunk)` with `digestOf(absorb(parsed, chunk))` — Task 11 restructures this properly; here it need only compile. In `src/index.ts` no change is needed.

```bash
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
```
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "Search reads the same parse everything else does"
```

---

### Task 10: `parse/subagents.ts` — the sibling files

**Files:**
- Create: `extensions/transcripts/src/parse/subagents.ts`
- Create: `extensions/transcripts/src/parse/subagents.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SUBAGENT_DIR: 'subagents'`, `SUBAGENT_PREFIX: 'agent-'`, `subagentDirFor(sessionPath: string): string`, `isSubagentFileName(name: string): boolean`.

- [ ] **Step 1: Write the failing test**

`src/parse/subagents.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isSubagentFileName, subagentDirFor } from './subagents.ts';

describe('subagentDirFor', () => {
  it('names the sibling directory Claude writes beside a session', () => {
    expect(subagentDirFor('/p/-Users-me-repo/204c2bc8.jsonl')).toBe('/p/-Users-me-repo/204c2bc8/subagents');
  });
});

describe('isSubagentFileName', () => {
  it('takes only agent-*.jsonl', () => {
    expect(isSubagentFileName('agent-a326799a725bb8d6b.jsonl')).toBe(true);
    expect(isSubagentFileName('agent-x.JSONL')).toBe(true);
  });

  it('rejects a meta sidecar and a stray transcript', () => {
    expect(isSubagentFileName('agent-x.meta.json')).toBe(false);
    expect(isSubagentFileName('something.jsonl')).toBe(false);
    expect(isSubagentFileName('agent-.jsonl')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test subagents
```
Expected: FAIL — cannot resolve `./subagents.ts`.

- [ ] **Step 3: Implement**

`src/parse/subagents.ts`:

```ts
/**
 * Where a session's subagent transcripts live.
 *
 * Claude writes them to a sibling directory named for the session file:
 * `<enc>/<uuid>.jsonl` → `<enc>/<uuid>/subagents/agent-<id>.jsonl`. Confirmed on
 * a real corpus: 29 such directories, 146 files.
 *
 * **Discovery is by PATH, never by a record flag.** `isSidechain` is true in 145
 * of those 146 files and in 0 of 720 parents — it labels a subagent transcript
 * from the inside, so it can confirm one but can never find one.
 *
 * The predicate is exact so a count and a listing cannot disagree: a stray
 * `.jsonl`, or a directory that happens to end in `.jsonl`, would otherwise
 * inflate a badge past what expanding it shows.
 */

export const SUBAGENT_DIR = 'subagents';
export const SUBAGENT_PREFIX = 'agent-';

export function subagentDirFor(sessionPath: string): string {
  const stem = sessionPath.replace(/\.jsonl$/i, '');
  return `${stem}/${SUBAGENT_DIR}`;
}

export function isSubagentFileName(name: string): boolean {
  if (!name.startsWith(SUBAGENT_PREFIX)) return false;
  if (!/\.jsonl$/i.test(name)) return false;
  return name.length > SUBAGENT_PREFIX.length + '.jsonl'.length;
}
```

- [ ] **Step 4: Run the tests**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test subagents
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "A subagent is found by its path; the flag only confirms it"
```

---

### Task 11: `store.ts` — generation counter, subagent walk, cache v2

**Files:**
- Modify: `extensions/transcripts/src/store.ts`
- Modify: `extensions/transcripts/src/store.test.ts`

**Interfaces:**
- Consumes: `absorb`, `emptySession`, `completeBytes`, `ParsedSession` (Task 8); `digestOf` (Task 9); `subagentDirFor`, `isSubagentFileName` (Task 10).
- Produces: `RecallIndex` gains `invalidate(): void` and `parse(path: string): ParsedSession | null`. `IndexedSession` gains `readonly subagents: readonly string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `src/store.test.ts`:

```ts
it('does not let an in-flight refresh undo an invalidation', async () => {
  const fs = fakeFs({ '/p/-repo/s1.jsonl': userLine('one') });
  const index = createIndex({ projectsDir: '/p', cacheFile: '/c.json', fs });
  const inFlight = index.refresh(['/repo']);
  index.invalidate();
  await inFlight;
  expect(index.sessionsIn(['/repo'])).toHaveLength(0);
});

it('lists a session with its subagent files and does not list them as sessions', async () => {
  const fs = fakeFs({
    '/p/-repo/s1.jsonl': userLine('one'),
    '/p/-repo/s1/subagents/agent-a1.jsonl': userLine('child'),
  });
  const index = createIndex({ projectsDir: '/p', cacheFile: '/c.json', fs });
  await index.refresh(['/repo']);
  const sessions = index.sessionsIn(['/repo']);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].subagents).toEqual(['/p/-repo/s1/subagents/agent-a1.jsonl']);
});

it('discards a cache written by an older layout', async () => {
  const fs = fakeFs({ '/p/-repo/s1.jsonl': userLine('one') });
  fs.writeText('/c.json', JSON.stringify({ version: 1, entries: { '/p/-repo/s1.jsonl': {} } }));
  const index = createIndex({ projectsDir: '/p', cacheFile: '/c.json', fs });
  await index.refresh(['/repo']);
  expect(index.sessionsIn(['/repo'])[0].digest.turns[0].text).toBe('one');
});
```

Extend the existing `fakeFs` helper so `listFiles` and `listDirs` answer for nested paths, and add `userLine(text)` returning one valid JSONL user record ending in `\n`.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test store
```
Expected: FAIL — `invalidate` is not a function.

- [ ] **Step 3: Implement**

In `src/store.ts`:

1. Bump `const CACHE_VERSION = 2;` — the entry now holds a digest with `models`, `usage` and `seq`-bearing turns, and a v1 file would deserialize into a digest missing them.

2. Add a generation counter:

```ts
  /**
   * Bumped on every invalidation. A refresh that began before one carries the
   * old generation and must not write its now-stale result back — otherwise an
   * invalidation is silently undone by a walk that resolves just after it.
   */
  let generation = 0;
```

In `refresh`, capture `const mine = generation;` at entry and, after each `await`, `if (mine !== generation) return;` before writing to `entries`. Add to the returned object:

```ts
    invalidate: () => {
      generation += 1;
      entries.clear();
      dirty = true;
    },
```

3. Fold through the new parse. Replace the `absorbLines` call with:

```ts
        const parsedBase = grew
          ? (parsedByPath.get(path) ?? emptySession(sessionId, path))
          : emptySession(sessionId, path);
        const parsed = absorb(parsedBase, chunk);
        parsedByPath.set(path, parsed);
        entries.set(path, {
          size: st.size,
          mtimeMs: st.mtimeMs,
          consumed: from + completeBytes(chunk),
          digest: digestOf(parsed),
          subagents: listSubagents(fs, path),
        });
```

`parsedByPath` is a module-level `Map<string, ParsedSession>` inside `createIndex`, **not persisted** — it is the working state an incremental fold needs, and it is exactly the transcript bulk the cache may not hold. A cold start rebuilds it by re-reading, which is correct and merely slower.

4. Add the subagent lister:

```ts
/** The sibling transcripts, if any. Absent directory is the common case. */
function listSubagents(fs: IndexFs, sessionPath: string): readonly string[] {
  const dir = subagentDirFor(sessionPath);
  return fs
    .listFiles(dir)
    .filter(isSubagentFileName)
    .map((name) => `${dir}/${name}`);
}
```

`listFiles` already filters to `.jsonl` and already returns `[]` for a missing directory, so no new failure mode enters here.

5. Add the on-demand full parse:

```ts
    /**
     * One session, fully parsed. Streamed and NOT cached: this is the other 97%,
     * and `ctx.dataDir` may not hold it.
     */
    parse: (path: string): ParsedSession | null => {
      const text = fs.readText(path);
      if (text === undefined) return null;
      const sessionId = path.split('/').at(-1)?.replace(/\.jsonl$/i, '') ?? path;
      return absorb(emptySession(sessionId, path), text);
    },
```

- [ ] **Step 4: Run the tests**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test store
```
Expected: PASS, including the three new tests.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "A walk that started before an invalidation may not write its answer back"
```

---

### Task 12: `watch.ts` — the live tail

**Files:**
- Create: `extensions/transcripts/src/watch.ts`
- Create: `extensions/transcripts/src/watch.test.ts`

**Interfaces:**
- Consumes: `absorb`, `emptySession`, `completeBytes`, `ParsedSession` (Task 8).
- Produces:

```ts
export interface TailFs {
  stat(path: string): { readonly size: number } | null;
  readRange(path: string, from: number): string;
  watch(path: string, fn: () => void): { close(): void };
}
export interface Tail { close(): void }
export interface TailEvents {
  onAppended(messages: readonly TranscriptMessage[]): void;
  onLifecycle(lifecycle: Lifecycle): void;
}
export const DEBOUNCE_MS = 150;
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;
export function tail(path: string, events: TailEvents, opts: {
  fs?: TailFs; schedule: (fn: () => void, ms: number) => () => void;
}): Tail;
```

`schedule` is injected rather than calling `setTimeout` directly, so a test drives the debounce without real time and `ctx.clock` stays the only source of time.

- [ ] **Step 1: Write the failing test**

`src/watch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { tail, type TailFs } from './watch.ts';
import type { TranscriptMessage } from './model/message.ts';
import type { Lifecycle } from './model/lifecycle.ts';

const line = (uuid: string, text: string): string =>
  `${JSON.stringify({ type: 'user', uuid, timestamp: '2026-08-01T10:00:00.000Z', message: { role: 'user', content: text } })}\n`;

function harness(initial: string) {
  let content = initial;
  let fire: (() => void) | null = null;
  let closed = false;
  const pending: (() => void)[] = [];

  const fs: TailFs = {
    stat: (): { size: number } => ({ size: Buffer.byteLength(content) }),
    readRange: (_p, from): string => Buffer.from(content).subarray(from).toString('utf8'),
    watch: (_p, fn) => {
      fire = fn;
      return { close: () => { closed = true; } };
    },
  };

  const appended: TranscriptMessage[] = [];
  const lifecycles: Lifecycle[] = [];
  const handle = tail('/x/s.jsonl', {
    onAppended: (m) => appended.push(...m),
    onLifecycle: (l) => lifecycles.push(l),
  }, { fs, schedule: (fn) => { pending.push(fn); return () => {}; } });

  return {
    handle, appended, lifecycles,
    append: (text: string) => { content += text; fire?.(); },
    flush: () => { const q = pending.splice(0); for (const fn of q) fn(); },
    get closed() { return closed; },
  };
}

describe('tail', () => {
  it('emits only what was appended', () => {
    const h = harness(line('u1', 'one'));
    h.flush();
    h.appended.length = 0;
    h.append(line('u2', 'two'));
    h.flush();
    expect(h.appended.map((m) => m.uuid)).toEqual(['u2']);
  });

  it('does not emit a half-written record, and emits it once it completes', () => {
    const h = harness('');
    const whole = line('u1', 'one');
    h.append(whole.slice(0, 20));
    h.flush();
    expect(h.appended).toHaveLength(0);
    h.append(whole.slice(20));
    h.flush();
    expect(h.appended.map((m) => m.uuid)).toEqual(['u1']);
  });

  it('emits a lifecycle marker', () => {
    const h = harness('');
    h.append(line('u1', 'go'));
    h.flush();
    expect(h.lifecycles.at(-1)?.state).toBe('working');
  });

  it('emits nothing after close, even if the watcher fires', () => {
    const h = harness('');
    h.handle.close();
    h.append(line('u1', 'one'));
    h.flush();
    expect(h.appended).toHaveLength(0);
    expect(h.closed).toBe(true);
  });

  it('drops an oversized record rather than buffering it', () => {
    const h = harness('');
    h.append(`${'x'.repeat(5 * 1024 * 1024)}\n${line('u1', 'one')}`);
    h.flush();
    expect(h.appended.map((m) => m.uuid)).toEqual(['u1']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test watch
```
Expected: FAIL — cannot resolve `./watch.ts`.

- [ ] **Step 3: Implement**

`src/watch.ts`:

```ts
import { statSync, readFileSync, watch as fsWatch } from 'node:fs';
import type { Lifecycle } from './model/lifecycle.ts';
import type { TranscriptMessage } from './model/message.ts';
import { absorb, completeBytes, emptySession, type ParsedSession } from './parse/session.ts';

/**
 * Following a transcript an agent is writing right now.
 *
 * It runs the SAME fold as a cold read — a tailer with its own parser is exactly
 * the drift this module exists to prevent. What it adds is an offset, a
 * debounce, and two guards about failure rather than success.
 *
 * This runs on the extension host's own thread, which also serves the sidebar
 * (`worker_threads` is denied to extensions), so the debounce is not a nicety:
 * an agent mid-turn appends many times a second.
 */

export const DEBOUNCE_MS = 150;

/** A single record past this is dropped rather than buffered without bound. */
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;

export interface TailFs {
  stat(path: string): { readonly size: number } | null;
  readRange(path: string, from: number): string;
  watch(path: string, fn: () => void): { close(): void };
}

export interface TailEvents {
  onAppended(messages: readonly TranscriptMessage[]): void;
  onLifecycle(lifecycle: Lifecycle): void;
}

export interface Tail {
  close(): void;
}

export const nodeTailFs: TailFs = {
  stat: (path) => {
    try {
      return { size: statSync(path).size };
    } catch {
      return null;
    }
  },
  readRange: (path, from) => {
    try {
      return readFileSync(path).subarray(from).toString('utf8');
    } catch {
      return '';
    }
  },
  watch: (path, fn) => {
    const watcher = fsWatch(path, { persistent: false }, () => {
      fn();
    });
    // A watcher that errors is a file that moved; the next stat answers null and
    // the tail idles rather than throwing on the host's thread.
    watcher.on('error', () => {});
    return { close: () => { watcher.close(); } };
  },
};

export function tail(
  path: string,
  events: TailEvents,
  opts: { fs?: TailFs; schedule: (fn: () => void, ms: number) => () => void },
): Tail {
  const fs = opts.fs ?? nodeTailFs;
  const sessionId = path.split('/').at(-1)?.replace(/\.jsonl$/i, '') ?? path;

  let session: ParsedSession = emptySession(sessionId, path);
  let offset = 0;
  let closed = false;
  let cancel: (() => void) | null = null;

  const drain = (): void => {
    if (closed) return;

    const st = fs.stat(path);
    if (st === null) return;
    // A file that shrank was rewritten rather than appended to, so the parse
    // describes bytes that no longer exist. Start over.
    if (st.size < offset) {
      session = emptySession(sessionId, path);
      offset = 0;
    }
    if (st.size === offset) return;

    const chunk = fs.readRange(path, offset);
    const consumed = completeBytes(chunk);
    if (consumed === 0) {
      // No complete record yet. Guard only the unbounded case: a single record
      // larger than the cap is skipped past, so one pathological line cannot
      // hold the tail forever.
      if (Buffer.byteLength(chunk) > MAX_RECORD_BYTES) {
        const skip = chunk.indexOf('\n');
        offset += skip === -1 ? Buffer.byteLength(chunk) : Buffer.byteLength(chunk.slice(0, skip + 1));
      }
      return;
    }

    const before = session.messages.length;
    const beforeLifecycle = session.lifecycle;
    session = absorb(session, chunk);
    offset += consumed;

    const appended = session.messages.slice(before);
    if (appended.length > 0) events.onAppended(appended);
    if (session.lifecycle !== null && session.lifecycle !== beforeLifecycle) {
      events.onLifecycle(session.lifecycle);
    }
  };

  const watcher = fs.watch(path, () => {
    if (closed) return;
    cancel?.();
    cancel = opts.schedule(drain, DEBOUNCE_MS);
  });

  // The first read is immediate: a caller that just opened a session should not
  // wait for the agent's next keystroke to see what is already there.
  cancel = opts.schedule(drain, 0);

  return {
    close: () => {
      closed = true;
      cancel?.();
      watcher.close();
    },
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test watch
```
Expected: PASS, 5 tests. The "emits nothing after close" test is the unsubscribe race.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Follow a file being written without reparsing what was read"
```

---

### Task 13: `index.ts` — the commands and the events

**Files:**
- Modify: `extensions/transcripts/src/index.ts`
- Modify: `extensions/transcripts/src/index.test.ts`
- Modify: `extensions/transcripts/src/model/index.ts` (the barrel)

**Interfaces:**
- Consumes: everything above.
- Produces: commands `transcripts.read`, `transcripts.usage`, `transcripts.watch`, `transcripts.unwatch`; events `transcripts.appended`, `transcripts.lifecycle`.

- [ ] **Step 1: Write the failing test**

Append to `src/index.test.ts`:

```ts
it('reads one session without its subagents by default', async () => {
  const { invoke } = await activated();
  const parent = await invoke('transcripts.read', { path: '/p/-repo/s1.jsonl' });
  expect(parent.subagents).toBeUndefined();
  const withKids = await invoke('transcripts.read', { path: '/p/-repo/s1.jsonl', subagents: true });
  expect(withKids.subagents).toHaveLength(1);
});

it('counts a session and its subagents together', async () => {
  const { invoke } = await activated();
  const usage = await invoke('transcripts.usage', { path: '/p/-repo/s1.jsonl' });
  expect(usage.total.output).toBeGreaterThan(0);
});

it('emits appended messages on the bus while a session grows', async () => {
  const { invoke, append, flush, emitted } = await activated();
  await invoke('transcripts.watch', { path: '/p/-repo/s1.jsonl' });
  append(userLine('later'));
  flush();
  expect(emitted('transcripts.appended')).toHaveLength(1);
});

it('stops emitting after unwatch', async () => {
  const { invoke, append, flush, emitted } = await activated();
  await invoke('transcripts.watch', { path: '/p/-repo/s1.jsonl' });
  await invoke('transcripts.unwatch', { path: '/p/-repo/s1.jsonl' });
  append(userLine('later'));
  flush();
  expect(emitted('transcripts.appended')).toHaveLength(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test index
```
Expected: FAIL — unknown command `transcripts.read`.

- [ ] **Step 3: Implement**

In `src/index.ts`, inside `activate`, after the existing point registration:

```ts
  const { commands, events } = api.proposed;

  /** Live tails, by path. One per file however many callers asked. */
  const tails = new Map<string, Tail>();

  ctx.subscriptions.push(
    commands.register('transcripts.read', {
      run: (args) => {
        const path = pathArg(args);
        if (path === null) return null;
        const parsed = index.parse(path);
        if (parsed === null) return null;
        if (!wantsSubagents(args)) return parsed;
        return {
          ...parsed,
          subagents: listSubagentPaths(path).map((child) => index.parse(child)).filter((s) => s !== null),
        };
      },
    }),

    commands.register('transcripts.usage', {
      /**
       * Subagents are counted ALWAYS. Their tokens were spent on the parent's
       * behalf, and a total that omitted them would be the same class of
       * under-count the dedupe rule exists to prevent — in the other direction.
       */
      run: (args) => {
        const path = pathArg(args);
        if (path === null) return null;
        const parts = [index.parse(path), ...listSubagentPaths(path).map((c) => index.parse(c))];
        return parts.reduce<UsageRollup>(
          (acc, part) => (part === null ? acc : mergeRollups(acc, part.usage)),
          emptyRollup(),
        );
      },
    }),

    commands.register('transcripts.watch', {
      run: (args) => {
        const path = pathArg(args);
        if (path === null || tails.has(path)) return false;
        tails.set(
          path,
          tail(
            path,
            {
              onAppended: (messages) => {
                events.emit('transcripts.appended', { path, messages });
              },
              onLifecycle: (lifecycle) => {
                events.emit('transcripts.lifecycle', { path, ...lifecycle });
              },
            },
            { schedule: (fn, ms) => ctx.clock.setTimeout(fn, ms) },
          ),
        );
        return true;
      },
    }),

    commands.register('transcripts.unwatch', {
      run: (args) => {
        const path = pathArg(args);
        if (path === null) return false;
        tails.get(path)?.close();
        return tails.delete(path);
      },
    }),

    // Every tail is a file handle and a watcher; deactivate must close them.
    { dispose: () => { for (const t of tails.values()) t.close(); tails.clear(); } },
  );
```

Add the local helpers above `activate`:

```ts
/** Answers from a command are `unknown`, and a cast is not a check. */
function pathArg(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const path = (args as { path?: unknown }).path;
  return typeof path === 'string' && path !== '' ? path : null;
}

function wantsSubagents(args: unknown): boolean {
  return typeof args === 'object' && args !== null && (args as { subagents?: unknown }).subagents === true;
}

function mergeRollups(a: UsageRollup, b: UsageRollup): UsageRollup {
  let out = a;
  for (const [model, usage] of Object.entries(b.byModel)) out = withUsage(out, model, usage);
  return out;
}
```

`listSubagentPaths` reads the sibling directory through the index's `fs`; expose it from `store.ts` as part of `RecallIndex` (`subagentsOf(path: string): readonly string[]`) rather than re-implementing the readdir here.

- [ ] **Step 4: Update the model barrel**

Rewrite `src/model/index.ts` to export the new surface:

```ts
export { asRecord, awaySummaryText, parseIsoTs, recordType, stringOrNull } from './record.ts';
export { contentBlocks, toolResultOutput, type Block } from './blocks.ts';
export { CANDIDATE_TAGS, HARNESS_TAGS, isHarnessInjectedText } from './noise.ts';
export { toMessage, usageOf, type Role, type TranscriptMessage, type Usage } from './message.ts';
export { lifecycleOf, type Lifecycle, type LifecycleState } from './lifecycle.ts';
export {
  addUsage, dedupeKeyOf, emptyRollup, maxUsage, subtractUsage, withUsage, ZERO_USAGE,
  type UsageRollup,
} from './usage.ts';
export { bestTitle, isEmptyDigest, type SessionDigest, type Turn } from './session.ts';
export {
  countMatches, matchesIn, snippetAround, DEFAULT_MATCHES_PER_SESSION, SNIPPET_RADIUS,
  type MatchSource, type SessionMatch,
} from './search.ts';
export { cwdIsUnder, encodeProjectDir, folderMatchesAny } from './project-dir.ts';
```

Add a `./parse` export to `package.json` alongside `./model`, pointing at `./src/parse/index.ts`, and create that barrel exporting `absorb`, `emptySession`, `completeBytes`, `digestOf`, `subagentDirFor`, `isSubagentFileName` and their types.

- [ ] **Step 5: Run the tests**

```bash
cd v2/extensions/transcripts && env -u NODE_OPTIONS pnpm test
```
Expected: PASS.

- [ ] **Step 6: Verify the whole workspace and the real app**

```bash
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
env -u NODE_OPTIONS pnpm smoke:m3
```
Expected: all pass. `smoke:m3` matters here — a green unit suite is not a working app, and this task changes an extension the sidebar's search depends on.

- [ ] **Step 7: Confirm the index still holds no transcript bulk**

```bash
cd v2 && env -u NODE_OPTIONS pnpm dev
# in another shell, after the rail's search box has run once:
python3 -c "import json,os;p=os.path.expanduser('~/.shepherd/v2-dev/extensions/shepherd.transcripts/index.json');print(round(os.path.getsize(p)/1e6,1),'MB')"
```
Expected: single-digit MB, and `grep -c tool-result` on that file returns 0. If either fails, the digest is carrying blocks it must not.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "The parser answers commands and speaks its appends onto the bus"
```

---

## Self-Review

**Spec coverage.** §2.1 unknown records → Task 8 (`unknown` array, `KNOWN_SIDE_TYPES`). §2.2 usage dedup → Tasks 7, 8. §2.3 subagents by path → Task 10, wired in Task 11. §2.4 `transcriptPath` escape hatch → Task 13 (`transcripts.read` takes a `path`, never an id — discovery by id is not implemented because no caller needs it yet; **this is a deliberate narrowing of §3.5, recorded here**). §2.5 tag census → Task 3. §2.6 markup defect → Tasks 3, 9. §3.1 model layer → Tasks 3–7. §3.2 fold → Tasks 8, 9. §3.3 index → Task 11. §3.4 tail → Task 12. §3.5 seams → Task 13. §4 errors → every task returns null. §6 the three weighted tests → Task 9 Step 5 (derivation), Task 8 Step 1 (mid-record append), Task 12 Step 4 (unsubscribe race).

**Known gap, flagged rather than hidden.** §6 asks for a fixture corpus of *real anonymised* sessions; this plan uses hand-written fixtures instead. Hand-written ones are deterministic and reviewable, which the golden test needs; a real-corpus test would be machine-dependent and would have to be skipped in CI. If the real-corpus check is wanted, add it as a `describe.skipIf(!existsSync(projectsDir))` block after Task 9.

**Type consistency.** `Usage` is defined once in `model/message.ts` and imported by `model/usage.ts` (not redefined). `Turn` gains `seq` in Task 9 and is consumed by `digestOf` in the same task. `ParsedSession.pendingUsage` is used by `absorb` in Task 8 and by nothing else. `TailFs.stat` returns `{size}` only, matching its two call sites. `RecallIndex` gains `invalidate`, `parse` (Task 11) and `subagentsOf` (Task 13) — all three are named in the Interfaces block of the task that adds them.

**One correction folded in.** The spec's claim that the derivation test proves the restructure "behaviour-preserving for search" is too strong: user turns whose content is an array of text blocks were dropped before and are kept now. Task 9 Step 5 enumerates the three intended differences and requires any fourth to be treated as a regression, which is the honest version of that guarantee.
