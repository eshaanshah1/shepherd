# Extensible Settings View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full-window settings screen in Shepherd v2 that holds the app's own settings (theme, version) and into which any extension contributes its own settings pages, declared statically in its manifest.

**Architecture:** Three layers, each testable alone. (1) A **registry + store** in `@shepherd/core`: settings pages come off manifests, values live in the existing SQLite KV under a `settings` namespace, and only non-default values are stored. (2) A **takeover layer** in the renderer, painted over `.sh-body` with every pane left mounted underneath, whose open/closed state is owned by main (so the menu, the palette, the CLI and Esc all move one variable) and which feeds `ViewingResolver`'s existing `presence.overlay` input. (3) **Two built-in consumers** — `agents-core` (schema-driven, dynamic enum) and `worktree-hook` (the component escape hatch) — because §7 requires built-ins to be the proving ground for a proposed API.

**Spec:** [`docs/superpowers/specs/2026-08-11-settings-view-design.md`](../specs/2026-08-11-settings-view-design.md). Read it before Task 1; every "why" below is short because that file is long.

**Tech Stack:** TypeScript (node type-stripping — see constraints), Electron, React 19, `node:sqlite`, vitest, the repo's own `s.` schema combinators (`@shepherd/sdk/schema.ts`), `@shepherd/ui` primitives.

## Global Constraints

- **Every command runs from `v2/` and takes `env -u NODE_OPTIONS`.** An ambient `NODE_OPTIONS` makes Electron exit 9 before a line of our code runs, and the symptom is every check failing at once with no output to explain why.
- **The gate for any task:** `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`. Tasks that touch the app shell, layout or an extension's contributions also run `env -u NODE_OPTIONS pnpm smoke:m3`.
- **No parameter properties, ever.** Electron runs our `.ts` on node's type stripping, which can only erase. `constructor(readonly x: string)` is a launch failure; `erasableSyntaxOnly` makes it a typecheck error. Declare the field, assign in the body.
- **Nothing may call `Date.now()`** in extension or core code — time is injected (`ctx.clock`, `Clock`).
- **`tooling/eslint/boundaries.js` IS the architecture diagram.** No new import edge without a line there and the reason in that line's comment. Specifically: an extension may import `@shepherd/sdk` and `@shepherd/ui` and nothing else; the renderer may import `@shepherd/ext-*/ui` and never an extension's root; the extension host (`packages/app/src/ext-host/**`, `extensions/**`) may not import `@shepherd/core`, `node:os` or `node:child_process`.
- **A colour never appears in a stylesheet or a component.** Every rule reads a `--sh-*` role token. A component paints in roles (`--sh-accent`), never a hue.
- **Do not hand-roll a control.** Use `@shepherd/ui`. Task 5 adds the two primitives this feature needs, because they do not exist yet.
- **A working indicator is the braille spinner** (`useBrailleFrame`). Pulses and shimmer are banned.
- **An extension never names a vendor.** No `claudeCode.*` string in `agents-core`, in core, in the shell or in a setting key outside `claude-code` itself.
- **Answers from a command are `unknown`, and a cast is not a check.** Parse with a schema.
- **A built-in's typed manifest and the `shepherd` key of its `package.json` must be field-for-field equal** — each extension has a `manifest.test.ts` asserting it. Editing one means editing both.
- **Commit after every task**, with the message shown in that task's last step.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `packages/sdk/src/api-settings.ts` | The types: `SettingSpec`, `SettingsPage`, `SettingsAPI`, `SettingsError`. Types only — no logic. |
| `packages/sdk/src/settings.ts` | Pure logic every layer shares: `namespaceOf`, `validateSetting`, `pageIssues`, `defaultsOf`. |
| `packages/sdk/src/settings.test.ts` | Its tests. |
| `packages/core/src/settings/registry.ts` | `SettingsRegistry`: holds pages, resolves effective values, reads/writes the KV, fires per-key changes. |
| `packages/core/src/settings/index.ts` | The subsystem's barrel, re-exported by `packages/core/src/index.ts`. |
| `packages/core/src/settings/registry.test.ts` | Its tests, against `':memory:'`. |
| `packages/app/src/main/settings-commands.ts` | The `settings.*` kernel commands + the `settings.changed` bus publish. |
| `packages/app/src/main/settings-commands.test.ts` | Its tests. |
| `packages/app/src/main/settings-visibility.ts` | Who owns "settings is open": the `window.settings` command, the presence input, the renderer notification. |
| `packages/app/src/main/settings-visibility.test.ts` | Its tests. |
| `packages/app/src/main/settings-ipc.ts` | The renderer's channels: list, set, reset, and the changed/visibility pushes. |
| `packages/app/src/main/settings-general.ts` | The app's own page — `shepherd.theme` — as a `SettingsPage` owned by the kernel. |
| `packages/ui/src/switch.tsx` + `switch.css` + `switch.test.tsx` | The boolean control. |
| `packages/ui/src/select.tsx` + `select.css` + `select.test.tsx` | The one-of-N control. |
| `packages/app/src/renderer/settings-screen.tsx` | The frame: nav, heading, back, page area, Esc. |
| `packages/app/src/renderer/settings-screen.test.tsx` | Its tests. |
| `packages/app/src/renderer/settings-rows.tsx` | One spec → one row. The only file that knows a `type` maps to a control. |
| `packages/app/src/renderer/settings-rows.test.tsx` | Its tests. |
| `packages/app/src/renderer/settings-filter.ts` | Pure: the search filter over pages. |
| `packages/app/src/renderer/settings-filter.test.ts` | Its tests. |
| `packages/app/src/renderer/settings.css` | The frame's styles, `@import`ed by `styles.css`. |

**Modified:**

| File | Change |
| --- | --- |
| `packages/sdk/src/manifest.ts:64` (`contributes`) and its `manifestSchema` | `settings?: readonly SettingsPage[]`, in the type and the wire schema. |
| `packages/sdk/src/permission.ts:10` (`PERMISSIONS`) | Add `'settings'`. |
| `packages/sdk/src/api.ts:100` (`ProposedAPI`) | Add `readonly settings: SettingsAPI`. |
| `packages/sdk/src/index.ts` | Export the new types and pure helpers. |
| `packages/core/src/index.ts:153` area | Export the settings subsystem. |
| `packages/app/src/shared/ext-protocol.ts:312` (activate ask) | Add `settings: s.record(s.unknown())` — the seed. |
| `packages/app/src/shared/channels.ts` | `INVOKE.settingsList/settingsSet/settingsReset`, `EMIT.settingsChanged/settingsVisibility`. |
| `packages/app/src/shared/bridge.ts:183` area | `SettingsApi` + `SettingsPageDTO`. |
| `packages/app/src/shared/commands.ts` + `menu-commands.ts` | `COMMANDS.openSettings` → the `window.settings` kernel command. |
| `packages/app/src/preload/api.ts:92` area | The `settings` bridge group. |
| `packages/app/src/main/menu-template.ts:41` (app submenu) | `Settings…`, `CmdOrCtrl+,`. |
| `packages/app/src/main/index.ts:425,442,1023` | Construct the registry, register the commands, make `syncPresence` read the takeover flag. |
| `packages/app/src/main/ext-host.ts` | Seed each extension's settings into its `activate` ask; register its manifest pages. |
| `packages/app/src/ext-host/api.ts:192,800` | `createSettings`, and it in `ProposedAPI`. |
| `packages/app/src/renderer/app.tsx:212,531` | ⌘, , the visibility subscription, `<SettingsScreen/>`. |
| `packages/app/src/renderer/theme.ts:16` | `DEFAULT_THEME_MODE` becomes the pre-subscription fallback; add `resolveThemeMode`. |
| `packages/app/src/renderer/pane-sessions.ts:109` (`PaneTerminals`) | `retheme(mode)`. |
| `packages/app/src/renderer/xterm-terminal.ts:31` | A terminal can be re-themed after construction. |
| `packages/ui/src/index.ts`, `styles.css`, `package.json` | The two primitives. |
| `extensions/agents-core/src/{manifest.ts,index.ts,quick-model.ts}` + `package.json` | The `agents.models` page; read/write through settings; migrate `QUICK_MODEL_KEY`. |
| `extensions/worktree-hook/src/{manifest.ts,index.ts}` + `package.json` | Drop the overlay; contribute a component page. |
| `packages/app/src/main/smoke-m3.ts` | The end-to-end assertions. |

---

### Task 1: The settings vocabulary (SDK)

Types and pure logic, in the one package every layer may import. Nothing user-visible.

**Files:**
- Create: `packages/sdk/src/api-settings.ts`, `packages/sdk/src/settings.ts`, `packages/sdk/src/settings.test.ts`
- Modify: `packages/sdk/src/manifest.ts` (the `contributes` type at :64 and `manifestSchema` below it), `packages/sdk/src/permission.ts:10`, `packages/sdk/src/api.ts:100`, `packages/sdk/src/index.ts`

**Interfaces:**
- Consumes: `s`, `Schema`, `Infer` from `./schema.ts`; `Disposable` from `./disposable.ts`; `Result` from `./result.ts`.
- Produces: `SettingType`, `SettingValue`, `SettingSpec`, `SettingsPage`, `SettingsAPI`, `SettingsError`, `settingsPageSchema`, `namespaceOf(extensionId)`, `validateSetting(spec, value)`, `pageIssues(page, namespace)`, `defaultsOf(pages)`. Every later task uses these names verbatim.

- [ ] **Step 1: Write the failing test**

`packages/sdk/src/settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { namespaceOf, validateSetting, pageIssues, defaultsOf } from './settings.ts';
import type { SettingSpec, SettingsPage } from './api-settings.ts';

const spec = (over: Partial<SettingSpec> = {}): SettingSpec => ({
  key: 'agents.quickModel',
  type: 'string',
  label: 'Quick-tier model',
  default: 'sonnet',
  ...over,
});

describe('namespaceOf', () => {
  it('is the last dotted segment of an extension id', () => {
    expect(namespaceOf('shepherd.agents-core')).toBe('agents-core');
    expect(namespaceOf('shepherd.tasks')).toBe('tasks');
  });

  it('is the whole id when it has no dot', () => {
    expect(namespaceOf('tasks')).toBe('tasks');
  });
});

describe('validateSetting', () => {
  it('accepts a value of the declared type', () => {
    expect(validateSetting(spec(), 'opus')).toEqual({ ok: true, value: 'opus' });
  });

  it('refuses the wrong type, naming both', () => {
    const result = validateSetting(spec({ type: 'number', default: 1 }), 'two');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('expected number');
  });

  it('refuses an enum value that is not one of the choices', () => {
    const enumSpec = spec({
      type: 'enum',
      default: 'dark',
      choices: [
        { value: 'dark', label: 'Dark' },
        { value: 'light', label: 'Light' },
      ],
    });
    expect(validateSetting(enumSpec, 'sepia').ok).toBe(false);
    expect(validateSetting(enumSpec, 'light').ok).toBe(true);
  });

  it('cannot check an enum whose choices are dynamic, and says so by accepting any string', () => {
    // `choicesFrom` resolves in another process at page-open time. Refusing
    // here would make every dynamic setting unwritable.
    const dynamic = spec({ type: 'enum', default: null, nullable: true, choicesFrom: 'agents.kinds' });
    expect(validateSetting(dynamic, 'anything').ok).toBe(true);
  });

  it('accepts null only for a nullable spec', () => {
    expect(validateSetting(spec({ nullable: true, default: null }), null).ok).toBe(true);
    expect(validateSetting(spec(), null).ok).toBe(false);
  });

  it('enforces number bounds', () => {
    const bounded = spec({ type: 'number', default: 10, min: 1, max: 20 });
    expect(validateSetting(bounded, 0).ok).toBe(false);
    expect(validateSetting(bounded, 21).ok).toBe(false);
    expect(validateSetting(bounded, 20).ok).toBe(true);
  });
});

describe('pageIssues', () => {
  const page = (settings: readonly SettingSpec[]): SettingsPage => ({
    id: 'agents.models',
    title: 'Models',
    settings,
  });

  it('passes a page whose keys all sit in the declaring namespace', () => {
    expect(pageIssues(page([spec({ key: 'agents-core.quickModel' })]), 'agents-core')).toEqual([]);
  });

  it('rejects a key outside the namespace, naming the extension and the key', () => {
    const issues = pageIssues(page([spec({ key: 'claudeCode.model' })]), 'agents-core');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('claudeCode.model');
    expect(issues[0]).toContain('agents-core');
  });

  it('rejects a duplicate key within one page', () => {
    const issues = pageIssues(page([spec({ key: 'agents-core.a' }), spec({ key: 'agents-core.a' })]), 'agents-core');
    expect(issues.some((issue) => issue.includes('declared twice'))).toBe(true);
  });

  it('rejects a default its own spec would refuse', () => {
    const issues = pageIssues(page([spec({ key: 'agents-core.n', type: 'number', default: 'ten' })]), 'agents-core');
    expect(issues.some((issue) => issue.includes('default'))).toBe(true);
  });

  it('passes a component page, which declares no keys at all', () => {
    expect(pageIssues({ id: 'w.editor', title: 'Hooks', component: 'worktree-hook.editor' }, 'worktree-hook')).toEqual(
      [],
    );
  });
});

describe('defaultsOf', () => {
  it('maps every declared key to its default, component pages contributing none', () => {
    expect(
      defaultsOf([
        { id: 'p', title: 'P', settings: [spec({ key: 'a.one', default: 1, type: 'number' })] },
        { id: 'q', title: 'Q', component: 'x.y' },
      ]),
    ).toEqual({ 'a.one': 1 });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/sdk test settings`
Expected: FAIL — cannot resolve `./settings.ts` / `./api-settings.ts`.

- [ ] **Step 3: Write the types**

`packages/sdk/src/api-settings.ts`:

