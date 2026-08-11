import { describe, expect, it } from 'vitest';
import type { SettingsPageDTO } from '../shared/index.ts';
import { filterPages } from './settings-filter.ts';

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
    settings: [
      { key: 'agents-core.quickModel', type: 'string', label: 'Quick-tier model', default: 'sonnet' },
      { key: 'agents-core.quickKind', type: 'string', label: 'Quick-tier agent', default: '' },
    ],
  },
  { id: 'w.editor', title: 'Worktree hooks', owner: 'shepherd.worktree-hook', component: 'worktree-hook.editor' },
];

describe('filterPages', () => {
  it('returns every page for an empty query', () => {
    expect(filterPages(pages, '').map((page) => page.id)).toEqual(['shepherd.general', 'agents.models', 'w.editor']);
  });

  it('keeps a page whose row label matches, and only the matching rows', () => {
    // A query the SECTION title does not also match — "model" would hit "Models"
    // and keep the page whole, which is the case below.
    const found = filterPages(pages, 'quick-tier model');
    expect(found.map((page) => page.id)).toEqual(['agents.models']);
    expect(found[0]?.settings?.map((spec) => spec.key)).toEqual(['agents-core.quickModel']);
  });

  it('matches a description as well as a label', () => {
    expect(filterPages(pages, 'follow').map((page) => page.id)).toEqual(['shepherd.general']);
  });

  it('matches a key, so a name read in a log can be pasted in', () => {
    expect(filterPages(pages, 'shepherd.theme').map((page) => page.id)).toEqual(['shepherd.general']);
  });

  it('keeps every row when the SECTION name matched', () => {
    const found = filterPages(pages, 'models');
    expect(found[0]?.settings).toHaveLength(2);
  });

  it('keeps a component page on a title match only, because the shell cannot see inside it', () => {
    expect(filterPages(pages, 'worktree').map((page) => page.id)).toEqual(['w.editor']);
    expect(filterPages(pages, 'script').map((page) => page.id)).toEqual([]);
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(filterPages(pages, '  THEME ').map((page) => page.id)).toEqual(['shepherd.general']);
  });

  it('does not mutate the pages it was given', () => {
    filterPages(pages, 'model');
    expect(pages[1]?.settings).toHaveLength(2);
  });
});
