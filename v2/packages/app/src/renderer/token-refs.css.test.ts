// @vitest-environment jsdom
/**
 * Every `--sh-*` a stylesheet reads has to be a name something emits.
 *
 * This is the compiler CSS does not have. A misspelled TypeScript identifier
 * fails a build; a misspelled custom property resolves to nothing and paints
 * nothing, with no error anywhere and no failing test — which is exactly how
 * `--sh-surface-raised` came to be named in two comments while being defined in
 * no generator. A rule drawing an edge from it would have drawn no edge, and the
 * only symptom would have been a border somebody eventually noticed was missing.
 *
 * Two sources are legitimate, and the split is the tier boundary:
 *
 *   - **Tier 2, generated.** `cssVariables('dark')` is the whole emitted surface —
 *     roles, metrics, fonts, bands. If it is not in there, no `:root` block
 *     declares it at runtime.
 *   - **Tier 3, declared beside its owner.** A component may declare its own
 *     property (`styles.css` states the rule), and a scoped re-declaration like
 *     `composer.css`'s `--sh-surface: var(--sh-well)` is the same mechanism. Both
 *     appear as declarations in the sheet, so the sheet itself is the second
 *     source.
 *
 * It also covers tier 1 for free, without naming it: a palette step's own name is
 * deliberately NOT emitted (`--sh-ink` is the documented case), so a stylesheet
 * reaching past the roles into the palette fails here with the rest.
 *
 * Scope is the renderer plus `@shepherd/ui` — every sheet the app actually loads,
 * imported explicitly below because no `@import` chain gathers them.
 */
import { describe, expect, it } from 'vitest';
import { cssVariables } from '@shepherd/design-tokens';
import { allRules } from '@shepherd/ui/css-rules';
import '@shepherd/ui/styles.css';
import './styles.css';
import './sky-strip.css';
import './task-card.css';
import './settings.css';
import './inspector.css';

/** `var(--sh-x)` and `var(--sh-x, fallback)` — the name only. */
const VAR_REFERENCE = /var\(\s*(--sh-[a-zA-Z0-9-]+)/g;

/**
 * The third legitimate source: properties set from TS onto an element's own
 * `style`, because their value is not knowable until there is an element.
 *
 * Each entry names where it is set, and the case below asserts each is still
 * READ by some rule — so an entry whose CSS was deleted fails here rather than
 * sitting as a permanent hole in the check. Adding a name to this list is
 * therefore a claim with two halves, and the test holds both.
 */
const SET_AT_RUNTIME: Readonly<Record<string, string>> = {
  '--sh-pane-title-bg': 'terminal-pane.tsx — the grid’s own background, per pane',
  '--sh-ui-textarea-min': 'textarea.tsx — derived from the `minLines` prop',
  '--sh-ui-textarea-max': 'textarea.tsx — derived from the `maxLines` prop',
};

const declarationsOf = (rule: CSSStyleRule): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < rule.style.length; i += 1) {
    const prop = rule.style.item(i);
    out.push([prop, rule.style.getPropertyValue(prop)]);
  }
  return out;
};

describe('every --sh-* reference resolves', () => {
  it('reads no custom property that nothing declares', () => {
    const emitted = new Set(Object.keys(cssVariables('dark')));

    const declared = new Set<string>();
    for (const rule of allRules()) {
      for (const [prop] of declarationsOf(rule)) {
        if (prop.startsWith('--')) declared.add(prop);
      }
    }

    const unresolved: string[] = [];
    for (const rule of allRules()) {
      for (const [prop, value] of declarationsOf(rule)) {
        for (const match of value.matchAll(VAR_REFERENCE)) {
          const name = match[1];
          if (name === undefined) continue;
          if (emitted.has(name) || declared.has(name)) continue;
          if (name in SET_AT_RUNTIME) continue;
          unresolved.push(`${rule.selectorText} { ${prop}: … ${name} … }`);
        }
      }
    }

    // Sorted and de-duplicated: one name is usually read from several rules, and a
    // failure listing the same missing token nine times says less than one saying
    // which nine places read it.
    expect([...new Set(unresolved)].sort()).toEqual([]);
  });

  it('keeps no runtime-set name that no rule reads any more', () => {
    const read = new Set<string>();
    for (const rule of allRules()) {
      for (const [, value] of declarationsOf(rule)) {
        for (const match of value.matchAll(VAR_REFERENCE)) {
          if (match[1] !== undefined) read.add(match[1]);
        }
      }
    }
    const stale = Object.keys(SET_AT_RUNTIME).filter((name) => !read.has(name));
    expect(stale, 'listed as set at runtime, read by nothing').toEqual([]);
  });

  it('has something to check, so an empty sheet cannot pass it', () => {
    // The gate this file would otherwise be: `allRules()` returning nothing makes
    // every assertion above vacuously true, and a css:false config or a moved
    // import would do exactly that. M3 found three gates passing on nothing.
    const references = allRules().flatMap((rule) =>
      declarationsOf(rule).flatMap(([, value]) => [...value.matchAll(VAR_REFERENCE)]),
    );
    expect(references.length).toBeGreaterThan(100);
  });
});