```ts
import { s, type Infer } from './schema.ts';
import type { Disposable } from './disposable.ts';
import type { Result } from './result.ts';
import type { Schema } from './schema.ts';

/**
 * Settings (spec 2026-08-11) — declared in a manifest, held by the kernel.
 *
 * The set of types is deliberately small. A widget kind is a promise the shell
 * has to keep in both themes and at every width, and `SettingsPage.component`
 * is what covers everything that is not a value you pick — see §1.2 of the
 * spec, and `worktree-hook`, whose script editor is a small application.
 */
export const SETTING_TYPES = ['boolean', 'string', 'number', 'enum', 'path'] as const;
export type SettingType = (typeof SETTING_TYPES)[number];

/** What can be stored. `null` only where the spec is `nullable`. */
export type SettingValue = boolean | string | number | null;

export interface SettingChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface SettingSpec {
  /** Namespaced to the declaring extension: `agents-core.quickModel`. */
  readonly key: string;
  readonly type: SettingType;
  readonly label: string;
  readonly description?: string;
  readonly default: SettingValue;
  /**
   * Whether "unset" is itself a value.
   *
   * `agents-core.quickKind` is why: its unset state is not a missing value but a
   * meaning — "whichever capable kind is first" — that only the extension can
   * compute. A nullable spec draws an explicit *Default* choice and accepts
   * `null`; every other spec refuses it.
   */
  readonly nullable?: boolean;
  /** For `enum`, when the options are known at build time. */
  readonly choices?: readonly SettingChoice[];
  /**
   * For `enum`, when they are not: a command id answering `SettingChoice[]`,
   * invoked when the page is opened.
   *
   * The honest answer to "which models can I pick" lives in the vendor's
   * extension and changes without a release. A spec with this cannot be checked
   * against a list here — see `validateSetting`.
   */
  readonly choicesFrom?: string;
  /** A heading above this row, grouping it with its neighbours. */
  readonly group?: string;
  readonly placeholder?: string;
  readonly min?: number;
  readonly max?: number;
}

/**
 * One entry in the settings screen's nav.
 *
 * Either `settings` (rows the shell draws) or `component` (ADR 0033: a name the
 * renderer resolves). A page with both is a page that would draw twice, and
 * `pageIssues` refuses it.
 */
export interface SettingsPage {
  readonly id: string;
  readonly title: string;
  /** Lower sorts first. Absent sorts after every page that declared one. */
  readonly order?: number;
  readonly settings?: readonly SettingSpec[];
  readonly component?: string;
}

export interface SettingsError {
  readonly code: 'unknown-key' | 'invalid-value' | 'denied';
  readonly message: string;
}

/**
 * What an extension is handed as `api.proposed.settings`.
 *
 * `get` is synchronous and cannot answer `undefined`: the declared default backs
 * every read, so an extension that declared a setting always has a value and
 * every "what if it is unset" branch disappears. It takes a `Schema<T>` for the
 * reason `KV.get` does — the value crossed a port, and a cast is not a check.
 */
export interface SettingsAPI {
  get<T>(key: string, schema: Schema<T>): T;
  set(key: string, value: SettingValue): Promise<Result<void, SettingsError>>;
  onDidChange(fn: (key: string, value: SettingValue) => void): Disposable;
}

const settingChoiceSchema = s.object({
  value: s.string(),
  label: s.string(),
  description: s.optional(s.string()),
});

const settingValueSchema = s.union(s.boolean(), s.string(), s.number(), s.nullValue());

export const settingSpecSchema = s.object({
  key: s.string(),
  type: s.enumOf(SETTING_TYPES),
  label: s.string(),
  description: s.optional(s.string()),
  default: settingValueSchema,
  nullable: s.optional(s.boolean()),
  choices: s.optional(s.array(settingChoiceSchema)),
  choicesFrom: s.optional(s.string()),
  group: s.optional(s.string()),
  placeholder: s.optional(s.string()),
  min: s.optional(s.number()),
  max: s.optional(s.number()),
});

export const settingsPageSchema = s.object({
  id: s.string(),
  title: s.string(),
  order: s.optional(s.number()),
  settings: s.optional(s.array(settingSpecSchema)),
  component: s.optional(s.string()),
});

export type SettingsPageWire = Infer<typeof settingsPageSchema>;
export { settingValueSchema };
```

If `s.nullValue()` is not the exported name for the null combinator, read `packages/sdk/src/schema.ts` around line 119 and use whatever that literal-null schema is called; do not add a second one.

- [ ] **Step 4: Write the pure logic**

`packages/sdk/src/settings.ts`:

```ts
import { ok, err, type Result } from './result.ts';
import type { SettingSpec, SettingValue, SettingsError, SettingsPage } from './api-settings.ts';

/**
 * The namespace an extension owns, derived from its manifest id by the host.
 *
 * The extension never states it. `PointsAPI.define` fills in `owner` from the
 * host's own word for the same reason: a namespace an extension could claim
 * about itself is not a fact, and the access gate above it would be a claim.
 */
export function namespaceOf(extensionId: string): string {
  const at = extensionId.lastIndexOf('.');
  return at === -1 ? extensionId : extensionId.slice(at + 1);
}

/** The kernel's own namespace. Readable by every extension, writable by none. */
export const CORE_NAMESPACE = 'shepherd';

export function validateSetting(spec: SettingSpec, value: unknown): Result<SettingValue, SettingsError> {
  const refuse = (message: string): Result<SettingValue, SettingsError> =>
    err({ code: 'invalid-value', message: `${spec.key}: ${message}` });

  if (value === null) {
    return spec.nullable === true ? ok(null) : refuse('is not nullable, so null is not a value it can hold');
  }

  switch (spec.type) {
    case 'boolean':
      return typeof value === 'boolean' ? ok(value) : refuse(`expected boolean, got ${typeof value}`);
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return refuse(`expected number, got ${typeof value}`);
      }
      if (spec.min !== undefined && value < spec.min) return refuse(`must be at least ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) return refuse(`must be at most ${spec.max}`);
      return ok(value);
    }
    case 'string':
    case 'path':
      return typeof value === 'string' ? ok(value) : refuse(`expected string, got ${typeof value}`);
    case 'enum': {
      if (typeof value !== 'string') return refuse(`expected string, got ${typeof value}`);
      /**
       * A `choicesFrom` spec is checked for TYPE and nothing else, deliberately.
       *
       * Its options are resolved by a command in another process when the page
       * opens; there is no list here to check against, and refusing what we
       * cannot verify would make every dynamic setting unwritable. The vendor's
       * own command is what rejects a stale id when it is next used.
       */
      if (spec.choices === undefined) return ok(value);
      return spec.choices.some((choice) => choice.value === value)
        ? ok(value)
        : refuse(`must be one of ${spec.choices.map((choice) => choice.value).join(', ')}`);
    }
  }
}

/**
 * Everything wrong with a contributed page, as sentences a user can act on.
 *
 * A list rather than a throw: a manifest can be wrong in several ways at once,
 * and reporting the first one makes fixing a page an iterative guess.
 */
export function pageIssues(page: SettingsPage, namespace: string): string[] {
  const issues: string[] = [];
  const where = `settings page "${page.id}"`;

  if (page.settings !== undefined && page.component !== undefined) {
    issues.push(`${where} declares both \`settings\` and \`component\`; a page is one or the other`);
  }
  if (page.settings === undefined && page.component === undefined) {
    issues.push(`${where} declares neither \`settings\` nor \`component\`, so it would draw nothing`);
  }

  const seen = new Set<string>();
  for (const spec of page.settings ?? []) {
    if (namespaceOf(spec.key) === spec.key || !spec.key.startsWith(`${namespace}.`)) {
      issues.push(
        `${where}: "${spec.key}" is outside the namespace "${namespace}" that ${namespace} owns. ` +
          `A setting key must be \`${namespace}.<name>\` — an extension configures itself, not its neighbours.`,
      );
    }
    if (seen.has(spec.key)) issues.push(`${where}: "${spec.key}" is declared twice`);
    seen.add(spec.key);

    if (spec.type === 'enum' && spec.choices === undefined && spec.choicesFrom === undefined) {
      issues.push(`${where}: "${spec.key}" is an enum with neither \`choices\` nor \`choicesFrom\``);
    }
    const validated = validateSetting(spec, spec.default);
    if (!validated.ok) issues.push(`${where}: its own default is invalid — ${validated.error.message}`);
  }
  return issues;
}

