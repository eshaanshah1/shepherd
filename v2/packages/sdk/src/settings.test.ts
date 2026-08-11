import { describe, expect, it } from 'vitest';
import { namespaceOf, validateSetting, pageIssues, defaultsOf } from './settings.ts';
import type { SettingSpec, SettingsPage } from './api-settings.ts';

const spec = (over: Partial<SettingSpec> = {}): SettingSpec => ({
  key: 'agents-core.quickModel',
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
    // `choicesFrom` resolves in another process at page-open time. Refusing here
    // would make every dynamic setting unwritable.
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

  it('refuses a number that is not finite, wherever it came from', () => {
    // Not reachable through JSON, reachable from an in-process caller — the
    // reason `s.number` is finite-only too.
    expect(validateSetting(spec({ type: 'number', default: 1 }), Number.NaN).ok).toBe(false);
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

  it('rejects a bare key with no namespace at all', () => {
    expect(pageIssues(page([spec({ key: 'quickModel' })]), 'agents-core')).toHaveLength(1);
  });

  it('rejects a duplicate key within one page', () => {
    const issues = pageIssues(page([spec({ key: 'agents-core.a' }), spec({ key: 'agents-core.a' })]), 'agents-core');
    expect(issues.some((issue) => issue.includes('declared twice'))).toBe(true);
  });

  it('rejects a default its own spec would refuse', () => {
    const issues = pageIssues(page([spec({ key: 'agents-core.n', type: 'number', default: 'ten' })]), 'agents-core');
    expect(issues.some((issue) => issue.includes('default'))).toBe(true);
  });

  it('rejects an enum with neither choices nor a command to ask', () => {
    const issues = pageIssues(page([spec({ key: 'agents-core.e', type: 'enum', default: 'a' })]), 'agents-core');
    expect(issues.some((issue) => issue.includes('choices'))).toBe(true);
  });

  it('passes a component page, which declares no keys at all', () => {
    expect(pageIssues({ id: 'w.editor', title: 'Hooks', component: 'worktree-hook.editor' }, 'worktree-hook')).toEqual(
      [],
    );
  });

  it('rejects a page that is both, and a page that is neither', () => {
    expect(
      pageIssues({ id: 'x', title: 'X', component: 'a.b', settings: [spec({ key: 'x.a' })] }, 'x'),
    ).not.toEqual([]);
    expect(pageIssues({ id: 'x', title: 'X' }, 'x')).not.toEqual([]);
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
