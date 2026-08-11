import { ok, err, type Result } from './result.ts';
import type { SettingSpec, SettingValue, SettingsError, SettingsPage } from './api-settings.ts';

/**
 * The rules every layer shares: who owns a key, what a value may be, and what is
 * wrong with a contributed page.
 *
 * Pure and in the SDK because all four processes need the same answers — the
 * registry in core validates a write, the settings screen decides whether a row
 * is editable, an extension's page is checked at load, and a test needs none of
 * them constructed.
 */

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
      // Finite only, for `s.number`'s reason: `NaN` cannot come out of
      // `JSON.parse` but an in-process caller can pass one, and it corrupts
      // whatever reads the setting far from here.
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return refuse(`expected number, got ${typeof value === 'number' ? String(value) : typeof value}`);
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
 * A list rather than a throw at the first problem: a manifest can be wrong in
 * several ways at once, and reporting only the first makes fixing a page an
 * iterative guess.
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
    if (!spec.key.startsWith(`${namespace}.`)) {
      issues.push(
        `${where}: "${spec.key}" is outside the namespace "${namespace}". ` +
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
