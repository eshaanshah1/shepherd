# Link pills implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pasting a Jira issue URL or a Slack permalink into the task composer turns it into a vendor-tinted pill, with the Jira pill's label resolved to the real issue summary through `acli`.

**Architecture:** A new `links` extension owns both URL grammars and the Jira resolution chain, and registers a provider at a new `tasks.pastedLink` point. The composer asks its own extension two questions over `invoke` (`tasks.linkPatterns` when it opens, `tasks.resolveLink` after a paste), which is the D5 shape `tasks.suggestRepos` already documents. The pill is a DOM node the composer builds and mutates directly, never React.

**Tech Stack:** TypeScript, React 19, Electron, pnpm workspaces, vitest (+ jsdom for UI), `acli` (Atlassian CLI) as a subprocess.

**Spec:** `docs/superpowers/specs/2026-08-24-link-pills-design.md`

## Global Constraints

- **Work only in `v2/`.** The `spike/seam1/` Swift app is maintenance-only.
- **`data-token` is the URL and only ever the URL**, for both vendors, resolved or not. No resolved text is ever substituted into the brief.
- **An extension may TYPE-import another and may not VALUE-import it.** Lint-enforced in `v2/tooling/eslint/boundaries.js`. Extensions may value-import `@shepherd/sdk` and `@shepherd/ui` only.
- **A stylesheet names a ROLE, never a palette step and never a hex** — with the one exception this feature is granted: the two vendor hues, declared as tier-3 properties beside the pill in `pill.css`. Nothing goes into `palette.ts` or `roles.ts`.
- **`erasableSyntaxOnly` is on.** No constructor parameter properties, no enums. Electron runs the `.ts` on node's type stripping, which can only erase.
- **Every `--sh-*` a stylesheet reads must be declared somewhere**, or `v2/packages/app/src/renderer/token-refs.css.test.ts` fails.
- **`package.json`'s `shepherd` block and `src/manifest.ts` must be identical**, asserted by each extension's own `manifest.test.ts`.
- Run tests with `pnpm --filter <package> test`. Typecheck the tree with `pnpm typecheck` from `v2/`. Lint with `pnpm lint`.
- Commit after every task. Branch is `cobalt-cotswold`; do not push.

---

## File structure

**`v2/extensions/tasks/src/manifest.ts`** (modify) — declares the point id, the provider interface, the pattern shape and the two command ids. This is the file both halves and the `links` extension read, so every type in the feature's vocabulary is defined here and nowhere else.

**`v2/extensions/tasks/src/index.ts`** (modify) — defines the point, registers the two command handlers that dispatch to it.

**`v2/packages/ui/src/prompt-field.tsx`** (modify) — one new optional prop, `onPasteText`.

**`v2/packages/ui/src/pill.css`** (modify) — two vendor hue declarations.

**`v2/extensions/links/`** (create) — the new extension.
- `package.json`, `tsconfig.json`, `vitest.config.ts` — package scaffolding.
- `src/manifest.ts` — the id, the manifest, the secret key.
- `src/parse.ts` — the URL grammars and the pattern data. Pure, no I/O.
- `src/jira.ts` — the resolution chain. Takes injected `process`/`fetch`/`secrets` so it is testable without either.
- `src/label.ts` — parsed link plus optional summary to a pill label. Pure.
- `src/index.ts` — `activate`: builds the provider, registers it at the point.

**`v2/extensions/tasks/ui/link-paste.ts`** (create) — the renderer's half: does a pasted string claim a pattern, and building the pill node. Pure except for `document.createElement`, so it is unit-testable without mounting the composer.

**`v2/extensions/tasks/ui/composer.tsx`** (modify) — wires `onPasteText` to the above, holds the pattern cache and the in-flight guard.

**Registration** (modify) — `v2/packages/app/src/ext-host/builtins.ts`, `v2/packages/app/src/main/index.ts`, `v2/package.json` workspace deps where needed, `v2/tsconfig.json` project references.

---

## Task 1: The point and its two commands

Declares the vocabulary and the seam, with no providers registered. At the end of this task `tasks.linkPatterns` answers `{ patterns: [] }` and `tasks.resolveLink` answers `null`, which is correct: a point with no provider is a question nobody answers yet.

**Files:**
- Modify: `v2/extensions/tasks/src/manifest.ts`
- Modify: `v2/extensions/tasks/src/index.ts`
- Test: `v2/extensions/tasks/src/index.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PASTED_LINK_POINT` (`'tasks.pastedLink'`), `PastedLinkPattern`, `PastedLink`, `PastedLinkProvider`, `TASK_COMMANDS.linkPatterns` (`'tasks.linkPatterns'`), `TASK_COMMANDS.resolveLink` (`'tasks.resolveLink'`).

- [ ] **Step 1: Write the failing test**

Append to `v2/extensions/tasks/src/index.test.ts`. Match the file's existing harness for building a context and invoking a command; the assertions are what matter here.

```ts
describe('the pasted-link point', () => {
  it('answers with no patterns when nothing provides any', async () => {
    const h = await activated();
    const answer = await h.run(TASK_COMMANDS.linkPatterns, {});
    expect(answer).toEqual({ patterns: [] });
  });

  it('offers every registered provider its patterns, deduplicated', async () => {
    const h = await activated();
    const point = h.points.get<PastedLinkProvider>(PASTED_LINK_POINT);
    point?.register({
      patterns: [{ hostSuffix: '.atlassian.net', pathPrefix: '/browse/' }],
      resolve: async () => null,
    });
    point?.register({
      // The same pattern twice must not be offered twice: the composer matches
      // against this list on every paste.
      patterns: [
        { hostSuffix: '.atlassian.net', pathPrefix: '/browse/' },
        { hostSuffix: '.slack.com', pathPrefix: '/archives/' },
      ],
      resolve: async () => null,
    });
    const answer = await h.run(TASK_COMMANDS.linkPatterns, {});
    expect(answer).toEqual({
      patterns: [
        { hostSuffix: '.atlassian.net', pathPrefix: '/browse/' },
        { hostSuffix: '.slack.com', pathPrefix: '/archives/' },
      ],
    });
  });

  it('returns the first provider that claims the url', async () => {
    const h = await activated();
    const point = h.points.get<PastedLinkProvider>(PASTED_LINK_POINT);
    point?.register({ patterns: [], resolve: async () => null });
    point?.register({
      patterns: [],
      resolve: async () => ({ vendor: 'jira', label: 'SHEP-412', resolved: false }),
    });
    const answer = await h.run(TASK_COMMANDS.resolveLink, {
      url: 'https://x.atlassian.net/browse/SHEP-412',
    });
    expect(answer).toEqual({ vendor: 'jira', label: 'SHEP-412', resolved: false });
  });

  it('is null when no provider claims it, and a provider that throws is skipped', async () => {
    const h = await activated();
    const point = h.points.get<PastedLinkProvider>(PASTED_LINK_POINT);
    point?.register({
      patterns: [],
      resolve: () => {
        throw new Error('boom');
      },
    });
    const answer = await h.run(TASK_COMMANDS.resolveLink, { url: 'https://example.com/x' });
    expect(answer).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd v2 && pnpm --filter @shepherd/ext-tasks test -- index.test.ts`
Expected: FAIL. `PASTED_LINK_POINT` is not exported, `TASK_COMMANDS.linkPatterns` is undefined.

- [ ] **Step 3: Declare the vocabulary**

In `v2/extensions/tasks/src/manifest.ts`, add to the `TASK_COMMANDS` object, beside `suggestRepos`:

```ts
  /**
   * Which URLs a paste should be swallowed for, asked when the composer opens.
   *
   * A command for the reason `suggestRepos` is one (D5): the providers are
   * registered in the utility process and the renderer cannot consult a point.
   * Asked on OPEN rather than once on mount, because a stale answer here changes
   * what Cmd-V does and there is no downstream catch for that — unlike a stale
   * machine, which `tasks.create` reports on when it forwards.
   */
  linkPatterns: 'tasks.linkPatterns',
  /** What a claimed URL should be drawn as. Answered by the point, or null. */
  resolveLink: 'tasks.resolveLink',
```

Then, near `TRANSCRIPT_SEARCH_POINT`, add:

```ts
/**
 * What is this pasted URL? — a question, not a step.
 *
 * It clears ADR 0039's bar by SUBJECT: a pasted URL is neither a repo nor a
 * task, and no existing point could answer it without being widened into
 * something that means two things.
 *
 * The direction matters as much as the subject. The composer lives here and the
 * vendor grammars do not, so the alternative was `tasks` declaring a vendor
 * extension in its own `dependencies` — the generic extension naming the
 * specific one, which is backwards from every other pairing in this tree.
 */
export const PASTED_LINK_POINT = 'tasks.pastedLink';

/**
 * Which URLs a provider claims, as DATA rather than as a regex.
 *
 * A pattern crosses the port and is matched in the renderer, so a compiled
 * expression here would be a provider handing the composer something to run.
 * Three fields cover both vendors.
 *
 * Host AND path, deliberately. Host alone would claim every `atlassian.net` URL,
 * so a Confluence page would be swallowed, resolve to nothing, and have to be put
 * back as text — a flicker on the one surface that has to stay quiet. With the
 * path in the pattern, a claimed URL is one the grammar can parse, and the
 * composer never un-draws a pill.
 */
export interface PastedLinkPattern {
  /** Matched against the end of the hostname. `.atlassian.net`. */
  readonly hostSuffix: string;
  /** Matched against the start of the pathname. `/browse/`. */
  readonly pathPrefix: string;
  /** A query parameter that must be present. Absent means any query. */
  readonly query?: string;
}

/**
 * What a pill should be drawn as.
 *
 * Note the three things it does NOT carry. No token: the token is the URL the
 * composer already has, and a resolved summary substituted into the brief would
 * put text written in another system into the prompt an agent reads. No icon and
 * no colour: `vendor` is a closed union and the composer owns both, which is the
 * `CardFact` rule met by having nothing to allow-list rather than by
 * allow-listing.
 */
export interface PastedLink {
  readonly vendor: 'jira' | 'slack';
  /** What the pill reads. Already the fallback when nothing resolved. */
  readonly label: string;
  /** Whether a lookup actually answered. Read by tests; drives no drawing. */
  readonly resolved: boolean;
}

export interface PastedLinkProvider {
  readonly patterns: readonly PastedLinkPattern[];
  /**
   * `null` when this provider does not claim the URL, which is the common answer.
   *
   * The signal is a real `AbortSignal` for the reason `TranscriptQuery` records
   * for its own: providers run in this same process, so there is no port to
   * flatten it into a plain value.
   */
  resolve(url: string, signal: AbortSignal): Promise<PastedLink | null>;
}
```

- [ ] **Step 4: Define the point and register the commands**

In `v2/extensions/tasks/src/index.ts`, add `PASTED_LINK_POINT`, `PastedLinkProvider`, `PastedLink` and `PastedLinkPattern` to the manifest import list, then beside the `transcripts` point definition:

```ts
  /**
   * Registration order, not priority: a URL belongs to at most one vendor, so
   * "which provider wins" is not a question anybody is asking. The first one to
   * claim it answers.
   */
  const pastedLinks = points.define<PastedLinkProvider>(PASTED_LINK_POINT, {
    order: 'registration',
  });
  ctx.subscriptions.push(pastedLinks);
```

And with the other command registrations:

```ts
    commands.register(TASK_COMMANDS.linkPatterns, {
      title: 'Tasks: Link Patterns',
      schema: s.object({}),
      handler: async () => {
        // Deduplicated, because this list is walked on every paste and two
        // providers claiming the same shape is a legitimate thing to have done.
        const seen = new Set<string>();
        const patterns: PastedLinkPattern[] = [];
        for (const provider of pastedLinks.all()) {
          for (const pattern of provider.patterns) {
            const key = `${pattern.hostSuffix}|${pattern.pathPrefix}|${pattern.query ?? ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            patterns.push(pattern);
          }
        }
        return { patterns };
      },
    });

    commands.register(TASK_COMMANDS.resolveLink, {
      title: 'Tasks: Resolve Link',
      schema: s.object({ url: s.string() }),
      handler: async (args) => {
        const controller = new AbortController();
        // The label is already on screen, so a slow answer has nothing to hold
        // up. ADR 0038's lesson, applied to a spawn: nothing user-facing waits.
        const deadline = setTimeout(() => controller.abort(), RESOLVE_LINK_DEADLINE_MS);
        try {
          for (const provider of pastedLinks.all()) {
            try {
              const answer = await provider.resolve(args.url, controller.signal);
              if (answer !== null) return answer;
            } catch (error: unknown) {
              // A vendor that failed is a pill with its fallback label, which is
              // a state the composer already draws. It is not worth a toast.
              ctx.log.warn(`a ${PASTED_LINK_POINT} provider threw and was skipped — ${String(error)}`);
            }
          }
          return null;
        } finally {
          clearTimeout(deadline);
        }
      },
    });
```

Add the deadline beside the other module constants in `index.ts`:

```ts
/** Long enough for a cold `acli` spawn, short enough that nobody waits on it. */
const RESOLVE_LINK_DEADLINE_MS = 4_000;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd v2 && pnpm --filter @shepherd/ext-tasks test`
Expected: PASS, including the pre-existing `manifest.test.ts` (no `package.json` change was needed, since a point and a command handler are not manifest contributions).

- [ ] **Step 6: Typecheck and commit**

```bash
cd v2 && pnpm typecheck && pnpm lint
git add v2/extensions/tasks/src/manifest.ts v2/extensions/tasks/src/index.ts v2/extensions/tasks/src/index.test.ts
git commit -m "Tasks: a point for what a pasted URL is"
```

---

## Task 2: `PromptField.onPasteText`

**Files:**
- Modify: `v2/packages/ui/src/prompt-field.tsx:98-108` (the props interface), `:464-480` (the paste handler)
- Test: `v2/packages/ui/src/prompt-field.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `onPasteText?: (text: string) => boolean` on `PromptFieldProps`. Returning `true` suppresses the default `insertText` for that event only.

- [ ] **Step 1: Write the failing test**

Append to `v2/packages/ui/src/prompt-field.test.tsx`, following the file's existing mount helper and paste-event construction.

```ts
describe('onPasteText', () => {
  it('is handed the plain text and can suppress the default insert', () => {
    const seen: string[] = [];
    const dom = mount(<PromptField onPasteText={(text) => { seen.push(text); return true; }} />);
    const field = dom.container.querySelector<HTMLElement>('[role="textbox"]')!;
    paste(field, { text: 'https://x.atlassian.net/browse/A-1' });
    expect(seen).toEqual(['https://x.atlassian.net/browse/A-1']);
    // Suppressed: the handler said it took the paste, so nothing was inserted.
    expect(field.textContent).toBe('');
  });

  it('falls through to the ordinary text paste when it returns false', () => {
    const dom = mount(<PromptField onPasteText={() => false} />);
    const field = dom.container.querySelector<HTMLElement>('[role="textbox"]')!;
    paste(field, { text: 'plain words' });
    expect(field.textContent).toBe('plain words');
  });

  /**
   * Files win. An image pasted from the clipboard is not a text paste, and a
   * field that asked the text handler first would hand it the filename.
   */
  it('offers a paste carrying files to onPasteFiles first', () => {
    const order: string[] = [];
    const dom = mount(
      <PromptField
        onPasteFiles={() => { order.push('files'); return true; }}
        onPasteText={() => { order.push('text'); return true; }}
      />,
    );
    const field = dom.container.querySelector<HTMLElement>('[role="textbox"]')!;
    paste(field, { text: 'ignored', files: [new File(['x'], 'a.png', { type: 'image/png' })] });
    expect(order).toEqual(['files']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd v2 && pnpm --filter @shepherd/ui test -- prompt-field.test.tsx`
Expected: FAIL. `onPasteText` is not a prop, so the first case inserts the URL as text.

- [ ] **Step 3: Add the prop**

In `v2/packages/ui/src/prompt-field.tsx`, beside `onPasteFiles` in the props interface:

```ts
  /**
   * A paste carrying plain text. Return true to say it was handled, and the
   * default insert is suppressed for that event only.
   *
   * Files are offered to `onPasteFiles` first: an image from the clipboard is not
   * a text paste, and asking this handler first would hand it a filename.
   *
   * Suppressing costs the browser's own undo entry for that paste, which is why
   * a consumer should claim the smallest set of pastes it needs rather than all
   * of them.
   */
  readonly onPasteText?: (text: string) => boolean;
```

Add `onPasteText` to the destructured parameter list at `:150`.

- [ ] **Step 4: Branch in the handler**

Replace the tail of the `onPaste` handler:

```tsx
        const text = event.clipboardData?.getData('text/plain');
        if (text === undefined || text === '') return;
        if (onPasteText?.(text) === true) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        document.execCommand('insertText', false, text);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd v2 && pnpm --filter @shepherd/ui test`
