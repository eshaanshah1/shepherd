import { s, type Infer, type Schema } from './schema.ts';
import type { Disposable } from './disposable.ts';
import type { Result } from './result.ts';

/**
 * Settings — declared in a manifest, held by the kernel (spec 2026-08-11).
 *
 * The set of types is deliberately small. A widget kind is a promise the shell
 * has to keep in both themes and at every width, and `SettingsPage.component` is
 * what covers everything that is not a value you pick: `worktree-hook`'s script
 * editor is a small application, and a schema stretched until it could express
 * one would be a UI toolkit in a JSON file. The division is that a value the
 * user PICKS is a spec, and a value the user AUTHORS is a component.
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
   * MEANING — "whichever capable kind is first" — that only the extension can
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
 * Either `settings` (rows the shell draws from `@shepherd/ui`) or `component`
 * (ADR 0033: a name the renderer resolves against its own table). A page with
 * both would draw twice and a page with neither draws nothing, so `pageIssues`
 * refuses each.
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

export const settingValueSchema = s.union(s.boolean(), s.string(), s.number(), s.nullValue());

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

/** The wire shape, for `manifestSchema`'s declared type. */
export type SettingsPageWire = Infer<typeof settingsPageSchema>;

/** What a `choicesFrom` command answers. Read defensively — it crossed a port. */
export const settingChoicesSchema = s.array(settingChoiceSchema);
