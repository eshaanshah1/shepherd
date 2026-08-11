import type { SettingsPageDTO } from '../shared/index.ts';

/**
 * The search, and the one thing it cannot do.
 *
 * A component page is matched on its TITLE alone: its body is an extension's React
 * module and the shell cannot read a label out of it. Written down rather than
 * left implicit, because a search that silently omitted half the settings would be
 * worse than one whose limit is stated — and it is the strongest argument for the
 * schema half of the seam being the primary path.
 *
 * Pure, and separate from the screen, because "which rows match" is the only
 * decision in this feature with enough cases to be worth testing without a DOM.
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
        // The key too: somebody who read `agents-core.quickModel` in a log or in
        // an ADR should be able to paste it in and land on its row.
        spec.key.toLowerCase().includes(needle),
    );
    // A title hit keeps the WHOLE page: somebody who typed a section's name is
    // looking for the section, not for one row inside it.
    if (titleHit) kept.push(page);
    else if (rows.length > 0) kept.push({ ...page, settings: rows });
  }
  return kept;
}