Expected: PASS, all of them. The existing paste tests must be untouched.

- [ ] **Step 6: Commit**

```bash
cd v2 && pnpm typecheck
git add v2/packages/ui/src/prompt-field.tsx v2/packages/ui/src/prompt-field.test.tsx
git commit -m "PromptField: a hook for a text paste, mirroring the one for files"
```

---

## Task 3: The `links` package and its URL grammar

Scaffolds the extension and implements the pure half: what a URL is, and which patterns claim it. No activation, no registration, no subprocess.

**Files:**
- Create: `v2/extensions/links/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `v2/extensions/links/src/manifest.ts`, `src/parse.ts`, `src/parse.test.ts`, `src/label.ts`, `src/label.test.ts`, `src/manifest.test.ts`

**Interfaces:**
- Consumes: `PastedLinkPattern` from Task 1 (type-only).
- Produces:
  - `LINKS_ID = 'shepherd.links'`, `linksManifest`, `JIRA_TOKEN_SECRET_KEY = 'jiraToken'`
  - `JIRA_PATTERNS`, `SLACK_PATTERNS`, `LINK_PATTERNS` (the concatenation)
  - `type ParsedLink = { vendor: 'jira'; key: string } | { vendor: 'slack'; channelId: string; atMs: number }`
  - `parseLink(url: string): ParsedLink | null`
  - `slackStampMs(segment: string): number | null`
  - `jiraLabel(key: string, summary?: string): string`, `slackLabel(atMs: number): string`

- [ ] **Step 1: Write the failing tests**

`v2/extensions/links/src/parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LINK_PATTERNS, claims, parseLink, slackStampMs } from './parse.ts';

describe('slackStampMs', () => {
  it('reads epoch seconds and six more digits', () => {
    // 1724500000 = 2024-08-24T12:26:40Z. The six trailing digits are microseconds.
    expect(slackStampMs('p1724500000123456')).toBe(1_724_500_000_123);
  });

  it('refuses a segment of the wrong shape rather than guessing', () => {
    // The failure this guards is a plausible-looking timestamp that names no
    // message, which is indistinguishable from a real one downstream.
    expect(slackStampMs('p172450000012345')).toBeNull();
    expect(slackStampMs('1724500000123456')).toBeNull();
    expect(slackStampMs('pnotanumber12345')).toBeNull();
    expect(slackStampMs('p')).toBeNull();
  });
});

describe('parseLink', () => {
  it('reads a jira key from a browse url', () => {
    expect(parseLink('https://browserstack.atlassian.net/browse/SHEP-412')).toEqual({
      vendor: 'jira',
      key: 'SHEP-412',
    });
  });

  it('reads a jira key from a board url', () => {
    expect(
      parseLink(
        'https://browserstack.atlassian.net/jira/software/projects/SHEP/boards/1?selectedIssue=SHEP-412',
      ),
    ).toEqual({ vendor: 'jira', key: 'SHEP-412' });
  });

  it('reads a slack permalink', () => {
    expect(
      parseLink('https://browserstack.slack.com/archives/C08ABCDEF/p1724500000123456'),
    ).toEqual({ vendor: 'slack', channelId: 'C08ABCDEF', atMs: 1_724_500_000_123 });
  });

  it('is null for a claimed host whose path says nothing', () => {
    expect(parseLink('https://browserstack.atlassian.net/browse/notakey')).toBeNull();
    expect(parseLink('https://browserstack.slack.com/archives/C08ABCDEF/pnope')).toBeNull();
  });

  it('is null for anything else', () => {
    expect(parseLink('https://browserstack.atlassian.net/wiki/spaces/ENG/pages/1')).toBeNull();
    expect(parseLink('https://example.com/browse/SHEP-412')).toBeNull();
    expect(parseLink('not a url at all')).toBeNull();
    expect(parseLink('C#')).toBeNull();
  });
});

describe('claims', () => {
  it('claims the urls the grammar can read', () => {
    expect(claims('https://x.atlassian.net/browse/A-1', LINK_PATTERNS)).toBe(true);
    expect(claims('https://x.slack.com/archives/C1/p1724500000123456', LINK_PATTERNS)).toBe(true);
  });

  it('leaves confluence and the marketing site alone', () => {
    expect(claims('https://x.atlassian.net/wiki/spaces/ENG', LINK_PATTERNS)).toBe(false);
    expect(claims('https://www.atlassian.net/', LINK_PATTERNS)).toBe(false);
  });

  it('needs the query a pattern asks for', () => {
    const board = 'https://x.atlassian.net/jira/software/projects/A/boards/1';
    expect(claims(`${board}?selectedIssue=A-1`, LINK_PATTERNS)).toBe(true);
    expect(claims(board, LINK_PATTERNS)).toBe(false);
  });

  /**
   * The drift guard. The provider knows the grammar and the composer knows the
   * patterns; without this, a vendor changing its URL shape breaks paste silently
   * in one of the two places.
   */
  it('claims every url the parser accepts', () => {
    const accepted = [
      'https://x.atlassian.net/browse/A-1',
      'https://x.atlassian.net/jira/software/projects/A/boards/1?selectedIssue=A-1',
      'https://x.slack.com/archives/C1/p1724500000123456',
    ];
    for (const url of accepted) {
      expect(parseLink(url), url).not.toBeNull();
      expect(claims(url, LINK_PATTERNS), url).toBe(true);
    }
  });
});
```

`v2/extensions/links/src/label.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { jiraLabel, slackLabel } from './label.ts';