/** Key → declared default, for every spec in every page. */
export function defaultsOf(pages: readonly SettingsPage[]): Record<string, SettingValue> {
  const defaults: Record<string, SettingValue> = {};
  for (const page of pages) {
    for (const spec of page.settings ?? []) defaults[spec.key] = spec.default;
  }
  return defaults;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/sdk test settings`
Expected: PASS, all cases.

- [ ] **Step 6: Wire the new vocabulary into the manifest, permissions and the API surface**

In `packages/sdk/src/manifest.ts`, import `settingsPageSchema` and `type SettingsPage` from `./api-settings.ts`, add to the `contributes` type (at :64):

```ts
    readonly views?: readonly ContributedView[];
    /**
     * Settings pages, static so the screen can list every extension's settings
     * with NO extension activated — values live in the kernel and defaults live
     * here, so nothing has to be running to read or write one. Activation stays
     * lazy by declaration (core-design §4), which it would not if opening ⌘,
     * meant activating everything installed to ask what it can be configured
     * with.
     */
    readonly settings?: readonly SettingsPage[];
```

and to `manifestSchema`'s `contributes` object:

```ts
      settings: s.optional(s.array(settingsPageSchema)),
```

Add `settings` to the schema's declared type parameter alongside `commands` and `views`, mirroring the loose-string style that file explains (`SettingsPageWire[]`).

In `packages/sdk/src/permission.ts`, append to `PERMISSIONS`:

```ts
  /**
   * Write a setting in this extension's own namespace.
   *
   * Reading needs no grant — an extension is handed its own effective values at
   * activation, and refusing to tell it its own configuration would be a
   * permission over nothing. Writing is a grant because a settings value is a
   * user's decision, and an extension that can silently rewrite it can undo one.
   */
  'settings',
```

In `packages/sdk/src/api.ts`, add to `ProposedAPI`:

```ts
  readonly settings: SettingsAPI;
```

with the `import type { SettingsAPI } from './api-settings.ts';` beside its siblings. In `packages/sdk/src/index.ts`, export everything from `./api-settings.ts` (types + `settingsPageSchema`, `settingSpecSchema`, `settingValueSchema`, `SETTING_TYPES`) and from `./settings.ts` (`namespaceOf`, `CORE_NAMESPACE`, `validateSetting`, `pageIssues`, `defaultsOf`), following the file's existing grouping.

- [ ] **Step 7: Run the full gate**

Run: `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`
Expected: PASS. `ProposedAPI` gaining a member will fail `packages/app/src/ext-host/api.ts` typecheck — that is Task 4. To keep this task green, add the member to `createShepherd`'s `proposed` object now as `settings: gated('settings', () => createSettings(services))` **only if** you also land Task 4's `createSettings`; otherwise implement Task 1 and Task 4 as one commit. Do not leave a `// TODO` or an `as never` in that file.

- [ ] **Step 8: Commit**

```bash
git add packages/sdk
git commit -m "feat(sdk): the settings vocabulary — specs, pages, and their pure rules"
```

---

### Task 2: The registry and the store (core)

**Files:**
- Create: `packages/core/src/settings/registry.ts`, `packages/core/src/settings/index.ts`, `packages/core/src/settings/registry.test.ts`
- Modify: `packages/core/src/index.ts` (export the subsystem beside `ViewingResolver` at :153)

**Interfaces:**
- Consumes: `SqliteStore` (`packages/core/src/storage/store.ts` — `namespace(name): KV`), and from `@shepherd/sdk`: `CORE_NAMESPACE`, `defaultsOf`, `namespaceOf`, `pageIssues`, `validateSetting`, `settingValueSchema`, `SettingsPage`, `SettingSpec`, `SettingValue`, `SettingsError`, `Logger`, `Disposable`, `toDisposable`, `ok`, `err`, `Result`.
- Produces:
  ```ts
  class SettingsRegistry {
    constructor(options: { store: SqliteStore; logger: Logger });
    contribute(owner: string, pages: readonly SettingsPage[]): Disposable;
    pages(): readonly OwnedPage[];              // OwnedPage = SettingsPage & { owner: string }
    spec(key: string): SettingSpec | undefined;
    get(key: string): SettingValue | undefined;         // effective: stored ?? default
    values(namespace: string): Record<string, SettingValue>;  // effective, that namespace only
    set(key: string, value: unknown): Result<SettingValue, SettingsError>;
    reset(key: string): Result<SettingValue, SettingsError>;
    isDefault(key: string): boolean;
    onDidChange(fn: (key: string, value: SettingValue) => void): Disposable;
  }
  ```

- [ ] **Step 1: Write the failing test**

`packages/core/src/settings/registry.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import type { SettingsPage } from '@shepherd/sdk';
import { SqliteStore } from '../storage/store.ts';
import { SettingsRegistry } from './registry.ts';

const silent = {
  child: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const PAGE: SettingsPage = {
  id: 'agents.models',
  title: 'Models',
  settings: [
    { key: 'agents-core.quickModel', type: 'string', label: 'Model', default: 'sonnet' },
    { key: 'agents-core.quickKind', type: 'enum', label: 'Kind', default: null, nullable: true, choicesFrom: 'k' },
  ],
};

function fresh(): SettingsRegistry {
  const store = new SqliteStore({ location: ':memory:', logger: silent as never });
  return new SettingsRegistry({ store, logger: silent as never });
}

describe('SettingsRegistry', () => {
  let registry: SettingsRegistry;
  beforeEach(() => {
    registry = fresh();
    registry.contribute('shepherd.agents-core', [PAGE]);
  });

  it('reads an untouched key as its declared default', () => {
    expect(registry.get('agents-core.quickModel')).toBe('sonnet');
    expect(registry.isDefault('agents-core.quickModel')).toBe(true);
  });

  it('stores a changed value and reads it back', () => {
    expect(registry.set('agents-core.quickModel', 'opus').ok).toBe(true);
    expect(registry.get('agents-core.quickModel')).toBe('opus');
    expect(registry.isDefault('agents-core.quickModel')).toBe(false);
  });

  it('DELETES the row when a write equals the default, so a changed default still reaches this install', () => {
    registry.set('agents-core.quickModel', 'opus');
    registry.set('agents-core.quickModel', 'sonnet');
    expect(registry.isDefault('agents-core.quickModel')).toBe(true);
    // The proof: a build that ships a different default now wins here.
    const second = new SettingsRegistry({ store: registry.storeForTest, logger: silent as never });
    second.contribute('shepherd.agents-core', [
      { ...PAGE, settings: [{ key: 'agents-core.quickModel', type: 'string', label: 'Model', default: 'haiku' }] },
    ]);
    expect(second.get('agents-core.quickModel')).toBe('haiku');
  });

  it('refuses an unknown key rather than storing an orphan', () => {
    const result = registry.set('agents-core.nope', 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-key');
  });

  it('refuses a value its spec refuses', () => {
    const result = registry.set('agents-core.quickModel', 7);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('reset returns to the default and clears the row', () => {
    registry.set('agents-core.quickModel', 'opus');
    expect(registry.reset('agents-core.quickModel')).toEqual({ ok: true, value: 'sonnet' });
    expect(registry.isDefault('agents-core.quickModel')).toBe(true);
  });

  it('fires per key, with the effective value', () => {
    const seen: [string, unknown][] = [];
    registry.onDidChange((key, value) => seen.push([key, value]));
    registry.set('agents-core.quickModel', 'opus');
    registry.reset('agents-core.quickModel');
    expect(seen).toEqual([
      ['agents-core.quickModel', 'opus'],
      ['agents-core.quickModel', 'sonnet'],
    ]);
  });

  it('does not fire when the value did not change', () => {
    const seen: string[] = [];
    registry.onDidChange((key) => seen.push(key));
    registry.set('agents-core.quickModel', 'sonnet');
    expect(seen).toEqual([]);
  });

  it('refuses a page whose keys are outside the declaring namespace, and contributes none of it', () => {
    const other = fresh();
    expect(() =>
      other.contribute('shepherd.agents-core', [
        { id: 'p', title: 'P', settings: [{ key: 'claudeCode.model', type: 'string', label: 'M', default: '' }] },
      ]),
    ).toThrow(/claudeCode\.model/);
    expect(other.pages()).toEqual([]);
  });

  it('hands a namespace exactly its own effective values, plus nothing else', () => {
    registry.contribute('shepherd', [
      { id: 'general', title: 'General', settings: [{ key: 'shepherd.theme', type: 'enum', label: 'Theme', default: 'system', choices: [{ value: 'system', label: 'System' }] }] },
    ]);
    registry.set('agents-core.quickModel', 'opus');
    expect(registry.values('agents-core')).toEqual({
      'agents-core.quickModel': 'opus',
      'agents-core.quickKind': null,
    });
    expect(registry.values('shepherd')).toEqual({ 'shepherd.theme': 'system' });
  });

  it('forgets a disposed contribution, keys and all', () => {
    const disposable = registry.contribute('shepherd.worktree-hook', [
      { id: 'w', title: 'Hooks', component: 'worktree-hook.editor' },
    ]);
    expect(registry.pages().some((page) => page.id === 'w')).toBe(true);
    disposable.dispose();
    expect(registry.pages().some((page) => page.id === 'w')).toBe(false);
  });

  it('sorts pages by order then title, and a page with no order sorts last', () => {
    registry.contribute('shepherd', [{ id: 'general', title: 'General', order: 0, component: 'x' }]);
    registry.contribute('shepherd.zeta', [{ id: 'zeta', title: 'Zeta', order: 10, component: 'x' }]);
    expect(registry.pages().map((page) => page.id)).toEqual(['general', 'zeta', 'agents.models']);
  });
});
```

`storeForTest` in the third case is a getter you will add on the registry (`get storeForTest(): SqliteStore`) — name it exactly that, and note in its comment that it exists so a test can prove two registries over one file agree. If you would rather not expose it, build the second registry from a `SqliteStore` you constructed in the test over a temp-file location and pass the same location twice; do not weaken the assertion.

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/core test settings`
Expected: FAIL — `./registry.ts` does not exist.

- [ ] **Step 3: Implement the registry**

`packages/core/src/settings/registry.ts`:

```ts
import {
  CORE_NAMESPACE,
  defaultsOf,
  err,
  namespaceOf,
  ok,
  pageIssues,
  settingValueSchema,
  toDisposable,
  validateSetting,
  type Disposable,
  type Logger,
  type Result,
  type SettingSpec,
  type SettingValue,
  type SettingsError,
  type SettingsPage,
} from '@shepherd/sdk';
import type { KV } from '@shepherd/sdk';
import type { SqliteStore } from '../storage/store.ts';

/**
 * A page, plus who contributed it — the shell draws the owner as a subtitle, and
 * the access gate reads it. Recorded here rather than in a table beside the
 * pages for `points.ts`'s reason: "who owns this" and "does this page exist"
 * have to become false at the same instant.
 */
export interface OwnedPage extends SettingsPage {
  readonly owner: string;
}

/** The KV namespace every setting's value lives in, whoever declared it. */
const SETTINGS_NAMESPACE = 'settings';

export interface SettingsRegistryOptions {
  readonly store: SqliteStore;
  readonly logger: Logger;
}

/**
 * The authority on what settings exist and what they are.
 *
 * Two decisions are worth reading before changing anything here:
 *
 *   - **Only non-default values are stored**, and a write equal to the default
 *     deletes the row. That is what makes "reset" a real operation rather than a
 *     write of today's default frozen forever, and what lets a default the app
 *     CHANGES reach every install that never touched the setting. Materializing
 *     defaults on first launch would make the store a snapshot of one version's
 *     opinions.
 *   - **An unknown key is an error, not a stored orphan.** The registry is the
 *     authority on what exists; a store that accepted anything is how a typo
 *     becomes a setting nobody can find.
 */
export class SettingsRegistry {
  readonly #store: SqliteStore;
  readonly #kv: KV;
  readonly #log;
  /** owner → its pages. Keyed by owner so a teardown is one delete. */
  readonly #contributions = new Map<string, readonly SettingsPage[]>();
  readonly #listeners = new Set<(key: string, value: SettingValue) => void>();

  constructor(options: SettingsRegistryOptions) {
    this.#store = options.store;
    this.#kv = options.store.namespace(SETTINGS_NAMESPACE);
    this.#log = options.logger.child('settings');
  }

  /** See the test's third case. */
  get storeForTest(): SqliteStore {
    return this.#store;
  }

  /**
   * Throws on a bad page, and contributes NOTHING when it does.
   *
   * All-or-nothing per owner, because a partially accepted contribution is a
   * screen that draws some of an extension's settings and silently omits the
   * rest — which reads as a missing feature rather than as a manifest error. The
   * host catches this and refuses the activation, naming the extension.
   */
  contribute(owner: string, pages: readonly SettingsPage[]): Disposable {
    const namespace = owner === CORE_NAMESPACE ? CORE_NAMESPACE : namespaceOf(owner);
    const issues = pages.flatMap((page) => pageIssues(page, namespace));
    const taken = new Set(this.#allPages().flatMap((page) => (page.settings ?? []).map((spec) => spec.key)));
    for (const page of pages) {
      for (const spec of page.settings ?? []) {
        if (taken.has(spec.key)) issues.push(`settings key "${spec.key}" is already declared by another page`);
      }
    }
    if (issues.length > 0) throw new Error(`${owner}: ${issues.join('; ')}`);

    this.#contributions.set(owner, pages);
    this.#log.debug(`+${pages.length} settings page(s) from ${owner}`);
    return toDisposable(() => {
      this.#contributions.delete(owner);
    });
  }

  pages(): readonly OwnedPage[] {
    const owned = [...this.#contributions.entries()].flatMap(([owner, pages]) =>
      pages.map((page) => ({ ...page, owner })),
    );
    /**
     * `order` first, then title. A page with no order sorts AFTER every page
     * that declared one — `Infinity`, not 0: an extension that did not express
     * an opinion must not land in front of the app's own General page.
     */
    return owned.sort(
      (a, b) => (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY) || a.title.localeCompare(b.title),
    );
  }

  spec(key: string): SettingSpec | undefined {
    for (const page of this.#allPages()) {
      const found = (page.settings ?? []).find((candidate) => candidate.key === key);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  get(key: string): SettingValue | undefined {
    const spec = this.spec(key);
    if (spec === undefined) return undefined;
    return this.#stored(key) ?? spec.default;
  }

  values(namespace: string): Record<string, SettingValue> {
    const all = defaultsOf(this.#allPages());
    const scoped: Record<string, SettingValue> = {};
    for (const [key, fallback] of Object.entries(all)) {
      if (namespaceOf(key) !== namespace && !key.startsWith(`${namespace}.`)) continue;
      scoped[key] = this.#stored(key) ?? fallback;
    }
    return scoped;
  }

  set(key: string, value: unknown): Result<SettingValue, SettingsError> {
    const spec = this.spec(key);
    if (spec === undefined) {
      return err({
        code: 'unknown-key',
        message: `no setting "${key}" is declared. The registry is the authority on what exists — a value stored under an undeclared key would be a setting nobody can find.`,
      });
    }
    const validated = validateSetting(spec, value);
    if (!validated.ok) return validated;

    const before = this.get(key);
    if (sameValue(validated.value, spec.default)) this.#kv.delete(key);
    else this.#kv.set(key, validated.value);

    if (!sameValue(before, validated.value)) this.#announce(key, validated.value);
    return ok(validated.value);
  }

  reset(key: string): Result<SettingValue, SettingsError> {
    const spec = this.spec(key);
    if (spec === undefined) return err({ code: 'unknown-key', message: `no setting "${key}" is declared` });
    return this.set(key, spec.default);
  }

  isDefault(key: string): boolean {
    return this.#stored(key) === undefined;
  }

  onDidChange(fn: (key: string, value: SettingValue) => void): Disposable {
    this.#listeners.add(fn);
    return toDisposable(() => void this.#listeners.delete(fn));
  }

  #allPages(): readonly SettingsPage[] {
    return [...this.#contributions.values()].flat();
  }

  /** `undefined` means "nothing stored", which is how `isDefault` is answered. */
  #stored(key: string): SettingValue | undefined {
    return this.#kv.get(key, settingValueSchema) ?? undefined;
  }

  #announce(key: string, value: SettingValue): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(key, value);
      } catch (error) {
        // One bad subscriber must not stop the rest from learning.
        this.#log.warn(`a settings listener threw for ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/**
 * Value equality for the three scalars a setting can hold.
 *
 * `null` is a value here (a nullable spec's "unset"), so `===` is the whole
 * comparison — but it is named, because `#stored` returning `undefined` for
 * "nothing stored" and `null` for "explicitly unset" is a distinction this file
 * depends on and `==` would erase.
 */
function sameValue(a: SettingValue | undefined, b: SettingValue | undefined): boolean {
  return a === b;
}
```

`#stored` uses `?? undefined` because `KV.get` answers `undefined` for a missing row and a stored `null` parses as `null` — read it once and keep the two apart. If `settingValueSchema` rejects `null` in `KV.get`'s parse, fix the schema in Task 1 rather than working around it here.

- [ ] **Step 4: Barrel and export**

`packages/core/src/settings/index.ts`:

```ts
export { SettingsRegistry, type OwnedPage, type SettingsRegistryOptions } from './registry.ts';
```

and in `packages/core/src/index.ts`, beside the `ViewingResolver` export:

```ts
export { SettingsRegistry, type OwnedPage, type SettingsRegistryOptions } from './settings/index.ts';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/core test settings`
Expected: PASS, all cases.

- [ ] **Step 6: Run the full gate**

Run: `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core): a settings registry that stores only what differs from a default"
```

---

### Task 3: The kernel commands and the general page (main)

The registry, reachable — from the palette, from the control socket, and (Task 6) from the page. Plus `shepherd.theme` itself, which is the kernel's own contribution.

**Files:**
- Create: `packages/app/src/main/settings-commands.ts`, `packages/app/src/main/settings-commands.test.ts`, `packages/app/src/main/settings-general.ts`
- Modify: `packages/app/src/main/index.ts` (construct the registry near the `SqliteStore` at :288; register the commands near `registerReloadCommand` at :1023)

**Interfaces:**
- Consumes: `SettingsRegistry` (Task 2); `CommandRegistry` and `EventBus` from `@shepherd/core`; `KERNEL`, `s` from `@shepherd/sdk`.
- Produces: `SETTINGS_COMMANDS` (`{ list: 'settings.list', get: 'settings.get', set: 'settings.set', reset: 'settings.reset' }`), `SETTINGS_CHANGED_TOPIC = 'settings.changed'`, `registerSettingsCommands(options): Disposable`, `GENERAL_PAGE`, `THEME_KEY = 'shepherd.theme'`, `ThemeSetting = 'dark' | 'light' | 'system'`.

- [ ] **Step 1: Write the failing test**

`packages/app/src/main/settings-commands.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { CommandRegistry, EventBus, SettingsRegistry, SqliteStore } from '@shepherd/core';
import { KERNEL, USER } from '@shepherd/sdk';
import { registerSettingsCommands, SETTINGS_COMMANDS, SETTINGS_CHANGED_TOPIC } from './settings-commands.ts';
import { GENERAL_PAGE, THEME_KEY } from './settings-general.ts';

// The repo's silent logger shape; copy the one the neighbouring main tests use.
const silent = { child: () => silent, debug() {}, info() {}, warn() {}, error() {} } as never;

describe('the settings commands', () => {
  let settings: SettingsRegistry;
  let commands: CommandRegistry;
  let bus: EventBus;

  beforeEach(() => {
    const store = new SqliteStore({ location: ':memory:', logger: silent });
    settings = new SettingsRegistry({ store, logger: silent });
    settings.contribute('shepherd', [GENERAL_PAGE]);
    bus = new EventBus({ logger: silent });
    commands = new CommandRegistry({ logger: silent });
    registerSettingsCommands({ registry: commands, settings, bus });
  });

  it('lists every page with its values and which of them are defaults', async () => {
    const answer = await commands.invoke(SETTINGS_COMMANDS.list, {}, USER);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const listed = answer.value as { pages: { id: string }[]; values: Record<string, unknown>; defaults: string[] };
    expect(listed.pages.map((page) => page.id)).toContain(GENERAL_PAGE.id);
    expect(listed.values[THEME_KEY]).toBe('system');
    expect(listed.defaults).toContain(THEME_KEY);
  });

  it('sets a value and publishes it on the bus', async () => {
    const seen: unknown[] = [];
    bus.subscribe(SETTINGS_CHANGED_TOPIC, (payload) => seen.push(payload));
    const answer = await commands.invoke(SETTINGS_COMMANDS.set, { key: THEME_KEY, value: 'light' }, USER);
    expect(answer.ok).toBe(true);
    expect(settings.get(THEME_KEY)).toBe('light');
    expect(seen).toEqual([{ key: THEME_KEY, value: 'light' }]);
  });

  it('reports an unknown key as a failed command rather than a silent no-op', async () => {
    const answer = await commands.invoke(SETTINGS_COMMANDS.set, { key: 'nope.nope', value: 1 }, USER);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error.message).toContain('nope.nope');
  });

  it('reset puts the declared default back', async () => {
    await commands.invoke(SETTINGS_COMMANDS.set, { key: THEME_KEY, value: 'light' }, USER);
    await commands.invoke(SETTINGS_COMMANDS.reset, { key: THEME_KEY }, USER);
    expect(settings.get(THEME_KEY)).toBe('system');
  });

  it('get answers the effective value and says whether it is the default', async () => {
    const answer = await commands.invoke(SETTINGS_COMMANDS.get, { key: THEME_KEY }, KERNEL);
    expect(answer.ok).toBe(true);
    if (answer.ok) expect(answer.value).toEqual({ key: THEME_KEY, value: 'system', isDefault: true });
  });
});

describe('the general page', () => {
  it('offers exactly dark, light and system, defaulting to system', () => {
    const theme = (GENERAL_PAGE.settings ?? []).find((spec) => spec.key === THEME_KEY);
    expect(theme?.default).toBe('system');
    expect(theme?.choices?.map((choice) => choice.value)).toEqual(['system', 'dark', 'light']);
  });
});
```

Check the real constructor shapes of `CommandRegistry` and `EventBus` in `packages/core/src` before running — pass whatever they require (a logger, a clock) exactly as the neighbouring `main` tests do.

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test settings-commands`
Expected: FAIL — no such module.

- [ ] **Step 3: Write the general page**

`packages/app/src/main/settings-general.ts`:

```ts
import { CORE_NAMESPACE, type SettingsPage } from '@shepherd/sdk';

/** The app's own theme choice. `shepherd.*` is readable by every extension. */
export const THEME_KEY = `${CORE_NAMESPACE}.theme`;

export type ThemeSetting = 'system' | 'dark' | 'light';

/**
 * The app's own settings page, contributed by the kernel exactly the way an
 * extension contributes one — same registry, same validation, same wire shape.
 *
 * That sameness is the point rather than tidiness: the shell reads the theme
 * through the interface an extension reads its own keys through, so a bug in
 * that path is a bug in the app's own General page and cannot hide in a corner
 * only third parties visit.
 *
 * `system` is the default because the honest answer to "which theme" is the
 * one the user already told their OS.
 */
export const GENERAL_PAGE: SettingsPage = {
  id: 'shepherd.general',
  title: 'General',
  // 0, so it is first in the nav. Every extension page sorts after it — a page
  // with no `order` sorts at Infinity (see `SettingsRegistry.pages`).
  order: 0,
  settings: [
    {
      key: THEME_KEY,
      type: 'enum',
      label: 'Theme',
      description: 'Follow the system, or pin the app to one palette.',
      default: 'system',
      choices: [
        { value: 'system', label: 'System' },
        { value: 'dark', label: 'Dark' },
        { value: 'light', label: 'Light' },
      ],
    },
  ],
};
```

- [ ] **Step 4: Write the commands**

`packages/app/src/main/settings-commands.ts`:

```ts
import { KERNEL, s, toDisposable, type Disposable } from '@shepherd/sdk';
import type { CommandRegistry, EventBus, SettingsRegistry } from '@shepherd/core';

/**
 * The settings verbs — one table, reached by the palette, the control socket and
 * (through `settings-ipc.ts`) the settings screen.
 *
 * Commands rather than a bespoke IPC surface, for the reason the layout is
 * commands: a second path that wrote a setting a second way would be a second
 * authorization path, and the one verb table exists to prevent that.
 */
export const SETTINGS_COMMANDS = {
  list: 'settings.list',
  get: 'settings.get',
  set: 'settings.set',
  reset: 'settings.reset',
} as const;

/**
 * A changed setting, on the bus.
 *
 * Published rather than pulled because there are three writers — the screen, the
 * CLI, and an extension — and every reader (the shell's theme, an extension's
 * mirror) must not have to guess when to re-read. See `viewing-topic.ts` for the
 * same shape and the same argument.
 */
export const SETTINGS_CHANGED_TOPIC = 'settings.changed';

export interface SettingsCommandsOptions {
  readonly registry: CommandRegistry;
  readonly settings: SettingsRegistry;
  readonly bus: EventBus;
}

export function registerSettingsCommands(options: SettingsCommandsOptions): Disposable {
  const { registry, settings, bus } = options;

  /**
   * One publish for every change, wherever it came from — including a write by
   * an extension through `settings.set`, which is why this subscribes to the
   * registry rather than publishing inside each handler.
   */
  const relay = settings.onDidChange((key, value) => {
    bus.publish(SETTINGS_CHANGED_TOPIC, { key, value }, KERNEL);
  });

  const registrations = [
    registry.register(SETTINGS_COMMANDS.list, {
      title: 'Settings: List',
      schema: s.nothing(),
      handler: () => ({
        pages: settings.pages(),
        values: Object.fromEntries(
          settings
            .pages()
            .flatMap((page) => (page.settings ?? []).map((spec) => [spec.key, settings.get(spec.key)] as const)),
        ),
        /**
         * Which keys are untouched, as a list rather than a flag per value: the
         * screen needs it to decide whether to draw a reset affordance, and a
         * caller that does not care can ignore one field instead of unwrapping
         * every value.
         */
        defaults: settings
          .pages()
          .flatMap((page) => (page.settings ?? []).map((spec) => spec.key))
          .filter((key) => settings.isDefault(key)),
      }),
    }),

    registry.register(SETTINGS_COMMANDS.get, {
      title: 'Settings: Get',
      schema: s.object({ key: s.string() }),
      handler: (args) => {
        const value = settings.get(args.key);
        if (value === undefined) throw new Error(`no setting "${args.key}" is declared`);
        return { key: args.key, value, isDefault: settings.isDefault(args.key) };
      },
    }),

    registry.register(SETTINGS_COMMANDS.set, {
      title: 'Settings: Set',
      // `settings`, so an extension needs the grant and the ONE authorizer in
      // the dispatcher enforces it. The screen invokes as the user, which is
      // unconditionally trusted — that asymmetry is deliberate: the user typing
      // in their own settings screen is not an extension writing behind them.
      permission: 'settings',
      schema: s.object({ key: s.string(), value: s.unknown() }),
      handler: (args) => {
        const result = settings.set(args.key, args.value);
        // A throw, so the failure reaches the caller as a typed `handler-failed`
        // with the registry's own sentence. Answering `{ok:false}` inside a
        // successful command would make a refusal look like a success to
        // everything that only checks `ok`.
        if (!result.ok) throw new Error(result.error.message);
        return { key: args.key, value: result.value };
      },
    }),

    registry.register(SETTINGS_COMMANDS.reset, {
      title: 'Settings: Reset to Default',
      permission: 'settings',
      schema: s.object({ key: s.string() }),
      handler: (args) => {
        const result = settings.reset(args.key);
        if (!result.ok) throw new Error(result.error.message);
        return { key: args.key, value: result.value };
      },
    }),
  ];

  return toDisposable(() => {
    for (const registration of registrations) registration.dispose();
    relay.dispose();
  });
}
```

Match `CommandRegistry.register`'s real option names (read `registerReloadCommand` at `packages/app/src/main/reload-command.ts` — `{ title, permission, schema, handler }`) and `EventBus.publish`'s real signature.

- [ ] **Step 5: Run the test to verify it passes**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test settings-commands`
Expected: PASS.

- [ ] **Step 6: Wire it into main**

In `packages/app/src/main/index.ts`, after the `store` at :288:

```ts
/**
 * Settings — the registry, and the app's own page contributed into it first so
 * `shepherd.theme` exists before any window reads it.
 */
const settings = new SettingsRegistry({ store, logger });
settings.contribute(CORE_NAMESPACE, [GENERAL_PAGE]);
```

and beside `registerReloadCommand` at :1023:

```ts
  registerSettingsCommands({ registry, settings, bus });
```

- [ ] **Step 7: Verify by hand, then commit**

Run: `env -u NODE_OPTIONS pnpm ship --dev`, then against the night build's socket:

```bash
curl -s --unix-socket ~/.shepherd/v2-dev/control.sock -X POST \
  -H 'content-type: application/json' \
  -d '{"command":"settings.list","args":{},"caller":{"kind":"device","deviceId":"local-cli"}}' \
  http://localhost/invoke
```

Expected: a JSON answer containing the `shepherd.general` page and `"shepherd.theme":"system"`.

```bash
git add packages/app/src/main
git commit -m "feat(app): settings.list/get/set/reset, and the app's own General page"
```

---

### Task 4: An extension's `settings` API (ext-host)

**Files:**
- Modify: `packages/app/src/shared/ext-protocol.ts` (the activate ask at :312), `packages/app/src/ext-host/api.ts` (beside `createStorage` at :192 and `proposed` at :800), `packages/app/src/main/ext-host.ts` (build the seed; contribute the manifest's pages)
- Test: `packages/app/src/ext-host/api.test.ts` if one exists for this area, else add cases to `packages/app/src/ext-host/runtime.test.ts`; plus `packages/app/src/main/ext-host.test.ts` for the seed.

**Interfaces:**
- Consumes: `ExtHostServices` (`call`, `tell`, `subscribe`, `log`), `SETTINGS_COMMANDS` and `SETTINGS_CHANGED_TOPIC` — as **string literals** in `api.ts`, never an import: the utility process may not import `@shepherd/core`, and a command id is public vocabulary (the file already does this for `ATTENTION_TOPIC` and `LAYOUT_SPLIT`).
- Produces: `createSettings(seed, services): SettingsAPI`.

- [ ] **Step 1: Write the failing test**

Add to the ext-host API test file:

```ts
describe('ctx settings', () => {
  it('reads a seeded value synchronously', () => {
    const services = spyServices();
    const settings = createSettings({ 'agents-core.quickModel': 'sonnet' }, services);
    expect(settings.get('agents-core.quickModel', s.string())).toBe('sonnet');
  });

  it('throws for a key it was never seeded, rather than answering undefined', () => {
    const settings = createSettings({}, spyServices());
    // `get` promises a value. A key that is not in the seed is not "unset" — it
    // is undeclared, or it belongs to somebody else, and both are bugs in the
    // caller that must not read as "the user has not chosen".
    expect(() => settings.get('other.key', s.string())).toThrow(/other\.key/);
  });

  it('sets through the settings.set COMMAND, so the one authorizer sees it', async () => {
    const services = spyServices();
    const settings = createSettings({ 'agents-core.quickModel': 'sonnet' }, services);
    await settings.set('agents-core.quickModel', 'opus');
    expect(services.calls).toEqual([
      { kind: 'command.invoke', commandId: 'settings.set', args: { key: 'agents-core.quickModel', value: 'opus' } },
    ]);
  });

  it('updates the mirror from the bus, because the SCREEN is a second writer', () => {
    const services = spyServices();
    const settings = createSettings({ 'agents-core.quickModel': 'sonnet' }, services);
    const seen: [string, unknown][] = [];
    settings.onDidChange((key, value) => seen.push([key, value]));
    services.emit('settings.changed', { key: 'agents-core.quickModel', value: 'opus' });
    expect(settings.get('agents-core.quickModel', s.string())).toBe('opus');
    expect(seen).toEqual([['agents-core.quickModel', 'opus']]);
  });

  it('ignores a malformed change event rather than poisoning the mirror', () => {
    const services = spyServices();
    const settings = createSettings({ 'agents-core.quickModel': 'sonnet' }, services);
    services.emit('settings.changed', { nope: true });
    expect(settings.get('agents-core.quickModel', s.string())).toBe('sonnet');
  });
});
```

`spyServices()` is whatever fake the existing tests in that file use for `ExtHostServices`; extend it with an `emit(topic, payload)` that invokes the subscriber registered through `subscribe`, and a `calls` array recording `call()` arguments.

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test ext-host`
Expected: FAIL — `createSettings` is not exported.

- [ ] **Step 3: Add the seed to the protocol**

In `packages/app/src/shared/ext-protocol.ts`, in the `activate` ask beside `storage` at :312:

```ts
    /**
     * This extension's EFFECTIVE settings — its own namespace, plus the
     * kernel's `shepherd.*`.
     *
     * A seed for `storage`'s reason (`SettingsAPI.get` is synchronous, and the
     * values live in main), but with the second half of that comment's warning
     * now true: settings have MORE than one writer — the screen, the CLI, and
     * the extension itself. So the mirror is not write-through-and-trust; it is
     * corrected by `settings.changed` on the bus, which every writer's change
     * passes through.
     */
    settings: s.record(s.unknown()),
```

Make it required, not optional, for `homeDir`'s reason: a fixture that builds an `activate` frame has to say, and an extension seeded with nothing silently reads defaults that are not the user's.

- [ ] **Step 4: Implement `createSettings`**

In `packages/app/src/ext-host/api.ts`, after `createStorage`:

```ts
/** Core's `SETTINGS_CHANGED_TOPIC` and the `settings.set` verb, as literals. */
const SETTINGS_CHANGED_TOPIC = 'settings.changed';
const SETTINGS_SET = 'settings.set';

/**
 * `api.proposed.settings` — a corrected mirror plus one command.
 *
 * The difference from `ctx.storage` is the whole design: a KV namespace has
 * exactly one writer, so its mirror never needs invalidating, while a SETTING
 * has three (this extension, the settings screen, `shepherd settings` from a
 * pane). So this subscribes to the change topic and keeps the mirror true,
 * rather than assuming its own last write is the current value. A screen the
 * user is typing in is the second writer that comment in `ext-protocol.ts`
 * warned about.
 */
export function createSettings(seed: Readonly<Record<string, unknown>>, services: ExtHostServices): SettingsAPI {
  const mirror = new Map<string, unknown>(Object.entries(seed));
  const listeners = new Set<(key: string, value: SettingValue) => void>();

  services.subscribe(SETTINGS_CHANGED_TOPIC, (payload) => {
    const parsed = changeSchema.parse(payload);
    if (!parsed.ok) {
      services.log('warn', `settings.changed did not match its shape, ignoring: ${formatIssues(parsed.error)}`);
      return;
    }
    const { key, value } = parsed.value;
    // Only keys this extension can SEE. A change to somebody else's setting
    // still reaches this subscription (the topic is one bus topic), and putting
    // it in the mirror would hand this extension a value the seed deliberately
    // withheld.
    if (!mirror.has(key)) return;
    mirror.set(key, value);
    for (const listener of [...listeners]) listener(key, value);
  });

  return {
    get<T>(key: string, schema: Schema<T>): T {
      if (!mirror.has(key)) {
        /**
         * A throw, not `undefined`. `get` promises a value backed by a declared
         * default, so a missing key is never "the user has not chosen" — it is
         * an undeclared key or another extension's, and both are caller bugs
         * that must be loud. This is the same refusal-over-silence rule the
         * rest of this file is built on.
         */
        throw new NotImplementedError(
          `settings.get("${key}")`,
          'no such setting was seeded for this extension. Either it is not declared in this manifest\'s ' +
            '`contributes.settings`, or it belongs to another extension — an extension reads its own namespace ' +
            'and `shepherd.*`, and nothing else.',
        );
      }
      const parsed = schema.parse(mirror.get(key));
      if (parsed.ok) return parsed.value;
      throw new NotImplementedError(
        `settings.get("${key}")`,
        `the stored value does not match the schema this caller passed: ${formatIssues(parsed.error)}. ` +
          'A setting is validated against its declared spec when written, so this is a disagreement between ' +
          'the spec in the manifest and the schema at the call.',
      );
    },

    async set(key: string, value: SettingValue) {
      const answer = await services.call({ kind: 'command.invoke', commandId: SETTINGS_SET, args: { key, value } });
      if (answer.ok) return ok(undefined);
      return err({
        code: answer.error.code === 'denied' ? 'denied' : 'invalid-value',
        message: answer.error.message,
      } satisfies SettingsError);
    },

    onDidChange(fn) {
      listeners.add(fn);
      return toDisposable(() => void listeners.delete(fn));
    },
  };
}

const changeSchema = s.object({ key: s.string(), value: settingValueSchema });
```

Then in `createShepherd`'s `proposed` object:

```ts
    settings: gated('settings', () => createSettings(options.settings, services)),
```

adding `readonly settings: Readonly<Record<string, unknown>>` to `ShepherdOptions` and threading it from the runtime's `activate` handling beside `storage`.

- [ ] **Step 5: Build the seed and contribute the pages in main**

In `packages/app/src/main/ext-host.ts`, where the `activate` ask is built:

```ts
      /**
       * Its own namespace plus the kernel's. Two calls rather than one merged
       * read, because the second one is a different fact: `shepherd.*` is
       * readable by everybody and writable by nobody but the user.
       */
      settings: { ...settings.values(namespaceOf(manifest.id)), ...settings.values(CORE_NAMESPACE) },
```

and where a manifest's contributions are registered, before activation:

```ts
      /**
       * Pages are contributed from the MANIFEST, before `activate` runs — that
       * is what makes the settings screen readable with nothing activated. A bad
       * page refuses the activation and names the extension: half a page drawn
       * is worse than a page refused, because the missing rows read as a missing
       * feature.
       */
      const pages = manifest.contributes?.settings ?? [];
      if (pages.length > 0) disposables.push(settings.contribute(manifest.id, pages));
```

Pass the `SettingsRegistry` into whatever options object this module already takes, and let the existing failure path report a `contribute` throw the way it reports every other manifest problem.

- [ ] **Step 6: Run the tests**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test ext-host`
Expected: PASS.

- [ ] **Step 7: Full gate and commit**

Run: `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`

```bash
git add packages/app/src
git commit -m "feat(ext-host): api.proposed.settings — a seeded mirror the bus keeps true"
```

---

### Task 5: Two primitives the design system is missing (`Switch`, `Select`)

`packages/ui/src/index.ts` lists Select among the primitives "deliberately absent", and there is no boolean control either — which is why `tasks` hand-rolled `RepoPicker` inside its own UI. The settings rows are the first real consumer of both. Land them here; Task 7 consumes them in the same branch, and the rule that a primitive arrives with its consumer is satisfied by that pair, not by this task alone.

**Files:**
- Create: `packages/ui/src/switch.tsx`, `packages/ui/src/switch.css`, `packages/ui/src/switch.test.tsx`, `packages/ui/src/select.tsx`, `packages/ui/src/select.css`, `packages/ui/src/select.test.tsx`
- Modify: `packages/ui/src/index.ts`, `packages/ui/src/styles.css` (the `@import` chain)

**Interfaces:**
- Produces:
  ```ts
  interface SwitchProps { checked: boolean; onChange(next: boolean): void; label: string; disabled?: boolean; id?: string }
  interface SelectOption { value: string; label: string; description?: string }
  interface SelectProps {
    value: string | null;             // null = the Default entry
    options: readonly SelectOption[];
    onChange(next: string | null): void;
    label: string;                     // accessible name
    nullable?: boolean;                // draws "Default" as the first entry
    busy?: boolean;                    // choices are still being fetched
    disabled?: boolean;
  }
  ```

- [ ] **Step 1: Write the failing tests**

`packages/ui/src/switch.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mount } from './test-dom.ts';
import { Switch } from './switch.tsx';

describe('Switch', () => {
  it('is a switch with its state and its name readable by a screen reader', () => {
    const { container } = mount(<Switch checked label="Follow the system" onChange={() => {}} />);
    const control = container.querySelector('[role="switch"]');
    expect(control?.getAttribute('aria-checked')).toBe('true');
    expect(control?.getAttribute('aria-label')).toBe('Follow the system');
  });

  it('reports the value it would become, not the one it has', () => {
    const onChange = vi.fn();
    const { container } = mount(<Switch checked={false} label="X" onChange={onChange} />);
    container.querySelector<HTMLElement>('[role="switch"]')?.click();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not report while disabled', () => {
    const onChange = vi.fn();
    const { container } = mount(<Switch checked={false} label="X" disabled onChange={onChange} />);
    container.querySelector<HTMLElement>('[role="switch"]')?.click();
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

`packages/ui/src/select.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { mount } from './test-dom.ts';
import { Select } from './select.tsx';

const OPTIONS = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

describe('Select', () => {
  it('shows the label of the current value, not the value', () => {
    const { container } = mount(<Select value="light" options={OPTIONS} label="Theme" onChange={() => {}} />);
    expect(container.textContent).toContain('Light');
  });

  it('opens a listbox and reports the chosen value', () => {
    const onChange = vi.fn();
    const { container } = mount(<Select value="dark" options={OPTIONS} label="Theme" onChange={onChange} />);
    act(() => container.querySelector<HTMLElement>('[data-testid="select-trigger"]')?.click());
    const items = [...container.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(items).toHaveLength(2);
    act(() => items[1]?.click());
    expect(onChange).toHaveBeenCalledWith('light');
  });

  it('draws a Default entry for a nullable select and reports null for it', () => {
    const onChange = vi.fn();
    const { container } = mount(
      <Select value={null} nullable options={OPTIONS} label="Kind" onChange={onChange} />,
    );
    expect(container.textContent).toContain('Default');
    act(() => container.querySelector<HTMLElement>('[data-testid="select-trigger"]')?.click());
    act(() => container.querySelector<HTMLElement>('[role="option"]')?.click());
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('shows the braille spinner and refuses to open while busy', () => {
    const { container } = mount(<Select value={null} nullable busy options={[]} label="Kind" onChange={() => {}} />);
    const trigger = container.querySelector<HTMLElement>('[data-testid="select-trigger"]');
    act(() => trigger?.click());
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    // The one working indicator in this app (Rule 7). Pulses and shimmer are banned.
    expect(BRAILLE_FRAMES.some((frame) => container.textContent?.includes(frame))).toBe(true);
  });

  it('closes on Escape without reporting a change', () => {
    const onChange = vi.fn();
    const { container } = mount(<Select value="dark" options={OPTIONS} label="Theme" onChange={onChange} />);
    act(() => container.querySelector<HTMLElement>('[data-testid="select-trigger"]')?.click());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

Import `BRAILLE_FRAMES` from `./spinner.ts` in that file.

- [ ] **Step 2: Run them to verify they fail**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ui test`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Implement `Switch`**

`packages/ui/src/switch.tsx` — a `<button role="switch">`, no new dependency:

```tsx
import type { ReactElement } from 'react';
import { cn } from './cn.ts';

export interface SwitchProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  /** The accessible name. Required — a switch with no name is a mystery toggle. */
  readonly label: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly className?: string;
}

/**
 * The boolean control, and the reason it is hand-built rather than a Radix
 * import: it is a button with `role="switch"` and `aria-checked`, which is the
 * entire accessible contract. A dependency for that would be a dependency for
 * nothing.
 */
export function Switch({ checked, onChange, label, disabled = false, id, className }: SwitchProps): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-testid="switch"
      className={cn('sh-ui-switch', className)}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
    >
      <span className="sh-ui-switch-knob" aria-hidden="true" />
    </button>
  );
}
```

`packages/ui/src/switch.css` — track and knob in role tokens only (`--sh-ink-raised` for the off track, `--sh-accent` for on, `--sh-focus` for the ring); no hue anywhere; the knob transitions on `transform` and nothing else.

- [ ] **Step 4: Implement `Select`**

`packages/ui/src/select.tsx` — a trigger plus a `role="listbox"` of `Row`s, keyboard-driven (↑/↓/Home/End/Enter/Escape), closing on click-out:

```tsx
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { cn } from './cn.ts';
import { Row } from './row.tsx';
import { useBrailleFrame } from './spinner.ts';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface SelectProps {
  /** `null` is the *Default* entry, and only legal when `nullable`. */
  readonly value: string | null;
  readonly options: readonly SelectOption[];
  readonly onChange: (next: string | null) => void;
  readonly label: string;
  readonly nullable?: boolean;
  /**
   * The options are still being fetched (a `choicesFrom` command in another
   * process). The trigger shows the braille spinner and does not open — an
   * empty listbox reads as "there are no choices", which is a different and
   * wrong answer.
   */
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
}

/** What `null` is called on screen. One string, so the app says it one way. */
export const DEFAULT_OPTION_LABEL = 'Default';

export function Select({
  value,
  options,
  onChange,
  label,
  nullable = false,
  busy = false,
  disabled = false,
  className,
}: SelectProps): ReactElement {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const frame = useBrailleFrame(busy);

  const entries: readonly (SelectOption | { value: null; label: string })[] = nullable
    ? [{ value: null, label: DEFAULT_OPTION_LABEL }, ...options]
    : options;
  const current = entries.find((entry) => entry.value === value);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    const onDown = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <div className={cn('sh-ui-select', className)} ref={box}>
      <button
        type="button"
        data-testid="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled || busy}
        className="sh-ui-select-trigger"
        onClick={() => setOpen((was) => !was)}
      >
        <span className="sh-ui-select-value">{busy ? frame : (current?.label ?? '—')}</span>
      </button>
      {open && !busy && (
        <div role="listbox" aria-label={label} className="sh-ui-select-list">
          {entries.map((entry) => (
            <Row
              key={entry.value ?? ' default'}
              role="option"
              aria-selected={entry.value === value}
              selected={entry.value === value}
              onClick={() => {
                setOpen(false);
                onChange(entry.value);
              }}
            >
              {entry.label}
            </Row>
          ))}
        </div>
      )}
    </div>
  );
}
```

Read `packages/ui/src/row.tsx` first and pass whatever props `Row` really takes for a selected, clickable row (`RepoPicker` in `extensions/tasks/ui/repo-picker.tsx` is a working example of `Row` used as a listbox option — follow it, including its keyboard handling, and lift the arrow-key navigation from it rather than inventing a second version).

`packages/ui/src/select.css` — the list is absolutely positioned under the trigger with `--sh-*` tokens for surface, border and shadow, `max-height` with `overflow-y: auto`, and no colour literal.

- [ ] **Step 5: Run the tests**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ui test`
Expected: PASS.

- [ ] **Step 6: Export both, and register their stylesheets**

In `packages/ui/src/index.ts`, under `// Controls`:

```ts
export { Switch, type SwitchProps } from './switch.tsx';
export { Select, DEFAULT_OPTION_LABEL, type SelectOption, type SelectProps } from './select.tsx';
```

Update the file's header comment: it says "Fifteen now" and lists what is "deliberately absent" including Select. Change the count, move Select out of the absent list, and add both to the table of what-bought-each-primitive with their consumer named ("the settings screen's rows: a boolean setting and a one-of-N setting"). That comment is the design record; leaving it stale is the same drift `boundaries.js` exists to prevent.

Add `@import './switch.css';` and `@import './select.css';` to `packages/ui/src/styles.css` in the chain's existing order.

- [ ] **Step 7: Full gate and commit**

```bash
git add packages/ui
git commit -m "feat(ui): Switch and Select — the two controls a settings row needs"
```

---

### Task 6: The bridge (channels, preload, main IPC, visibility)

**Files:**
- Create: `packages/app/src/main/settings-ipc.ts`, `packages/app/src/main/settings-visibility.ts`, `packages/app/src/main/settings-visibility.test.ts`
- Modify: `packages/app/src/shared/channels.ts`, `packages/app/src/shared/bridge.ts`, `packages/app/src/shared/commands.ts`, `packages/app/src/shared/menu-commands.ts`, `packages/app/src/preload/api.ts`, `packages/app/src/main/menu-template.ts`, `packages/app/src/main/index.ts`

**Interfaces:**
- Produces:
  ```ts
  // shared/channels.ts
  INVOKE.settingsList = 'settings:list'
  INVOKE.settingsSet = 'settings:set'
  INVOKE.settingsReset = 'settings:reset'
  EMIT.settingsChanged = 'settings:changed'        // { key, value }
  EMIT.settingsVisibility = 'settings:visibility'  // boolean — main owns it
  // shared/bridge.ts
  interface SettingsPageDTO { id, title, owner, order?, component?, settings?: SettingSpec[] }
  interface SettingsSnapshotDTO { pages: readonly SettingsPageDTO[]; values: Record<string, SettingValue>; defaults: readonly string[] }
  interface SettingsApi {
    list(): Promise<IpcResult<SettingsSnapshotDTO>>;
    set(key: string, value: SettingValue): Promise<IpcResult<void>>;
    reset(key: string): Promise<IpcResult<void>>;
    onChanged(listener: (change: { key: string; value: SettingValue }) => void): () => void;
    onVisibility(listener: (open: boolean) => void): () => void;
    setOpen(open: boolean): Promise<IpcResult<void>>;   // invokes the window.settings command
  }
  // main/settings-visibility.ts
  const SETTINGS_VISIBILITY_COMMAND = 'window.settings'
  function registerSettingsVisibility(options: {
    registry: CommandRegistry;
    onChange: (open: boolean) => void;
  }): Disposable
  ```

- [ ] **Step 1: Write the failing test**

`packages/app/src/main/settings-visibility.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from '@shepherd/core';
import { USER } from '@shepherd/sdk';
import { registerSettingsVisibility, SETTINGS_VISIBILITY_COMMAND } from './settings-visibility.ts';

const silent = { child: () => silent, debug() {}, info() {}, warn() {}, error() {} } as never;

describe('window.settings', () => {
  it('opens, closes, and reports the state it moved to', async () => {
    const onChange = vi.fn();
    const registry = new CommandRegistry({ logger: silent });
    registerSettingsVisibility({ registry, onChange });

    expect(await registry.invoke(SETTINGS_VISIBILITY_COMMAND, { open: true }, USER)).toMatchObject({ ok: true });
    expect(onChange).toHaveBeenLastCalledWith(true);
    await registry.invoke(SETTINGS_VISIBILITY_COMMAND, { open: false }, USER);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('toggles when no argument is given, which is what a menu item and a keystroke send', async () => {
    const onChange = vi.fn();
    const registry = new CommandRegistry({ logger: silent });
    registerSettingsVisibility({ registry, onChange });
    await registry.invoke(SETTINGS_VISIBILITY_COMMAND, {}, USER);
    expect(onChange).toHaveBeenLastCalledWith(true);
    await registry.invoke(SETTINGS_VISIBILITY_COMMAND, {}, USER);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('does not report a change that is not one', async () => {
    const onChange = vi.fn();
    const registry = new CommandRegistry({ logger: silent });
    registerSettingsVisibility({ registry, onChange });
    await registry.invoke(SETTINGS_VISIBILITY_COMMAND, { open: false }, USER);
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test settings-visibility`
Expected: FAIL — no such module.

- [ ] **Step 3: Implement the visibility owner**

`packages/app/src/main/settings-visibility.ts`:

```ts
import { s, type Disposable } from '@shepherd/sdk';
import type { CommandRegistry } from '@shepherd/core';

/**
 * `window.settings` — the ONE writer of "is the settings screen up".
 *
 * Main owns it rather than the renderer, and that is what makes four gestures
 * one fact: the menu item (⌘,), the keystroke in the page, the palette entry,
 * and `shepherd raw window.settings`. The renderer draws what it is told, the
 * way it draws the layout — a second copy of "what is on screen" is ADR 0035's
 * mistake, made twice already in this codebase.
 *
 * It also feeds `presence.overlay`, which is the reason it cannot live in the
 * page at all: `ViewingResolver` composes app-active, focused root, zoom
 * starvation and full-takeover into ADR 0020's single predicate, and a takeover
 * only the renderer knew about would be a second visibility check.
 *
 * **Permission: `layout`.** `window.reload` took it for the same argument — it
 * already means "this caller may arrange what is on your screen", and covering
 * the grid with a screen belongs to that rather than to a new permission with
 * one member.
 */
export const SETTINGS_VISIBILITY_COMMAND = 'window.settings';

export interface SettingsVisibilityOptions {
  readonly registry: CommandRegistry;
  /** Called only on a real change, with the state that now holds. */
  readonly onChange: (open: boolean) => void;
}

export function registerSettingsVisibility(options: SettingsVisibilityOptions): Disposable {
  const { registry, onChange } = options;
  let open = false;

  return registry.register(SETTINGS_VISIBILITY_COMMAND, {
    title: 'Open Settings',
    permission: 'layout',
    // Absent `open` TOGGLES, because that is what a menu item and a keystroke
    // mean; a caller that wants a state says so.
    schema: s.object({ open: s.optional(s.boolean()) }),
    handler: (args) => {
      const next = args.open ?? !open;
      if (next !== open) {
        open = next;
        onChange(open);
      }
      return { open };
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test settings-visibility`
Expected: PASS.

- [ ] **Step 5: Add the channels, the DTOs and the preload group**

`packages/app/src/shared/channels.ts` — in `INVOKE`:

```ts
  /**
   * The settings screen's three verbs. Pull-shaped like `layoutGet`: the page
   * asks on mount and follows `EMIT.settingsChanged`, so an HMR remount
   * re-pulls for free.
   */
  settingsList: 'settings:list',
  settingsSet: 'settings:set',
  settingsReset: 'settings:reset',
  /** "Put the screen up / take it down." Main owns the state; this asks it to move. */
  settingsOpen: 'settings:open',
```

in `EMIT`:

```ts
  /** One setting changed, whoever changed it (the screen, the CLI, an extension). */
  settingsChanged: 'settings:changed',
  /** Whether the settings screen is up. Main's word — see `settings-visibility.ts`. */
  settingsVisibility: 'settings:visibility',
```

`packages/app/src/shared/bridge.ts` — the DTOs and `SettingsApi` exactly as in this task's Interfaces block, with `SettingSpec`/`SettingValue` type-imported from `@shepherd/sdk` (shared code may import the SDK; it may import neither electron nor react). Export them from `packages/app/src/shared/index.ts`.

`packages/app/src/preload/api.ts` — beside `window`:

```ts
    /**
     * Settings. Note what the page can ask for: the pages that exist, a write,
     * a reset, and to be told when either the values or the screen's visibility
     * changed. It cannot name a bus topic and cannot name a caller — main
     * attributes a write to the user, which is correct here for the palette's
     * reason: the user is typing in their own settings screen.
     */
    settings: {
      list: () => invoke(INVOKE.settingsList),
      set: (key: string, value: unknown) => invoke(INVOKE.settingsSet, key, value),
      reset: (key: string) => invoke(INVOKE.settingsReset, key),
      setOpen: (open: boolean) => invoke(INVOKE.settingsOpen, open),
      onChanged: (listener) => subscribe(EMIT.settingsChanged, listener),
      onVisibility: (listener) => subscribe<boolean>(EMIT.settingsVisibility, listener),
    },
```

- [ ] **Step 6: Implement the main-side IPC**

`packages/app/src/main/settings-ipc.ts`, following `layout-ipc.ts`'s shape exactly (same `ipcMain.handle` wrapper, same `IpcResult` construction, same `webContents.send` helper). It:

- handles `INVOKE.settingsList` by invoking `SETTINGS_COMMANDS.list` through the registry as `USER` — never by reading `SettingsRegistry` directly, so the page and the CLI go through one path;
- handles `settingsSet` / `settingsReset` / `settingsOpen` the same way, mapping a failed command to a failed `IpcResult` carrying the command's message;
- subscribes to `SETTINGS_CHANGED_TOPIC` on the bus and pushes `EMIT.settingsChanged`;
- exposes `pushVisibility(open: boolean)` so `index.ts` can send `EMIT.settingsVisibility` from the command's `onChange`.

- [ ] **Step 7: Wire main, the menu and presence**

In `packages/app/src/main/index.ts`:

```ts
/** Whether the settings screen covers the grid. One writer: `window.settings`. */
let settingsOpen = false;
```

then inside `whenReady`, beside the other registrations:

```ts
  const settingsIpc = registerSettingsIpc({ registry, bus, window: () => mainWindow, logger });
  registerSettingsVisibility({
    registry,
    onChange: (open) => {
      settingsOpen = open;
      // Both halves, from the one signal: the page draws it, and the predicate
      // stops reporting that anybody is looking at a pane behind it.
      settingsIpc.pushVisibility(open);
      syncPresence();
    },
  });
```

and change `syncPresence` (:442) so `overlay` is no longer a literal:

```ts
    // A full-takeover screen hides every pane. `api-layout.ts` promised this
    // clause and nothing implemented it until the settings screen existed.
    overlay: settingsOpen,
```

In `menu-template.ts`, add to the app submenu after `About`:

```ts
        { type: 'separator' },
        {
          id: COMMANDS.openSettings,
          label: 'Settings…',
          // The macOS-standard accelerator, and safe in the menu: AppKit
          // resolving ⌘, first costs nothing, unlike ⌘F or ⌘K — neither of
          // which could then be used to close the thing it opened.
          accelerator: 'CmdOrCtrl+,',
          command: COMMANDS.openSettings,
        },
```

with `openSettings: 'app.openSettings'` in `shared/commands.ts` and, in `shared/menu-commands.ts`:

```ts
  [COMMANDS.openSettings]: { command: SETTINGS_VISIBILITY_COMMAND, args: {} },
```

`unmappedCommands()` already guards the pairing; `menu-template.test.ts` has an accelerator audit that will check the new item.

- [ ] **Step 8: Run the gate**

Run: `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`
Expected: PASS, including the menu template's own tests.

- [ ] **Step 9: Commit**

```bash
git add packages/app/src
git commit -m "feat(app): the settings bridge, and main as the one owner of whether it is up"
```

---

### Task 7: The settings screen (renderer)

**Files:**
- Create: `packages/app/src/renderer/settings-screen.tsx`, `settings-screen.test.tsx`, `settings-rows.tsx`, `settings-rows.test.tsx`, `settings-filter.ts`, `settings-filter.test.ts`, `settings.css`
- Modify: `packages/app/src/renderer/app.tsx` (mount it beside `ViewOverlay` at :531; bind nothing new for ⌘, — the menu owns it), `packages/app/src/renderer/styles.css` (`@import './settings.css';`)

**Interfaces:**
- Consumes: `SettingsApi`, `SettingsSnapshotDTO`, `SettingsPageDTO` (Task 6); `Switch`, `Select`, `Field`, `Button`, `IconButton`, `SectionLabel`, `Row`, `useBrailleFrame` from `@shepherd/ui`; `resolveExtensionUi` from `./extension-ui.ts`; `ComponentView` from `./view-dock.tsx`.
- Produces: `SettingsScreen({ settings, views, onClose })`, `SettingRow({ spec, value, isDefault, choices, busy, onChange, onReset })`, `filterPages(pages, query): readonly SettingsPageDTO[]`.

- [ ] **Step 1: Write the failing filter test**

`packages/app/src/renderer/settings-filter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { filterPages } from './settings-filter.ts';
import type { SettingsPageDTO } from '../shared/index.ts';

const pages: readonly SettingsPageDTO[] = [
  {
    id: 'shepherd.general',
    title: 'General',
    owner: 'shepherd',
    settings: [
      { key: 'shepherd.theme', type: 'enum', label: 'Theme', default: 'system', description: 'Follow the system' },
    ],
  },
  {
    id: 'agents.models',
    title: 'Models',
    owner: 'shepherd.agents-core',
    settings: [{ key: 'agents-core.quickModel', type: 'string', label: 'Quick-tier model', default: 'sonnet' }],
  },
  { id: 'w.editor', title: 'Worktree hooks', owner: 'shepherd.worktree-hook', component: 'worktree-hook.editor' },
];

describe('filterPages', () => {
  it('returns every page for an empty query', () => {
    expect(filterPages(pages, '').map((page) => page.id)).toEqual(['shepherd.general', 'agents.models', 'w.editor']);
  });

  it('keeps a page whose row label matches, and only the matching rows', () => {
    const found = filterPages(pages, 'quick');
    expect(found.map((page) => page.id)).toEqual(['agents.models']);
    expect(found[0]?.settings?.map((spec) => spec.key)).toEqual(['agents-core.quickModel']);
  });

  it('matches a description as well as a label', () => {
    expect(filterPages(pages, 'follow').map((page) => page.id)).toEqual(['shepherd.general']);
  });

  it('keeps a component page on a TITLE match only, because the shell cannot see inside it', () => {
    expect(filterPages(pages, 'worktree').map((page) => page.id)).toEqual(['w.editor']);
    expect(filterPages(pages, 'script').map((page) => page.id)).toEqual([]);
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(filterPages(pages, '  THEME ').map((page) => page.id)).toEqual(['shepherd.general']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test settings-filter`
Expected: FAIL.

- [ ] **Step 3: Implement the filter**

`packages/app/src/renderer/settings-filter.ts`:

```ts
import type { SettingsPageDTO } from '../shared/index.ts';

/**
 * The search, and the one thing it cannot do.
 *
 * A component page is matched on its TITLE alone: its body is an extension's
 * React module and the shell cannot read a label out of it. Stated here rather
 * than left implicit, because a search that silently omitted half the settings
 * would be worse than one whose limit is written down.
 */
export function filterPages(pages: readonly SettingsPageDTO[], query: string): readonly SettingsPageDTO[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return pages;

  const kept: SettingsPageDTO[] = [];
  for (const page of pages) {
    const titleHit = page.title.toLowerCase().includes(needle);
    if (page.settings === undefined) {
      if (titleHit) kept.push(page);
      continue;
    }
    const rows = page.settings.filter(
      (spec) =>
        spec.label.toLowerCase().includes(needle) ||
        (spec.description ?? '').toLowerCase().includes(needle) ||
        spec.key.toLowerCase().includes(needle),
    );
    // A title hit keeps the whole page: somebody who typed the section's name
    // is looking for the section, not for one row in it.
    if (titleHit) kept.push(page);
    else if (rows.length > 0) kept.push({ ...page, settings: rows });
  }
  return kept;
}
```

- [ ] **Step 4: Write the failing row test**

`packages/app/src/renderer/settings-rows.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { mount } from './test-dom.ts';
import { SettingRow } from './settings-rows.tsx';

const base = { isDefault: true, onChange: () => {}, onReset: () => {} };

describe('SettingRow', () => {
  it('draws a boolean as a Switch and reports the flipped value', () => {
    const onChange = vi.fn();
    const { container } = mount(
      <SettingRow
        {...base}
        spec={{ key: 'x.flag', type: 'boolean', label: 'Flag', default: false }}
        value={false}
        onChange={onChange}
      />,
    );
    act(() => container.querySelector<HTMLElement>('[role="switch"]')?.click());
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('draws a string as a Field and reports what was typed', () => {
    const onChange = vi.fn();
    const { container } = mount(
      <SettingRow
        {...base}
        spec={{ key: 'x.name', type: 'string', label: 'Name', default: '' }}
        value=""
        onChange={onChange}
      />,
    );
    const input = container.querySelector<HTMLInputElement>('input');
    act(() => {
      input!.value = 'hello';
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('hello');
  });

  it('draws an enum with static choices as a Select', () => {
    const { container } = mount(
      <SettingRow
        {...base}
        spec={{
          key: 'x.theme',
          type: 'enum',
          label: 'Theme',
          default: 'dark',
          choices: [{ value: 'dark', label: 'Dark' }],
        }}
        value="dark"
      />,
    );
    expect(container.querySelector('[data-testid="select-trigger"]')).not.toBeNull();
  });

  it('shows no reset affordance for an untouched value, and one for a changed value', () => {
    const untouched = mount(
      <SettingRow {...base} spec={{ key: 'x.n', type: 'string', label: 'N', default: 'a' }} value="a" />,
    );
    expect(untouched.container.querySelector('[data-testid="setting-reset"]')).toBeNull();
    const changed = mount(
      <SettingRow
        {...base}
        isDefault={false}
        spec={{ key: 'x.n', type: 'string', label: 'N', default: 'a' }}
        value="b"
      />,
    );
    expect(changed.container.querySelector('[data-testid="setting-reset"]')).not.toBeNull();
  });

  it('leaves a dynamic enum editable when its choices failed to load', () => {
    // The vendor could not be asked. The setting must not become unreachable —
    // a stored value you cannot see is a setting you cannot undo.
    const { container } = mount(
      <SettingRow
        {...base}
        spec={{ key: 'x.model', type: 'enum', label: 'Model', default: null, nullable: true, choicesFrom: 'x.models' }}
        value="opus"
        choicesError="x.models is not a registered command"
        value2={undefined as never}
      />,
    );
    expect(container.querySelector('input')).not.toBeNull();
    expect(container.textContent).toContain('not a registered command');
  });
});
```

Drop the stray `value2` line when you write the real file — it is not a prop. The last case's props are `spec`, `value`, `choicesError`.

- [ ] **Step 5: Implement the rows**

`packages/app/src/renderer/settings-rows.tsx` — one component, a `switch` on `spec.type`, and the only file in the app that knows a type maps to a control:

```tsx
import type { ReactElement } from 'react';
import { Button, Field, Select, Switch, type SelectOption } from '@shepherd/ui';
import type { SettingSpec, SettingValue } from '@shepherd/sdk';

export interface SettingRowProps {
  readonly spec: SettingSpec;
  readonly value: SettingValue;
  readonly isDefault: boolean;
  /** Resolved `choicesFrom` options. Absent while they are still being asked for. */
  readonly choices?: readonly SelectOption[];
  readonly busy?: boolean;
  /** Why the choices could not be fetched. The row falls back to free text. */
  readonly choicesError?: string;
  readonly onChange: (next: SettingValue) => void;
  readonly onReset: () => void;
}

export function SettingRow(props: SettingRowProps): ReactElement { /* … */ }
```

Rules the implementation must hold, each asserted above:

- The label and description are the row's text; the control sits to the right.
- `boolean` → `Switch` with `label={spec.label}`. `number` → `Field type="number"`, reporting a parsed number and refusing to report `NaN`. `string` / `path` → `Field`. `enum` → `Select` (`nullable={spec.nullable === true}`, `busy`), except when `choicesError` is set, where it degrades to a `Field` showing the error as its `message`.
- A reset control (`data-testid="setting-reset"`, an `IconButton` or a small `Button`) renders **only** when `isDefault` is false.
- No colour, no hue, no hard-coded pixel that is not a `--sh-*` metric.

- [ ] **Step 6: Write the failing screen test**

`packages/app/src/renderer/settings-screen.test.tsx` — the load-bearing claims:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { mount } from './test-dom.ts';
import { SettingsScreen } from './settings-screen.tsx';

function fakeSettings(over: Partial<Record<string, unknown>> = {}) {
  return {
    list: vi.fn(async () => ({
      ok: true as const,
      value: {
        pages: [
          {
            id: 'shepherd.general',
            title: 'General',
            owner: 'shepherd',
            settings: [
              { key: 'shepherd.theme', type: 'enum', label: 'Theme', default: 'system', choices: [
                { value: 'system', label: 'System' },
                { value: 'dark', label: 'Dark' },
              ] },
            ],
          },
          { id: 'w.editor', title: 'Worktree hooks', owner: 'shepherd.worktree-hook', component: 'worktree-hook.editor' },
        ],
        values: { 'shepherd.theme': 'system' },
        defaults: ['shepherd.theme'],
      },
    })),
    set: vi.fn(async () => ({ ok: true as const, value: undefined })),
    reset: vi.fn(async () => ({ ok: true as const, value: undefined })),
    setOpen: vi.fn(async () => ({ ok: true as const, value: undefined })),
    onChanged: vi.fn(() => () => {}),
    onVisibility: vi.fn(() => () => {}),
    ...over,
  };
}

describe('SettingsScreen', () => {
  it('draws General first and every contributed page after it', async () => {
    const settings = fakeSettings();
    const ui = mount(<SettingsScreen settings={settings as never} views={null} onClose={() => {}} />);
    await act(async () => {});
    const nav = [...ui.container.querySelectorAll('[data-testid="settings-nav-item"]')].map((el) => el.textContent);
    expect(nav?.[0]).toContain('General');
    expect(nav?.[1]).toContain('Worktree hooks');
  });

  it('writes through the bridge when a row changes', async () => {
    const settings = fakeSettings();
    const ui = mount(<SettingsScreen settings={settings as never} views={null} onClose={() => {}} />);
    await act(async () => {});
    act(() => ui.container.querySelector<HTMLElement>('[data-testid="select-trigger"]')?.click());
    const options = [...ui.container.querySelectorAll<HTMLElement>('[role="option"]')];
    act(() => options[1]?.click());
    expect(settings.set).toHaveBeenCalledWith('shepherd.theme', 'dark');
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    mount(<SettingsScreen settings={fakeSettings() as never} views={null} onClose={onClose} />);
    await act(async () => {});
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on the back control', async () => {
    const onClose = vi.fn();
    const ui = mount(<SettingsScreen settings={fakeSettings() as never} views={null} onClose={onClose} />);
    await act(async () => {});
    act(() => ui.container.querySelector<HTMLElement>('[data-testid="settings-back"]')?.click());
    expect(onClose).toHaveBeenCalled();
  });

  it('filters the nav as you search', async () => {
    const ui = mount(<SettingsScreen settings={fakeSettings() as never} views={null} onClose={() => {}} />);
    await act(async () => {});
    const search = ui.container.querySelector<HTMLInputElement>('[data-testid="settings-search"]');
    act(() => {
      search!.value = 'worktree';
      search!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const nav = [...ui.container.querySelectorAll('[data-testid="settings-nav-item"]')].map((el) => el.textContent);
    expect(nav).toHaveLength(1);
    expect(nav[0]).toContain('Worktree hooks');
  });

  it('re-reads its values when the bridge announces a change from somewhere else', async () => {
    let announce: ((change: { key: string; value: unknown }) => void) | undefined;
    const settings = fakeSettings({
      onChanged: vi.fn((listener: (change: { key: string; value: unknown }) => void) => {
        announce = listener;
        return () => {};
      }),
    });
    mount(<SettingsScreen settings={settings as never} views={null} onClose={() => {}} />);
    await act(async () => {});
    expect(settings.list).toHaveBeenCalledTimes(1);
    await act(async () => announce?.({ key: 'shepherd.theme', value: 'dark' }));
    // The CLI is a second writer; a screen that trusted its own last write would
    // be stale the moment somebody typed `shepherd settings` in a pane behind it.
    expect(settings.list).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 7: Implement the screen**

`packages/app/src/renderer/settings-screen.tsx`. Shape:

- Fetches `settings.list()` on mount, re-fetches on `onChanged`.
- Holds `query`, `activePageId` (defaulting to the first page after filtering).
- Renders `<section className="sh-settings">` with a header (back `IconButton` — `data-testid="settings-back"`; the heading; a `Field data-testid="settings-search"`), a nav (`data-testid="settings-nav-item"` per page, with the owner as a subtitle when the owner is not `shepherd`), and a page area.
- For a spec page: rows grouped by `spec.group` under `SectionLabel`s, each a `SettingRow` whose `onChange` calls `settings.set(key, value)` and whose `onReset` calls `settings.reset(key)`. On a failed write, keep the row's own error visible; never swallow it.
- For a component page: `resolveExtensionUi(page.component)` and render it through the same `ComponentView` the dock and the overlay use, so `invoke`/`done` attribution stays main's (D14). An unresolved name draws an `Empty` saying the extension asked for a UI module this build does not contain — the correct failure, per ADR 0033.
- `choicesFrom`: when the active page has one, invoke that command **once per page open** through `views`/`commands`, parse the answer with a schema (it is `unknown` and a cast is not a check), and pass `choices` / `busy` / `choicesError` down.
- Esc: a `window` keydown listener in capture, live only while mounted, calling `onClose`.

`packages/app/src/renderer/settings.css` — `.sh-settings` is `position: absolute; inset: 0;` inside `.sh-app`, with an opaque `--sh-*` background, a two-column grid (nav / page), and the page area scrolling in its own `overflow-y: auto`.

- [ ] **Step 8: Mount it in `app.tsx`**

Below `<ViewOverlay …/>` at :531:

```tsx
      {/*
        The takeover layer.

        Mounted only while open, and painted OVER `.sh-body` rather than instead
        of it: every root underneath stays mounted, so every pty keeps running
        and comes back exactly as it was. A conditional mount around the stage is
        v1's `_ConditionalContent` lesson — a torn-down pane is a released
        terminal and then, on the way back, a second pty.

        Whether it is open is MAIN's answer (`window.settings`), so the menu
        item, the palette entry and `shepherd raw window.settings` all move one
        variable — and the same variable is what stops `isViewing` from
        reporting that somebody is looking at a pane behind this.
      */}
      {settingsOpen && (
        <SettingsScreen
          settings={settingsApi}
          views={viewsApi}
          onClose={() => {
            void settingsApi?.setOpen(false);
            // Hand the keyboard back to the pane the user was reading — the fix
            // `FindBar` carries, for the same reason.
            if (focusedPaneId !== null) terminals?.focus(paneId(focusedPaneId));
          }}
        />
      )}
```

with `const [settingsOpen, setSettingsOpen] = useState(false);` fed by `settingsApi.onVisibility` in an effect, exactly the way `layout.onChanged` is consumed.

- [ ] **Step 9: Run everything**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test settings` then the full gate, then `env -u NODE_OPTIONS pnpm smoke:m3`.
Expected: PASS. Then `env -u NODE_OPTIONS pnpm dev`, press ⌘,: the screen covers the window, General is selected, Esc returns you to the pane you left with its output intact.

- [ ] **Step 10: Commit**

```bash
git add packages/app/src/renderer
git commit -m "feat(renderer): the settings screen — a takeover layer over live panes"
```

---

### Task 8: Theme, end to end

**Files:**
- Modify: `packages/app/src/renderer/theme.ts` (`DEFAULT_THEME_MODE` at :16), `packages/app/src/renderer/app.tsx`, `packages/app/src/renderer/pane-sessions.ts` (`PaneTerminals` at :109), `packages/app/src/renderer/xterm-terminal.ts:31`
- Test: `packages/app/src/renderer/theme.test.ts` (exists), `packages/app/src/renderer/pane-sessions.test.ts` (exists)

**Interfaces:**
- Produces: `resolveThemeMode(setting: ThemeSetting, prefersDark: boolean): ThemeMode`; `PaneTerminals.retheme(mode: ThemeMode): void`; `ShepherdTerminal.setTheme(mode: ThemeMode): void`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/app/src/renderer/theme.test.ts`:

```ts
describe('resolveThemeMode', () => {
  it('pins to what was chosen', () => {
    expect(resolveThemeMode('dark', true)).toBe('dark');
    expect(resolveThemeMode('dark', false)).toBe('dark');
    expect(resolveThemeMode('light', true)).toBe('light');
  });

  it('follows the OS for `system`', () => {
    expect(resolveThemeMode('system', true)).toBe('dark');
    expect(resolveThemeMode('system', false)).toBe('light');
  });
});
```

and to `packages/app/src/renderer/pane-sessions.test.ts`:

```ts
it('re-themes every live terminal without rebuilding one', () => {
  // The claim that matters is the count: a theme change must not cost a new
  // xterm, because a rebuilt terminal is a released pty and a lost scrollback.
  const registry = /* the harness this file already uses */;
  registry.attach(pane, host);
  const built = fakeTerminals.length;
  registry.retheme('light');
  expect(fakeTerminals.length).toBe(built);
  expect(fakeTerminals[0]?.themes).toEqual(['light']);
});
```

Extend the fake terminal in `test-terminals.ts` with a `themes: string[]` array its `setTheme` pushes to.

- [ ] **Step 2: Run them to verify they fail**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test theme pane-sessions`
Expected: FAIL — `resolveThemeMode` and `retheme` do not exist.

- [ ] **Step 3: Implement**

In `theme.ts`:

```ts
/**
 * The mode this build starts in, BEFORE the settings bridge answers.
 *
 * It stopped being the answer when `shepherd.theme` landed: it is the value the
 * first paint uses, and one push later the user's choice replaces it. Left dark
 * because a flash of light on a dark setup is the worse of the two.
 */
export const DEFAULT_THEME_MODE: ThemeMode = 'dark';

/**
 * `shepherd.theme` → the mode to paint.
 *
 * `system` is resolved in the renderer against `matchMedia`, one place, and it
 * re-resolves on its own when the OS flips — an Electron `nativeTheme` mirror in
 * main would be a second copy of an answer the page can already see.
 */
export function resolveThemeMode(setting: ThemeSetting, prefersDark: boolean): ThemeMode {
  return setting === 'system' ? (prefersDark ? 'dark' : 'light') : setting;
}
```

In `xterm-terminal.ts`, add `setTheme(mode)` to the terminal it builds — `term.options.theme = xtermTheme(mode)` plus `term.options.minimumContrastRatio = minimumContrastRatio(paneTitleSurface(xtermTheme(mode).background))`, so the measured-background rule at :39 keeps holding after a swap — and expose it on the interface at :72-89.

In `pane-sessions.ts`, add `retheme(mode: ThemeMode): void` to `PaneTerminals` and implement it on the registry by walking its live entries and calling `setTheme`. No rebuild.

In `app.tsx`, one effect:

```tsx
  /**
   * The theme, in both halves.
   *
   * `applyThemeVariables` paints the chrome and `terminals.retheme` paints every
   * grid. BOTH, or the app runs on two palettes — which is exactly what
   * `theme.ts`'s "one token map" comment exists to prevent.
   */
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const paint = (): void => {
      const mode = resolveThemeMode(themeSetting, query.matches);
      applyThemeVariables(document.documentElement, mode);
      terminals?.retheme(mode);
    };
    paint();
    query.addEventListener('change', paint);
    return () => query.removeEventListener('change', paint);
  }, [themeSetting, terminals]);
```

where `themeSetting` comes from a small `useSetting(settingsApi, THEME_KEY)` hook: the bridge's `list()` on mount, followed by `onChanged`, parsing the value and falling back to `'system'` on anything unexpected. `THEME_KEY` is `'shepherd.theme'`; import it from a shared constant rather than typing the string twice.

- [ ] **Step 4: Run the tests**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/app test theme pane-sessions`
Expected: PASS.

- [ ] **Step 5: Verify by hand**

`env -u NODE_OPTIONS pnpm dev`, ⌘,, switch Theme to Light: the chrome and the terminal grid both change, with no relaunch and no pane rebuilt (the shell output in your panes is still there). Switch to System and flip macOS's appearance: the app follows.

- [ ] **Step 6: Full gate and commit**

```bash
git add packages/app/src/renderer
git commit -m "feat(renderer): light mode — shepherd.theme, chrome and grid together"
```

---

### Task 9: `agents-core` — the schema half, and one value instead of two

**Files:**
- Modify: `extensions/agents-core/src/manifest.ts`, `extensions/agents-core/package.json` (the `shepherd` key — must stay field-for-field equal), `extensions/agents-core/src/index.ts` (:126 `readOverride`, :413 the `complete` handler, :445 the `quickModel` verb), `extensions/agents-core/src/quick-model.ts`
- Test: `extensions/agents-core/src/quick-model.test.ts`, `extensions/agents-core/src/manifest.test.ts`

**Interfaces:**
- Produces: `QUICK_KIND_SETTING = 'agents-core.quickKind'`, `QUICK_MODEL_SETTING = 'agents-core.quickModel'`, `AGENTS_MODELS_PAGE: SettingsPage`, `AGENTS_COMMANDS.quickChoices = 'agents.quickModelChoices'`, `migrateQuickOverride(stored, settings): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

In `extensions/agents-core/src/quick-model.test.ts`:

```ts
describe('the settings-backed override', () => {
  it('reads kind and model from the two settings keys', () => {
    expect(overrideFromSettings({ 'agents-core.quickKind': 'claude-code', 'agents-core.quickModel': 'opus' })).toEqual({
      kind: 'claude-code',
      model: 'opus',
    });
  });

  it('reads null as absent, so the extension's own fallback still applies', () => {
    // `null` is a nullable spec's "unset" — "whichever capable kind is first",
    // which only this extension can compute. It must not reach `resolveQuick`
    // as a kind id.
    expect(overrideFromSettings({ 'agents-core.quickKind': null, 'agents-core.quickModel': null })).toBeUndefined();
  });

  it('keeps a model choice when only the kind is unset', () => {
    expect(overrideFromSettings({ 'agents-core.quickKind': null, 'agents-core.quickModel': 'opus' })).toEqual({
      model: 'opus',
    });
  });
});

describe('migrateQuickOverride', () => {
  it('moves a v1 KV override into settings and deletes the key', async () => {
    const storage = fakeKv({ 'quick-model': { kind: 'claude-code', model: 'opus' } });
    const settings = fakeSettings();
    await migrateQuickOverride(storage, settings);
    expect(settings.writes).toEqual([
      ['agents-core.quickKind', 'claude-code'],
      ['agents-core.quickModel', 'opus'],
    ]);
    expect(storage.deleted).toEqual(['quick-model']);
  });

  it('does nothing on a second run, because the key is gone', async () => {
    const storage = fakeKv({});
    const settings = fakeSettings();
    await migrateQuickOverride(storage, settings);
    expect(settings.writes).toEqual([]);
  });

  it('does not overwrite a settings value the user has already chosen', async () => {
    const storage = fakeKv({ 'quick-model': { model: 'opus' } });
    const settings = fakeSettings({ 'agents-core.quickModel': 'haiku' });
    await migrateQuickOverride(storage, settings);
    expect(settings.writes).toEqual([]);
    // The stale key still goes, or the migration runs forever.
    expect(storage.deleted).toEqual(['quick-model']);
  });
});
```

Write `fakeKv` and `fakeSettings` locally in the test file (a `Map` plus a `writes`/`deleted` log). In `manifest.test.ts`, add:

```ts
it('declares its settings page inside its own namespace', () => {
  const pages = agentsCoreManifest.contributes?.settings ?? [];
  const keys = pages.flatMap((page) => (page.settings ?? []).map((spec) => spec.key));
  expect(keys).toEqual(['agents-core.quickKind', 'agents-core.quickModel']);
  expect(pageIssues(pages[0]!, 'agents-core')).toEqual([]);
});

it('names no vendor anywhere in that page', () => {
  // D11: the moment a consumer names a vendor it has learned which agent it
  // hired. The model list arrives as DATA from the kind that registered it.
  expect(JSON.stringify(agentsCoreManifest.contributes?.settings)).not.toMatch(/claude/i);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-agents-core test`
Expected: FAIL.

- [ ] **Step 3: Add the page to the manifest**

In `extensions/agents-core/src/manifest.ts`, replace the `QUICK_MODEL_KEY` comment block's promise with the thing it promised:

```ts
/**
 * The user's quick-tier choice, in this extension's own KV — **the pre-settings
 * key, kept only so it can be migrated.**
 *
 * The comment that used to be here said "when a settings system lands this
 * becomes a row in it and no consumer changes". It landed (spec 2026-08-11), and
 * this is now read exactly once per install by `migrateQuickOverride`.
 */
export const QUICK_MODEL_KEY = 'quick-model';

export const QUICK_KIND_SETTING = 'agents-core.quickKind';
export const QUICK_MODEL_SETTING = 'agents-core.quickModel';

/**
 * The quick tier, as settings.
 *
 * Both enums resolve their options through a COMMAND rather than a static list,
 * and that is the rule rather than convenience: the kinds that can serve the
 * quick tier are whatever registered into the point, and their model ids belong
 * to the vendor and change without a release. So the choices arrive as data from
 * the vendor's own extension, and no vendor is named here.
 */
export const AGENTS_MODELS_PAGE: SettingsPage = {
  id: 'agents.models',
  title: 'Models',
  order: 100,
  settings: [
    {
      key: QUICK_KIND_SETTING,
      type: 'enum',
      label: 'Quick-tier agent',
      description: 'Which agent answers short, non-interactive questions.',
      default: null,
      nullable: true,
      choicesFrom: AGENTS_COMMANDS.quickChoices,
    },
    {
      key: QUICK_MODEL_SETTING,
      type: 'enum',
      label: 'Quick-tier model',
      description: 'Left as Default, the chosen agent picks its own quick model.',
      default: null,
      nullable: true,
      choicesFrom: AGENTS_COMMANDS.quickChoices,
    },
  ],
};
```

Add `quickChoices: 'agents.quickModelChoices'` to `AGENTS_COMMANDS`, `'settings'` to the manifest's `permissions`, and `contributes.settings: [AGENTS_MODELS_PAGE]`. Mirror **all** of it into `extensions/agents-core/package.json`'s `shepherd` key — `manifest.test.ts` compares them field for field.

- [ ] **Step 4: Read and write through settings**

In `extensions/agents-core/src/quick-model.ts`, add the two pure functions:

```ts
/**
 * The two settings keys → the override `resolveQuick` takes.
 *
 * `null` is dropped rather than passed through: a nullable spec's null means
 * "the extension's own fallback", and `resolveQuick` reads a *present* `kind` as
 * "this kind or nothing at all" — so a null arriving as a kind id would resolve
 * to no agent and look like a broken install.
 */
export function overrideFromSettings(values: Readonly<Record<string, unknown>>): QuickOverride | undefined {
  const kind = values[QUICK_KIND_SETTING];
  const model = values[QUICK_MODEL_SETTING];
  const override: QuickOverride = {
    ...(typeof kind === 'string' && kind !== '' ? { kind } : {}),
    ...(typeof model === 'string' && model !== '' ? { model } : {}),
  };
  return override.kind === undefined && override.model === undefined ? undefined : override;
}
```

and the migration (in `quick-model.ts` beside it, since it is the same subject):

```ts
/**
 * The pre-settings KV key, moved once.
 *
 * Runs on activation, before anything reads the override. Three rules, each with
 * a failure behind it: it never overwrites a settings value the user already
 * chose, it deletes the old key even when it wrote nothing (or the migration
 * runs on every launch forever), and a malformed blob is dropped rather than
 * throwing — a preference that cannot be parsed must not stop this extension
 * from activating.
 */
export async function migrateQuickOverride(storage: KV, settings: SettingsAPI): Promise<void> { /* … */ }
```

In `index.ts`, replace `readOverride` (:126) with a read through the settings API — `overrideFromSettings({ [QUICK_KIND_SETTING]: settings.get(QUICK_KIND_SETTING, nullableString), … })` — call `migrateQuickOverride` during activation, and change the `quickModel` verb's handler (:458) to write through `settings.set` instead of `ctx.storage`, keeping `applyOverride`'s merge semantics by writing only the fields the caller named and calling `settings.set(key, null)` for a `clear`. Register `AGENTS_COMMANDS.quickChoices`, answering `SettingChoice[]` built from `kinds.all()`: one entry per capable kind for the kind setting, and each kind's advertised quick model for the model setting. The verb takes `{ key: string }` so one command can serve both rows.

- [ ] **Step 5: Run the tests**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-agents-core test`
Expected: PASS.

- [ ] **Step 6: Verify the two paths agree**

`env -u NODE_OPTIONS pnpm ship --dev`, then in a pane of the night build: `shepherd agent quick-model` shows the current resolution; open ⌘, → Models and change the model; run `shepherd agent quick-model` again — it reports the new one. Then change it back from the CLI and watch the open settings screen update itself (that is the `settings.changed` push, and it is the assertion the screen's own test makes with a fake).

- [ ] **Step 7: Full gate and commit**

```bash
git add extensions/agents-core
git commit -m "feat(agents-core): the quick tier as settings, with its KV key migrated once"
```

---

### Task 10: `worktree-hook` — the component half

**Files:**
- Modify: `extensions/worktree-hook/src/manifest.ts`, `extensions/worktree-hook/package.json`, `extensions/worktree-hook/src/index.ts:244-263`, `extensions/worktree-hook/README.md`
- Test: `extensions/worktree-hook/src/manifest.test.ts`

**Interfaces:**
- Consumes: `WORKTREE_HOOK_VIEW` (`'worktree-hook.editor'`) — unchanged, and still the key of the renderer's `EXTENSION_UI` table.
- Produces: `WORKTREE_HOOK_PAGE: SettingsPage`.

- [ ] **Step 1: Write the failing test**

In `extensions/worktree-hook/src/manifest.test.ts`:

```ts
it('contributes its editor as a settings page and no longer as an overlay', () => {
  const pages = worktreeHookManifest.contributes?.settings ?? [];
  expect(pages).toEqual([
    { id: 'worktreeHook.editor', title: 'Worktree hooks', order: 200, component: WORKTREE_HOOK_VIEW },
  ]);
});

it('declares no accelerator of its own any more', () => {
  // The gear button and ⌘⇧H existed only because there was no settings surface.
  // Now that there is one, a second way in is a second thing to keep true.
  expect(JSON.stringify(worktreeHookManifest)).not.toContain('CmdOrCtrl+Shift+H');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-worktree-hook test`
Expected: FAIL.

- [ ] **Step 3: Move the editor**

In `manifest.ts`: delete `WORKTREE_HOOK_KEY`, add

```ts
/**
 * The editor, where it always belonged.
 *
 * `index.ts` carried the note "a view of its own ONLY because v2 has no
 * settings surface yet. When there is one this belongs inside it." This is that
 * — and it is the component escape hatch's first consumer, which is what makes
 * the seam a mechanism rather than a paragraph: a per-repo script editor is not
 * a row of widgets, and a schema stretched until it could express one would be a
 * UI toolkit in a JSON file.
 */
export const WORKTREE_HOOK_PAGE: SettingsPage = {
  id: 'worktreeHook.editor',
  title: 'Worktree hooks',
  order: 200,
  component: WORKTREE_HOOK_VIEW,
};
```

and `contributes.settings: [WORKTREE_HOOK_PAGE]`, mirrored into `package.json`.

In `index.ts`, delete the `views.registerViewType(WORKTREE_HOOK_VIEW, …)` block at :251-263 along with its `surface`, `key` and `icon`, and replace its comment with one sentence saying the editor is now a settings page and the manifest declares it. If `views` and the `views` permission become unused, remove them — an unused permission in a manifest is a grant nobody can justify at review.

Update `extensions/worktree-hook/README.md` where it says the editor is an overlay pending a settings surface.

- [ ] **Step 4: Run the tests**

Run: `env -u NODE_OPTIONS pnpm --filter @shepherd/ext-worktree-hook test`
Expected: PASS.

- [ ] **Step 5: Verify by hand**

`env -u NODE_OPTIONS pnpm ship --dev`: ⌘⇧H does nothing (and reaches the terminal, as any unbound key should), the gear button is gone from the sidebar header, and ⌘, → Worktree hooks shows the editor with its existing behaviour intact — set a global hook, save, reopen, it is still there.

- [ ] **Step 6: Full gate and commit**

```bash
git add extensions/worktree-hook
git commit -m "feat(worktree-hook): the editor moves into settings, where its own comment said it belonged"
```

---

### Task 11: The smoke — what no unit test can reach

A green unit suite is not a working app, and this repo has the scars: the archive-on-close bug passed every unit test because every one of them supplied *both halves* of the correlation.

**Files:**
- Modify: `packages/app/src/main/smoke-m3.ts`

- [ ] **Step 1: Add the assertions**

Extend the existing m3 smoke, following its own helpers and its own reporting style, with one scene:

1. Open the screen through the real command (`window.settings` with `{open:true}`) over the real bus.
2. Assert the renderer drew it: `[data-testid="settings-nav-item"]` includes General.
3. **Assert `isViewing` is false for the focused pane while it is open** — read it the way the smoke already reads kernel state, not from the renderer. This is the invariant no unit test can reach, because a test that supplies both halves of that correlation cannot discover that the two halves disagree in the app.
4. Set `shepherd.theme` to `light` through `settings.set` and assert **both** halves moved: `document.documentElement.dataset.theme === 'light'` and a live xterm's background is the light palette's.
5. Close it (`{open:false}`) and assert the session id in the focused pane is the **same** one as before it opened — the panes were never torn down.
6. Assert `isViewing` is true again for that pane.

- [ ] **Step 2: Run it**

Run: `env -u NODE_OPTIONS pnpm smoke:m3`
Expected: PASS, with the new scene's lines in the output. If step 3 passes trivially, break it on purpose (make `syncPresence` pass `overlay: false`) and confirm it fails — a negative control, because that assertion is the one most likely to be vacuous.

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/main/smoke-m3.ts
git commit -m "test(smoke): settings covers the grid, re-themes both halves, and keeps every pty"
```

---

### Task 12: Write it down

**Files:**
- Modify: `CLAUDE.md` (the v2 section), `docs/superpowers/plans/2026-08-08-v2-handoff.md`
- Create: `.claude/adr/0040-v2-settings-are-declared-in-a-manifest-and-held-by-the-kernel.md`

- [ ] **Step 1: Write the ADR**

Following the numbering and the house style of `.claude/adr/0021`–`0039`, record the three decisions a future change will otherwise re-litigate:

- **Settings are declared statically in a manifest, not registered at activate time** — so the screen opens with zero extensions activated and lazy activation survives; `choicesFrom` is the one dynamic seam and it activates exactly one extension, on demand.
- **Only non-default values are stored** — so reset is real and a changed default reaches an existing install.
- **The takeover feeds `presence.overlay` rather than checking visibility itself** — ADR 0020's single predicate, and the "full-takeover overlays" clause `api-layout.ts` had promised since M1.

Include what was rejected and why: a settings file (a watcher, precedence and parse-error UI, all deferrable), per-scope values (nobody needs a second scope; `worktree-hook` scopes inside its own component), and component pages for third parties (blocked by ADR 0033's static UI table, which is the argument for the schema half being the primary path).

- [ ] **Step 2: Update `CLAUDE.md`**

In the v2 section: add settings to what is built, name `SettingsRegistry` and the `settings.*` verbs, and add the two gotchas worth a line each — that a setting key must sit in the declaring extension's namespace and the host refuses the page otherwise, and that `settings.get` in an extension **throws** for a key it was not seeded rather than answering undefined. Correct the `@shepherd/ui` line's primitive count.

- [ ] **Step 3: Update the handoff**

Add a paragraph in the handoff's voice: what landed, the two consumers, and what is owed — the update checker's General section, a human-editable settings file, and a runtime UI loader before a third-party extension can contribute a component page.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs .claude/adr
git commit -m "docs: ADR 0040 — settings declared in a manifest, held by the kernel"
```

---

## Self-Review

**Spec coverage.** §1.1 declaration → Tasks 1, 4 (manifest seed + contribution), 9, 10. §1.2 component pages → Tasks 1, 7, 10. §1.3 the API and both access rules → Tasks 1, 2, 4. §1.4 storage, non-default-only, validation, change notification → Tasks 2, 3. §2 the takeover layer, ⌘,, Esc, focus return → Tasks 6, 7. §2.1 viewing suppression → Tasks 6, 11. §3 the frame, nav, rows, search, `choicesFrom` states → Tasks 5, 7. §4 General and theme end to end → Tasks 3, 8. §5 both consumers and the migration → Tasks 9, 10. §6 what this is not → recorded in Task 12's ADR. §7 testing → each task's own tests plus Task 11. §8 milestones → Tasks 1–4 are milestone 1–2, Task 8 is 3, Tasks 9–10 are 4.

**Known gaps, stated rather than hidden.** The spec's §3 line about a component page being unsearchable is implemented as a *title-only* match (Task 7, step 3) — slightly more than the spec promised, and the test pins it. The spec's `path` type gets no directory picker in this pass; it renders as a `Field`, and nothing in the spec promised more.

**Type consistency.** `SettingSpec` / `SettingsPage` / `SettingValue` / `SettingsError` are defined once in Task 1 and used unchanged in 2, 3, 4, 7, 9, 10. `SettingsRegistry`'s method names in Task 2's Interfaces block are the ones Tasks 3 and 4 call. `SETTINGS_COMMANDS`, `SETTINGS_CHANGED_TOPIC` and `SETTINGS_VISIBILITY_COMMAND` are spelled identically in main, in the ext-host's literals and in the smoke. `THEME_KEY` is `'shepherd.theme'` in Tasks 3, 7 and 8. `retheme` is the name in `PaneTerminals`, `pane-sessions.ts` and `app.tsx`; `setTheme` is the terminal's own. `filterPages`, `SettingRow`, `SettingsScreen`, `createSettings`, `overrideFromSettings` and `migrateQuickOverride` each appear with one signature.