describe('jiraLabel', () => {
  it('is the key and the summary when a lookup answered', () => {
    expect(jiraLabel('SHEP-412', 'Retry loop drops the last event')).toBe(
      'SHEP-412 Retry loop drops the last event',
    );
  });

  it('is the bare key when nothing answered', () => {
    // The key came free in the URL. A generic label would throw away the one
    // useful thing the paste already told us.
    expect(jiraLabel('SHEP-412')).toBe('SHEP-412');
    expect(jiraLabel('SHEP-412', '')).toBe('SHEP-412');
  });

  it('truncates a summary long enough to take over the sentence', () => {
    const long = 'a'.repeat(120);
    const label = jiraLabel('SHEP-412', long);
    expect(label.length).toBeLessThanOrEqual(9 + 60 + 1);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('slackLabel', () => {
  it('carries the permalink’s own date, which is all Slack gets', () => {
    expect(slackLabel(1_724_500_000_123)).toBe('Slack thread · 24 Aug');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd v2 && pnpm --filter @shepherd/ext-links test`
Expected: FAIL, and at first the filter matches no package. That is the failure; the package does not exist yet.

- [ ] **Step 3: Scaffold the package**

`v2/extensions/links/package.json`:

```json
{
  "name": "@shepherd/ext-links",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "shepherd.links — what a pasted Jira or Slack URL is, drawn as a pill in the composer.",
  "//exports": "The split every extension makes: main imports ./manifest to register, the utility process imports the root. No ./ui — the pill is drawn by the composer, which lives in tasks.",
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" },
    "./manifest": { "types": "./src/manifest.ts", "default": "./src/manifest.ts" }
  },
  "scripts": { "typecheck": "tsc -b", "test": "vitest run" },
  "//dependencies": "@shepherd/ext-tasks is TYPE-ONLY — `import type` and nothing else. The runtime relationship is the point id plus the manifest's `dependencies` entry, which is the gate the host can review; a value import would route around it. See extensions/README.md.",
  "dependencies": {
    "@shepherd/ext-tasks": "workspace:*",
    "@shepherd/sdk": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  },
  "//shepherd": "The manifest, as an extension declares it. `src/manifest.ts` is the typed copy the host loads, and `manifest.test.ts` asserts the two are identical.",
  "shepherd": {
    "id": "shepherd.links",
    "name": "Links",
    "version": "0.1.0",
    "api": "^1.0.0",
    "activation": ["onStartup"],
    "//permissions": "process.exec is for acli. network is the REST fallback when acli cannot answer. secrets holds the token that fallback needs, and nothing else.",
    "permissions": ["process.exec", "network", "secrets"],
    "dependencies": ["shepherd.tasks"],
    "contributes": {
      "secrets": [
        {
          "key": "jiraToken",
          "title": "Jira API token",
          "description": "Only needed if `acli` cannot answer — this extension asks the Atlassian CLI first, and a machine with `acli jira auth status` reporting Authenticated never needs this. An API token for the site the issues live on is enough; read access to issues is all it uses.",
          "link": "https://id.atlassian.com/manage-profile/security/api-tokens"
        }
      ]
    }
  }
}
```

Copy `v2/extensions/worktree-hook/tsconfig.json` and `vitest.config.ts` verbatim, changing only the package name in `vitest.config.ts` to `@shepherd/ext-links` and the `references` in `tsconfig.json` to `@shepherd/sdk` and `@shepherd/ext-tasks`.

Add the package to `v2/tsconfig.json`'s `references` array beside the other extensions.

- [ ] **Step 4: Write the manifest module and its test**

`v2/extensions/links/src/manifest.ts`:

```ts
import type { ExtensionManifest } from '@shepherd/sdk';

export const LINKS_ID = 'shepherd.links';

/**
 * The credential, and the honest thing said on the field itself: most people
 * never need it. `acli` is asked first, exactly as `github` asks `gh` first, so
 * the common case is a form nobody has to fill in.
 */
export const JIRA_TOKEN_SECRET_KEY = 'jiraToken';

export const linksManifest: ExtensionManifest = {
  id: LINKS_ID,
  name: 'Links',
  version: '0.1.0',
  api: '^1.0.0',
  activation: ['onStartup'],
  permissions: ['process.exec', 'network', 'secrets'],
  dependencies: ['shepherd.tasks'],
  contributes: {
    secrets: [
      {
        key: JIRA_TOKEN_SECRET_KEY,
        title: 'Jira API token',
        description:
          'Only needed if `acli` cannot answer — this extension asks the Atlassian CLI first, ' +
          'and a machine with `acli jira auth status` reporting Authenticated never needs this. ' +
          'An API token for the site the issues live on is enough; read access to issues is all it uses.',
        link: 'https://id.atlassian.com/manage-profile/security/api-tokens',
      },
    ],
  },
};
```

`v2/extensions/links/src/manifest.test.ts` — copy the shape of `v2/extensions/worktree-hook/src/manifest.test.ts`, which reads its own `package.json` and asserts the `shepherd` block deep-equals the typed manifest. Add one case of this feature's own:

```ts
it('names the point tasks actually defines', () => {
  // A string literal on both sides of a port. If `tasks` renames its point, this
  // is the test that says so, rather than a paste that quietly stops working.
  expect(PASTED_LINK_POINT).toBe('tasks.pastedLink');
});
```

- [ ] **Step 5: Implement `parse.ts`**

```ts
import type { PastedLinkPattern } from '@shepherd/ext-tasks/manifest';

/**
 * A Jira key: a project code, a hyphen, a number. Anchored, because
 * `/browse/notakey` must fail rather than half-match.
 */
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

/** `p` then epoch seconds then exactly six more digits. */
const SLACK_STAMP = /^p(\d{10,})(\d{6})$/;

export const JIRA_PATTERNS: readonly PastedLinkPattern[] = [
  { hostSuffix: '.atlassian.net', pathPrefix: '/browse/' },
  { hostSuffix: '.atlassian.net', pathPrefix: '/jira/', query: 'selectedIssue' },
];

export const SLACK_PATTERNS: readonly PastedLinkPattern[] = [
  { hostSuffix: '.slack.com', pathPrefix: '/archives/' },
];

export const LINK_PATTERNS: readonly PastedLinkPattern[] = [...JIRA_PATTERNS, ...SLACK_PATTERNS];

export type ParsedLink =
  | { readonly vendor: 'jira'; readonly key: string }
  | { readonly vendor: 'slack'; readonly channelId: string; readonly atMs: number };

/**
 * `p1724500000123456` to epoch milliseconds.
 *
 * The shape is load-bearing: a segment of the wrong length would still parse as
 * SOME number, and a plausible timestamp naming no message is worse than a
 * refusal, because nothing downstream can tell the two apart.
 */
export function slackStampMs(segment: string): number | null {
  const found = SLACK_STAMP.exec(segment);
  if (found === null) return null;
  const seconds = Number(found[1]);
  const micros = Number(found[2]);
  if (!Number.isFinite(seconds) || !Number.isFinite(micros)) return null;
  return seconds * 1000 + Math.floor(micros / 1000);
}

const asUrl = (text: string): URL | null => {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
};

export function matches(url: URL, pattern: PastedLinkPattern): boolean {
  if (!url.hostname.endsWith(pattern.hostSuffix)) return false;
  if (!url.pathname.startsWith(pattern.pathPrefix)) return false;
  return pattern.query === undefined || url.searchParams.has(pattern.query);
}

/** Does any pattern claim this text? The composer's paste-time question. */
export function claims(text: string, patterns: readonly PastedLinkPattern[]): boolean {
  const url = asUrl(text);
  return url !== null && patterns.some((pattern) => matches(url, pattern));
}

export function parseLink(text: string): ParsedLink | null {
  const url = asUrl(text);
  if (url === null) return null;

  if (url.hostname.endsWith('.atlassian.net')) {
    const fromPath = url.pathname.startsWith('/browse/')
      ? url.pathname.slice('/browse/'.length).split('/')[0]
      : undefined;
    const key = fromPath ?? url.searchParams.get('selectedIssue') ?? '';
    return JIRA_KEY.test(key) ? { vendor: 'jira', key } : null;
  }

  if (url.hostname.endsWith('.slack.com')) {
    const [, archives, channelId, stamp] = url.pathname.split('/');
    if (archives !== 'archives' || channelId === undefined || channelId === '') return null;
    const atMs = stamp === undefined ? null : slackStampMs(stamp);
    return atMs === null ? null : { vendor: 'slack', channelId, atMs };
  }

  return null;
}
```

- [ ] **Step 6: Implement `label.ts`**

```ts
/** Room for a summary beside a key, before the sentence stops being a sentence. */
const SUMMARY_MAX = 60;

export function jiraLabel(key: string, summary?: string): string {
  const trimmed = (summary ?? '').trim();
  if (trimmed === '') return key;
  const short =
    trimmed.length <= SUMMARY_MAX ? trimmed : `${trimmed.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
  return `${key} ${short}`;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * The date the permalink itself carries, which is the whole of what Slack gets
 * without a workspace app. UTC, deliberately: a label that shifts by a day
 * depending on where the reader is would be worse than one that is consistently
 * the message's own stamp.
 */
export function slackLabel(atMs: number): string {
  const at = new Date(atMs);
  return `Slack thread · ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd v2 && pnpm install && pnpm --filter @shepherd/ext-links test`
Expected: PASS, all cases in `parse.test.ts`, `label.test.ts` and `manifest.test.ts`.

- [ ] **Step 8: Commit**

```bash
cd v2 && pnpm typecheck && pnpm lint
git add v2/extensions/links v2/tsconfig.json v2/pnpm-lock.yaml
git commit -m "Links: the two URL grammars, and the patterns that claim them"
```

---

## Task 4: The Jira resolution chain

**Files:**
- Create: `v2/extensions/links/src/jira.ts`, `src/jira.test.ts`

**Interfaces:**
- Consumes: `parseLink`, `jiraLabel` from Task 3.
- Produces: `resolveJira(key: string, source: JiraSource, signal: AbortSignal): Promise<string | null>` returning the summary, or `null` when nothing answered. `JiraSource` is `{ process: ProcessAPI; secrets: SecretStore; fetch: typeof globalThis.fetch; email: string; site: string }`.

- [ ] **Step 1: Write the failing test**

`v2/extensions/links/src/jira.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { resolveJira } from './jira.ts';

const source = (over: Record<string, unknown> = {}) => ({
  process: { exec: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'not found' })) },
  secrets: { get: vi.fn(async () => undefined) },
  fetch: vi.fn(async () => new Response('{}', { status: 401 })),
  email: 'e@example.com',
  site: 'x.atlassian.net',
  ...over,
});

const live = () => new AbortController().signal;

describe('resolveJira', () => {
  it('takes the summary acli gives it, and asks nothing else', async () => {
    const src = source({
      process: {
        exec: vi.fn(async () => ({
          code: 0,
          stdout: JSON.stringify({ fields: { summary: 'Retry loop drops the last event' } }),
          stderr: '',
        })),
      },
    });
    expect(await resolveJira('SHEP-412', src, live())).toBe('Retry loop drops the last event');
    expect(src.fetch).not.toHaveBeenCalled();
    expect(src.secrets.get).not.toHaveBeenCalled();
  });

  it('probes the paths a GUI app’s PATH does not have before the bare name', async () => {
    // A GUI app inherits a minimal PATH, so `acli` is not on it. Same trap
    // github/src/token.ts documents for `gh`.
    const exec = vi.fn(async (bin: string) =>
      bin === '/opt/homebrew/bin/acli'
        ? { code: 0, stdout: JSON.stringify({ fields: { summary: 'ok' } }), stderr: '' }
        : { code: 127, stdout: '', stderr: 'no such file' },
    );
    const src = source({ process: { exec } });
    expect(await resolveJira('A-1', src, live())).toBe('ok');
    expect(exec.mock.calls[0]?.[0]).toBe('/opt/homebrew/bin/acli');
  });

  it('falls to the rest api when acli cannot answer and a token exists', async () => {
    const src = source({
      secrets: { get: vi.fn(async () => 'tok') },
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ fields: { summary: 'from rest' } }), { status: 200 }),
      ),
    });
    expect(await resolveJira('A-1', src, live())).toBe('from rest');
    const [url, init] = (src.fetch as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(String(url)).toBe('https://x.atlassian.net/rest/api/3/issue/A-1?fields=summary');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Basic ${btoa('e@example.com:tok')}`,
    });
  });

  it('gives up quietly when there is no token to fall back on', async () => {
    const src = source();
    expect(await resolveJira('A-1', src, live())).toBeNull();
    expect(src.fetch).not.toHaveBeenCalled();
  });

  it('gives up quietly when the token is rejected', async () => {
    const src = source({ secrets: { get: vi.fn(async () => 'tok') } });
    expect(await resolveJira('A-1', src, live())).toBeNull();
  });

  it('gives up on output whose shape it does not recognise, rather than throwing', async () => {
    // `acli --json` is not a contract. A shape change must not crash a paste.
    const src = source({
      process: { exec: vi.fn(async () => ({ code: 0, stdout: 'not json at all', stderr: '' })) },
    });
    expect(await resolveJira('A-1', src, live())).toBeNull();
  });

  it('stops when the deadline has already fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const src = source();
    expect(await resolveJira('A-1', src, controller.signal)).toBeNull();
    expect(src.process.exec).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd v2 && pnpm --filter @shepherd/ext-links test -- jira.test.ts`
Expected: FAIL, `resolveJira` is not exported.

- [ ] **Step 3: Implement `jira.ts`**

```ts
import type { ProcessAPI, SecretStore } from '@shepherd/sdk';
import { JIRA_TOKEN_SECRET_KEY } from './manifest.ts';

/**
 * Where a GUI app has to look, because its `PATH` is not a terminal's.
 *
 * The bare name last is the one that normally answers — the app harvests the
 * login shell's `PATH` at startup — and the explicit candidates stay for the
 * machine where that harvest found nothing. Copied from `github/src/token.ts`,
 * which measured this.
 */
const ACLI_CANDIDATES = ['/opt/homebrew/bin/acli', '/usr/local/bin/acli', 'acli'] as const;

export interface JiraSource {
  readonly process: Pick<ProcessAPI, 'exec'>;
  readonly secrets: Pick<SecretStore, 'get'>;
  readonly fetch: typeof globalThis.fetch;
  /** Whose token it is. Basic auth over an Atlassian API token wants the email. */
  readonly email: string;
  /** The host the URL named, so a second site does not need a second config. */
  readonly site: string;
}

/** `acli --json` is not a contract, so this reads rather than casts. */
function readSummary(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const fields = (parsed as { fields?: unknown } | null)?.fields;
  const summary = (fields as { summary?: unknown } | null)?.summary;
  return typeof summary === 'string' && summary !== '' ? summary : null;
}

async function fromAcli(
  key: string,
  source: JiraSource,
  signal: AbortSignal,
): Promise<string | null> {
  for (const bin of ACLI_CANDIDATES) {
    if (signal.aborted) return null;
    try {
      const run = await source.process.exec(bin, ['jira', 'workitem', 'view', key, '--fields', 'summary', '--json']);
      // A non-zero exit is the common case for the candidates that do not exist,
      // and is not worth a log line per paste.
      if (run.code !== 0) continue;
      const summary = readSummary(run.stdout);
      if (summary !== null) return summary;
    } catch {
      continue;
    }
  }
  return null;
}

async function fromRest(
  key: string,
  source: JiraSource,
  signal: AbortSignal,
): Promise<string | null> {
  const token = await source.secrets.get(JIRA_TOKEN_SECRET_KEY);
  if (token === undefined || token === '') return null;
  try {
    const answer = await source.fetch(
      `https://${source.site}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`,
      {
        signal,
        headers: {
          Authorization: `Basic ${btoa(`${source.email}:${token}`)}`,
          Accept: 'application/json',
        },
      },
    );
    if (!answer.ok) return null;
    return readSummary(await answer.text());
  } catch {
    return null;
  }
}

/**
 * The summary, or `null` for every way of not having one.
 *
 * `null` is a NORMAL answer, not an error: the pill already has its fallback
 * label on screen, and a person pasting a link into a brief did not ask this app
 * to authenticate them.
 */
export async function resolveJira(
  key: string,
  source: JiraSource,
  signal: AbortSignal,
): Promise<string | null> {
  if (signal.aborted) return null;
  const viaCli = await fromAcli(key, source, signal);
  if (viaCli !== null) return viaCli;
  if (signal.aborted) return null;
  return fromRest(key, source, signal);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd v2 && pnpm --filter @shepherd/ext-links test`
Expected: PASS. If `ProcessAPI.exec`'s real signature differs from `(bin, args)`, match the SDK and update the test's fake to the same shape rather than casting.

- [ ] **Step 5: Commit**

```bash
cd v2 && pnpm typecheck && pnpm lint
git add v2/extensions/links/src/jira.ts v2/extensions/links/src/jira.test.ts
git commit -m "Links: acli, then a token, then an honest nothing"
```

---

## Task 5: Activate `links` and register it

**Files:**
- Create: `v2/extensions/links/src/index.ts`, `src/index.test.ts`
- Modify: `v2/packages/app/src/ext-host/builtins.ts`, `v2/packages/app/src/main/index.ts`, `v2/packages/app/package.json`

**Interfaces:**
- Consumes: everything from Tasks 1, 3, 4.
- Produces: `activate` for `@shepherd/ext-links`, registered under `LINKS_ID`.

- [ ] **Step 1: Write the failing test**

`v2/extensions/links/src/index.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { activate } from './index.ts';

describe('the pasted-link provider', () => {
  it('warns and registers nothing when tasks defines no point', async () => {
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await activate(harness({ point: undefined, log }));
    expect(log.warn.mock.calls[0]?.[0]).toContain('tasks.pastedLink');
  });

  it('claims a slack permalink and labels it from the url alone', async () => {
    const registered = capture();
    await activate(harness({ point: registered.point }));
    const answer = await registered.provider().resolve(
      'https://x.slack.com/archives/C08ABCDEF/p1724500000123456',
      new AbortController().signal,
    );
    expect(answer).toEqual({ vendor: 'slack', label: 'Slack thread · 24 Aug', resolved: false });
  });

  it('labels a jira issue with what acli said', async () => {
    const registered = capture();
    await activate(
      harness({
        point: registered.point,
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({ fields: { summary: 'Retry loop drops the last event' } }),
          stderr: '',
        }),
      }),
    );
    const answer = await registered.provider().resolve(
      'https://x.atlassian.net/browse/SHEP-412',
      new AbortController().signal,
    );
    expect(answer).toEqual({
      vendor: 'jira',
      label: 'SHEP-412 Retry loop drops the last event',
      resolved: true,
    });
  });

  it('falls back to the bare key when nothing answered', async () => {
    const registered = capture();
    await activate(harness({ point: registered.point }));
    const answer = await registered.provider().resolve(
      'https://x.atlassian.net/browse/SHEP-412',
      new AbortController().signal,
    );
    expect(answer).toEqual({ vendor: 'jira', label: 'SHEP-412', resolved: false });
  });

  it('does not claim a url its grammar cannot read', async () => {
    const registered = capture();
    await activate(harness({ point: registered.point }));
    const answer = await registered.provider().resolve(
      'https://x.atlassian.net/wiki/spaces/ENG',
      new AbortController().signal,
    );
    expect(answer).toBeNull();
  });

  it('offers both vendors’ patterns', async () => {
    const registered = capture();
    await activate(harness({ point: registered.point }));
    expect(registered.provider().patterns).toEqual(LINK_PATTERNS);
  });
});
```

Write `harness()` and `capture()` as local helpers in the test file, modelled on `v2/extensions/worktree-hook/src/index.test.ts`: `harness` builds a fake `api.proposed` with `points.get` returning the given point, a fake `process.exec`, a fake `secrets.get` and a fake `log`; `capture` returns a point whose `register` stores the provider and a `provider()` accessor that throws if nothing registered.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd v2 && pnpm --filter @shepherd/ext-links test -- index.test.ts`
Expected: FAIL, `./index.ts` does not exist.

- [ ] **Step 3: Implement `index.ts`**

```ts
import type { ActivateFn } from '@shepherd/sdk';
import type { PastedLink, PastedLinkProvider } from '@shepherd/ext-tasks/manifest';
import { PASTED_LINK_POINT } from '@shepherd/ext-tasks/manifest';
import { LINK_PATTERNS, parseLink } from './parse.ts';
import { jiraLabel, slackLabel } from './label.ts';
import { resolveJira } from './jira.ts';

export const activate: ActivateFn = async (api, ctx) => {
  const { points, process: process_, secrets } = api.proposed;

  const point = points.get<PastedLinkProvider>(PASTED_LINK_POINT);
  if (point === undefined) {
    // The one branch that ends in "and then nothing happens", so it says why.
    ctx.log.warn(`nothing defines ${PASTED_LINK_POINT} — pasted links will stay as text`);
    return;
  }

  const resolve = async (url: string, signal: AbortSignal): Promise<PastedLink | null> => {
    const parsed = parseLink(url);
    if (parsed === null) return null;

    if (parsed.vendor === 'slack') {
      // No call, and none possible: reading a message needs a workspace app.
      // The date is in the permalink, so the label is a pure parse.
      return { vendor: 'slack', label: slackLabel(parsed.atMs), resolved: false };
    }

    const summary = await resolveJira(parsed.key, {
      process: process_,
      secrets,
      fetch: globalThis.fetch,
      email: ctx.userEmail ?? '',
      site: new URL(url).hostname,
    }, signal);

    return {
      vendor: 'jira',
      label: jiraLabel(parsed.key, summary ?? undefined),
      resolved: summary !== null,
    };
  };

  ctx.subscriptions.push(point.register({ patterns: LINK_PATTERNS, resolve }));
};
```

If `ctx` exposes no user email, take it from the same place `github/src/token.ts` gets `userName` and adjust `JiraSource.email` accordingly; the Basic-auth pair needs an account identifier and inventing one would fail with a 401 that reads like a bad token.

- [ ] **Step 4: Register the extension**

In `v2/packages/app/src/ext-host/builtins.ts`, add the import pair and the map entry:

```ts
import { activate as links } from '@shepherd/ext-links';
import { LINKS_ID } from '@shepherd/ext-links/manifest';
```

```ts
  [LINKS_ID, links],
```

In `v2/packages/app/src/main/index.ts`, import `linksManifest` from `@shepherd/ext-links/manifest` and add it to both manifest lists (the two sites near lines 1294 and 1334). Add `"@shepherd/ext-links": "workspace:*"` to `v2/packages/app/package.json` dependencies.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd v2 && pnpm install && pnpm --filter @shepherd/ext-links test && pnpm --filter @shepherd/app test`
Expected: PASS. `pnpm typecheck` must pass too; a missing project reference shows up only there.

- [ ] **Step 6: Commit**

```bash
cd v2 && pnpm typecheck && pnpm lint
git add v2/extensions/links v2/packages/app
git commit -m "Links: register the provider, and the extension with the app"
```

---

## Task 6: The vendor hues

Done before the composer so the pill has somewhere to land looking right the first time it appears.

**Files:**
- Modify: `v2/packages/ui/src/pill.css`
- Test: `v2/packages/ui/src/pill.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `.sh-ui-pill[data-link='jira']` and `.sh-ui-pill[data-link='slack']` rules.

- [ ] **Step 1: Write the failing test**

Append to `v2/packages/ui/src/pill.test.tsx`:

```ts
const linkRule = (vendor: string): CSSStyleRule => {
  const found = rulesMentioning('sh-ui-pill').find(
    (rule) => rule.selectorText === `.sh-ui-pill[data-link="${vendor}"]`,
  );
  if (!found) throw new Error(`no rule for data-link=${vendor}`);
  return found;
};

describe('a link pill', () => {
  /**
   * The whole colour design in one assertion. `fillAccent`, `lineAccent` and
   * `glintAccent` are all washes OF `sky`, so re-declaring `--sh-sky` on the
   * subtree retints the fill, the edge, the lit top and the glyph together — and
   * a rule that set `background` directly would retint one of the four.
   */
  it('retints by re-declaring the accent, not by painting a background', () => {
    for (const vendor of ['jira', 'slack']) {
      const rule = linkRule(vendor);
      expect(rule.style.getPropertyValue('--sh-sky')).not.toBe('');
      expect(rule.style.background, vendor).toBe('');
      expect(rule.style.backgroundColor, vendor).toBe('');
      expect(rule.style.borderTopColor, vendor).toBe('');
    }
  });

  /**
   * Mode has no selector in this app — it is only the VALUES at `:root` — so a
   * bare brand hex could not have a dark variant. Mixing the mode's own text
   * colour in is what makes one literal work on both wells.
   */
  it('adapts through the mode’s own text colour rather than a second literal', () => {
    for (const vendor of ['jira', 'slack']) {
      const mix = linkRule(vendor).style.getPropertyValue('--sh-sky');
      expect(mix, vendor).toContain('color-mix');
      expect(mix, vendor).toContain('var(--sh-text)');
    }
  });

  it('names each vendor’s own published hue and no other', () => {
    expect(linkRule('jira').style.getPropertyValue('--sh-sky')).toContain('#0052CC');
    expect(linkRule('slack').style.getPropertyValue('--sh-sky')).toContain('#4A154B');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd v2 && pnpm --filter @shepherd/ui test -- pill.test.tsx`
Expected: FAIL with "no rule for data-link=jira".

- [ ] **Step 3: Add the rules**

Append to `v2/packages/ui/src/pill.css`:

```css
/*
 * A link pill's vendor hue, and the one place in the kit a literal colour is
 * right.
 *
 * These are not theme colours and must not become roles: they are two vendors'
 * identity, they mean nothing anywhere else in the app, and a `sky` that could be
 * Jira blue would make the app's own live/focus/send signal unreadable. Tier 3,
 * declared beside its owner — the mechanism `styles.css` states and
 * `token-refs.css.test.ts` sanctions.
 *
 * Re-declaring `--sh-sky` rather than painting anything: the box above is three
 * washes of that one role and the glyph is the fourth, so this retints all four
 * at once and stays retinted if any of them changes. Painting `background` here
 * would leave the edge and the glyph behind.
 *
 * Mixed toward `--sh-text` because MODE HAS NO SELECTOR here — it is only the
 * values injected at `:root` — so a bare hex could not have a dark variant.
 * Mixing the mode's own ink in lifts aubergine off a near-black well and deepens
 * it on paper, from one literal. `send-button.css` does the same to `sky`.
 */
.sh-ui-pill[data-link='jira'] {
  --sh-sky: color-mix(in srgb, #0052CC 78%, var(--sh-text));
}

.sh-ui-pill[data-link='slack'] {
  --sh-sky: color-mix(in srgb, #4A154B 78%, var(--sh-text));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd v2 && pnpm --filter @shepherd/ui test && pnpm --filter @shepherd/app test -- token-refs`
Expected: PASS both. `token-refs.css.test.ts` must stay green; the declaration is in the sheet, which is the tier-3 source it allows.

- [ ] **Step 5: Check both hues against a real surface**

The 78% is a starting number, not a measured one. In a scratch test or a node one-liner, compute the sRGB mix of each hue with `palette.ink.dark` and `palette.ink.light`, then take `relativeLuminance` from `v2/packages/design-tokens/src/contrast.ts` against `palette.well.dark` (`#121212`) and `palette.well.light` (`#FFFFFF`). A glyph is a 1.5px stroke, so aim for a ratio of at least 3:1 on both. If aubergine misses on dark, raise the text share for `slack` only and say so in the comment; do not move Jira to match it.

- [ ] **Step 6: Commit**

```bash
cd v2 && pnpm typecheck && pnpm lint
git add v2/packages/ui/src/pill.css v2/packages/ui/src/pill.test.tsx
git commit -m "Pill: a vendor hue, by re-declaring the accent it already washes"
```

---

## Task 7: The composer pill

**Files:**
- Create: `v2/extensions/tasks/ui/link-paste.ts`, `ui/link-paste.test.ts`
- Modify: `v2/extensions/tasks/ui/composer.tsx`
- Test: `v2/extensions/tasks/ui/composer.test.tsx`

**Interfaces:**
- Consumes: `TASK_COMMANDS.linkPatterns`, `TASK_COMMANDS.resolveLink`, `PastedLinkPattern`, `PastedLink` (Task 1); `onPasteText` (Task 2); `data-link` rules (Task 6).
- Produces: `readPatterns(value: unknown): readonly PastedLinkPattern[]`, `readLink(value: unknown): PastedLink | null`, `claimsPaste(text, patterns): boolean`, `linkPill(url: string, id: string): HTMLElement`, `LINK_PILL_FALLBACK`.

- [ ] **Step 1: Write the failing unit test**

`v2/extensions/tasks/ui/link-paste.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { LINK_PILL_FALLBACK, claimsPaste, linkPill, readLink, readPatterns } from './link-paste.ts';

const PATTERNS = [
  { hostSuffix: '.atlassian.net', pathPrefix: '/browse/' },
  { hostSuffix: '.slack.com', pathPrefix: '/archives/' },
];

describe('claimsPaste', () => {
  it('claims a lone url that matches a pattern', () => {
    expect(claimsPaste('https://x.atlassian.net/browse/A-1', PATTERNS)).toBe(true);
  });

  it('leaves a url inside a sentence alone', () => {
    // Swallowing part of a paste would leave the rest of the sentence orphaned.
    expect(claimsPaste('see https://x.atlassian.net/browse/A-1 please', PATTERNS)).toBe(false);
  });

  it('leaves an unmatched url, and anything that is not a url, alone', () => {
    expect(claimsPaste('https://example.com/browse/A-1', PATTERNS)).toBe(false);
    expect(claimsPaste('C#', PATTERNS)).toBe(false);
  });

  it('claims nothing when it has no patterns yet', () => {
    // The answer may not have arrived. Paste has to keep working meanwhile.
    expect(claimsPaste('https://x.atlassian.net/browse/A-1', [])).toBe(false);
  });

  it('tolerates the whitespace a copied url arrives with', () => {
    expect(claimsPaste('  https://x.atlassian.net/browse/A-1\n', PATTERNS)).toBe(true);
  });
});

describe('linkPill', () => {
  it('carries the url as its token and the fallback as its label', () => {
    const pill = linkPill('https://x.atlassian.net/browse/A-1', 'l1');
    expect(pill.dataset['token']).toBe('https://x.atlassian.net/browse/A-1');
    expect(pill.textContent).toBe(LINK_PILL_FALLBACK);
    expect(pill.dataset['linkId']).toBe('l1');
    expect(pill.contentEditable).toBe('false');
  });

  it('is not tinted or marked until something says which vendor it is', () => {
    // data-link is what pill.css keys the hue off. Guessing from the hostname
    // here would put the vendor grammar in the renderer.
    expect(linkPill('https://x.atlassian.net/browse/A-1', 'l1').dataset['link']).toBeUndefined();
  });
});

describe('readLink', () => {
  it('reads a well-formed answer', () => {
    expect(readLink({ vendor: 'jira', label: 'A-1', resolved: false })).toEqual({
      vendor: 'jira',
      label: 'A-1',
      resolved: false,
    });
  });

  it('is null for a vendor it cannot draw', () => {
    // It crossed a port. `ok` says the call succeeded, not that the value has a
    // shape — and an unknown vendor must draw nothing rather than an untinted box.
    expect(readLink({ vendor: 'linear', label: 'X', resolved: true })).toBeNull();
    expect(readLink({ vendor: 'jira', label: '', resolved: true })).toBeNull();
    expect(readLink(null)).toBeNull();
    expect(readLink('nope')).toBeNull();
  });
});

describe('readPatterns', () => {
  it('keeps the entries that have both halves and drops the rest', () => {
    expect(
      readPatterns({
        patterns: [
          { hostSuffix: '.slack.com', pathPrefix: '/archives/' },
          { hostSuffix: '.x.com' },
          { pathPrefix: '/y/' },
          'nope',
        ],
      }),
    ).toEqual([{ hostSuffix: '.slack.com', pathPrefix: '/archives/' }]);
  });

  it('is empty for an answer of the wrong shape', () => {
    expect(readPatterns(null)).toEqual([]);
    expect(readPatterns({ patterns: 'no' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd v2 && pnpm --filter @shepherd/ext-tasks test -- link-paste.test.ts`
Expected: FAIL, `./link-paste.ts` does not exist.

- [ ] **Step 3: Implement `link-paste.ts`**

```ts
import type { PastedLink, PastedLinkPattern } from '../src/manifest.ts';

/**
 * What a link pill says before anything has answered.
 *
 * Deliberately vendor-free: the renderer does not know the grammars, so at insert
 * time all it knows is that some provider claimed this URL. The vendor arrives
 * with the label, and until then a pill that guessed would guess wrong for every
 * vendor added later.
 */
export const LINK_PILL_FALLBACK = 'Link';

const lone = (text: string): string | null => {
  const trimmed = text.trim();
  return trimmed === '' || /\s/.test(trimmed) ? null : trimmed;
};

const asUrl = (text: string): URL | null => {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
};

/**
 * Should this paste be swallowed?
 *
 * A LONE url only. Swallowing a url out of the middle of a sentence would leave
 * the rest of the sentence orphaned, and the person pasting a sentence was
 * pasting a sentence.
 *
 * Narrow on purpose beyond that too: `PromptField` notes that letting a text
 * paste through the browser is what keeps undo intact, so the set of pastes that
 * give that up should be the smallest the feature needs.
 */
export function claimsPaste(text: string, patterns: readonly PastedLinkPattern[]): boolean {
  const single = lone(text);
  if (single === null) return false;
  const url = asUrl(single);
  if (url === null) return false;
  return patterns.some(
    (pattern) =>
      url.hostname.endsWith(pattern.hostSuffix) &&
      url.pathname.startsWith(pattern.pathPrefix) &&
      (pattern.query === undefined || url.searchParams.has(pattern.query)),
  );
}

/**
 * The pill, built as a DOM node for the reason `repoPill` and `imagePill` are:
 * React does not own the editor's subtree.
 *
 * `data-token` is the URL and is never rewritten. A resolved summary substituted
 * here would put text written in another system into the prompt an agent reads,
 * and would make the same paste submit differently depending on whether a
 * subprocess answered in time.
 */
export function linkPill(url: string, id: string): HTMLElement {
  const pill = document.createElement('span');
  pill.className = 'sh-ui-pill sh-composer-link-pill';
  pill.contentEditable = 'false';
  pill.dataset['token'] = url;
  pill.dataset['linkId'] = id;
  pill.title = url;
  pill.append(LINK_PILL_FALLBACK);
  return pill;
}

const VENDOR_GLYPHS: Readonly<Record<PastedLink['vendor'], string>> = {
  /*
   * Hand-rolled at 14px with the kit's stroke, because the icon package cannot be
   * reached from an extension (`boundaries.js`) and `repoPill` and `imagePill`
   * already draw theirs this way. Replace the paths with each vendor's published
   * mark, simplified to a single stroke: a four-colour Slack logo is mush at 14px.
   */
  jira: '<path d="M12 3 21 12l-9 9-9-9z"/>',
  slack: '<path d="M9 3v9M15 12v9M3 15h9M12 9h9"/>',
};

/**
 * Fill in what a pill IS, once something has said.
 *
 * The label and the mark, never the token. Keyed to the NODE by the caller rather
 * than to a document position, because the person keeps typing while the answer
 * is in flight.
 */
export function dressPill(pill: HTMLElement, link: PastedLink): void {
  pill.dataset['link'] = link.vendor;
  pill.replaceChildren();
  pill.insertAdjacentHTML(
    'afterbegin',
    '<svg class="sh-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
      `stroke-linejoin="round" aria-hidden="true">${VENDOR_GLYPHS[link.vendor]}</svg>`,
  );
  pill.append(link.label);
}

/** The answer to `tasks.linkPatterns`, read rather than cast. */
export function readPatterns(value: unknown): readonly PastedLinkPattern[] {
  const rows = (value as { patterns?: unknown } | null)?.patterns;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((entry: unknown): PastedLinkPattern[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { hostSuffix, pathPrefix, query } = entry as {
      hostSuffix?: unknown;
      pathPrefix?: unknown;
      query?: unknown;
    };
    if (typeof hostSuffix !== 'string' || hostSuffix === '') return [];
    if (typeof pathPrefix !== 'string' || pathPrefix === '') return [];
    return [
      typeof query === 'string' && query !== ''
        ? { hostSuffix, pathPrefix, query }
        : { hostSuffix, pathPrefix },
    ];
  });
}

/** The answer to `tasks.resolveLink`, read rather than cast. */
export function readLink(value: unknown): PastedLink | null {
  if (typeof value !== 'object' || value === null) return null;
  const { vendor, label, resolved } = value as {
    vendor?: unknown;
    label?: unknown;
    resolved?: unknown;
  };
  if (vendor !== 'jira' && vendor !== 'slack') return null;
  if (typeof label !== 'string' || label === '') return null;
  return { vendor, label, resolved: resolved === true };
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `cd v2 && pnpm --filter @shepherd/ext-tasks test -- link-paste.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing composer test**

Append to `v2/extensions/tasks/ui/composer.test.tsx`, using the file's existing mount helper and its fake `invoke`. The fake must answer `tasks.linkPatterns` with the two patterns and `tasks.resolveLink` with whatever each case needs.

```tsx
describe('a pasted link', () => {
  const JIRA = 'https://x.atlassian.net/browse/SHEP-412';

  it('becomes one atomic pill whose token is the url', async () => {
    const h = await open({ resolveLink: { vendor: 'jira', label: 'SHEP-412 Retry loop', resolved: true } });
    await h.pasteText(JIRA);
    const pill = h.field().querySelector<HTMLElement>('.sh-composer-link-pill')!;
    expect(pill.dataset['token']).toBe(JIRA);
    expect(h.value()).toBe(JIRA);
  });

  it('swaps the label in when the answer lands, and leaves the token alone', async () => {
    const h = await open({ resolveLink: { vendor: 'jira', label: 'SHEP-412 Retry loop', resolved: true } });
    await h.pasteText(JIRA);
    await h.settle();
    const pill = h.field().querySelector<HTMLElement>('.sh-composer-link-pill')!;
    expect(pill.textContent).toBe('SHEP-412 Retry loop');
    expect(pill.dataset['link']).toBe('jira');
    // The brief the agent reads did not change when the label did.
    expect(h.value()).toBe(JIRA);
  });

  it('keeps its fallback label when nothing answers', async () => {
    const h = await open({ resolveLink: null });
    await h.pasteText(JIRA);
    await h.settle();
    const pill = h.field().querySelector<HTMLElement>('.sh-composer-link-pill')!;
    expect(pill.textContent).toBe('Link');
    expect(h.value()).toBe(JIRA);
  });

  it('drops an answer whose pill has been deleted', async () => {
    const h = await open({ resolveLink: { vendor: 'jira', label: 'SHEP-412', resolved: true } });
    await h.pasteText(JIRA);
    h.field().querySelector('.sh-composer-link-pill')!.remove();
    // The guard the picker already has: an answer for a node that is gone must
    // not be written to whatever is now at that position.
    await expect(h.settle()).resolves.not.toThrow();
    expect(h.field().textContent).not.toContain('SHEP-412');
  });

  it('pastes a url no pattern claims as ordinary text', async () => {
    const h = await open({});
    await h.pasteText('https://example.com/x');
    expect(h.field().querySelector('.sh-composer-link-pill')).toBeNull();
    expect(h.value()).toBe('https://example.com/x');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd v2 && pnpm --filter @shepherd/ext-tasks test -- composer.test.tsx`
Expected: FAIL. No pill is created; the URL pastes as text.

- [ ] **Step 7: Wire the composer**

In `v2/extensions/tasks/ui/composer.tsx`, import from `./link-paste.ts`, then add beside the other refs:

```tsx
  /**
   * Which URLs to swallow, asked when the composer OPENS rather than once on
   * mount. The machine list gets away with mount-time caching because a
   * gone-away machine is caught where it matters, when `tasks.create` forwards to
   * it. A stale paste rule has no such catch: it silently changes what Cmd-V
   * does, so it is re-read every time this card comes up.
   */
  const patterns = useRef<readonly PastedLinkPattern[]>([]);
  /** Rising, so a pill node can be found again after the caret has moved on. */
  const linkSeq = useRef(0);
```

An effect keyed on `open`:

```tsx
  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      const answer = await invoke(TASK_COMMANDS.linkPatterns, {});
      if (!live || !answer.ok) return;
      patterns.current = readPatterns(answer.value);
    })();
    return () => {
      live = false;
    };
  }, [open, invoke]);
```

Replace `open` in that effect with whatever prop tells this component the card is showing; if there is none, keep the mount effect and add a re-read in the same place the composer already resets on `done()`.

Then on `PromptField`:

```tsx
          /*
            A pasted Jira or Slack URL becomes a Pill where it was pasted. The
            pill goes in IMMEDIATELY with its fallback label and the token already
            correct, and the label fills in behind it: `acli` is a subprocess and
            a composer that stalled on paste would be worse than a label that
            arrives a beat later.
          */
          onPasteText={(text) => {
            const url = text.trim();
            if (!claimsPaste(url, patterns.current)) return false;
            const id = `link-${(linkSeq.current += 1)}`;
            promptRef.current?.insert(linkPill(url, id), { trailing: " " });
            void (async () => {
              const answer = await invoke(TASK_COMMANDS.resolveLink, { url });
              if (!answer.ok) return;
              const link = readLink(answer.value);
              if (link === null) return;
              // Keyed to the NODE, not to a position: the person kept typing
              // while this was in flight, and a pill they deleted must not be
              // resurrected over whatever is there now.
              const pill = card.current?.querySelector<HTMLElement>(`[data-link-id="${id}"]`);
              if (pill === null || pill === undefined) return;
              dressPill(pill, link);
            })();
            return true;
          }}
```

- [ ] **Step 8: Run the whole package's tests**

Run: `cd v2 && pnpm --filter @shepherd/ext-tasks test`
Expected: PASS, including every pre-existing composer case. The `#repo` picker tests are the ones to watch: the new handler must not fire for a `#` mention or an ordinary paste.

- [ ] **Step 9: Commit**

```bash
cd v2 && pnpm typecheck && pnpm lint
git add v2/extensions/tasks/ui
git commit -m "Composer: a pasted Jira or Slack link becomes a pill"
```

---

## Task 8: See it work

The tests cover the rules. This covers the thing tests cannot: whether the hues read correctly on a real screen at a real size.

**Files:** none.

- [ ] **Step 1: Run the app**

Run: `cd v2 && pnpm dev`

- [ ] **Step 2: Paste a real Jira URL into a new task's brief**

Use an issue that exists on `browserstack.atlassian.net`. Expected: a pill appears immediately reading `Link`, then within a few seconds becomes the key and summary, tinted Jira blue with the mark. Check the summary matches the issue.

- [ ] **Step 3: Paste a real Slack permalink**

Expected: a pill reading `Slack thread · <date>` in aubergine, immediately, with no delay. Check the date matches the message.

- [ ] **Step 4: Check both hues in both themes**

Switch the app between light and dark. Expected: the glyph stays legible in both and neither pill reads as the app's own focus blue. If aubergine is muddy on dark, this is the moment Task 6 Step 5's number gets revisited.

- [ ] **Step 5: Check the three things that must not have changed**

Paste an image (still a pill). Paste a sentence containing a URL (stays text, whole sentence intact). Type `#` and pick a repo (picker still works, pill still atomic). Then undo a few times over a link paste and confirm the field does not end up in a state the caret cannot leave.

- [ ] **Step 6: Create the task and read the brief**

Expected: the brief `tasks.create` receives contains the raw URL where the pill was, and no issue summary anywhere in it.

---

## Self-review notes

**Spec coverage.** Colour → Task 6. Extension and permissions → Tasks 3, 5. Point and patterns → Task 1. Parsing → Task 3. Jira chain and deadline → Tasks 1 (deadline), 4 (chain). Slack → Tasks 3 (label), 5 (provider). Pill and late fill-in → Tasks 2, 7. Token → Task 7. Testing section → distributed across every task. Considered-and-declined → nothing to implement.

**Two things the plan resolves that the spec left implicit.** The fallback label at INSERT time cannot be vendor-specific, because the renderer does not know the grammars and only learns the vendor when the answer lands; `LINK_PILL_FALLBACK` is therefore `Link`, and the spec's `Jira task` / `Slack thread · date` are what the provider returns. And `claimsPaste` requires a LONE URL, which the spec did not say: swallowing a URL out of the middle of a pasted sentence would orphan the rest of it.

**Known soft spots for the implementer.** `ProcessAPI.exec`'s real signature may not be `(bin, args)`; match the SDK. `ctx.userEmail` may not exist, and Basic auth needs an account identifier. The vendor SVG paths are placeholders shaped correctly, not the real marks. And the `open` prop the pattern effect keys on may be named something else in this component.
