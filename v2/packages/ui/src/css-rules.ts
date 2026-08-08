/**
 * Walk the loaded stylesheet.
 *
 * A test helper, and it exists because two of this package's load-bearing
 * invariants are properties of the CSS rather than of the markup — `Row`'s
 * height, which no state may change, and `Composer`'s scoped role
 * re-declaration. Asserting those through `getComputedStyle` only reaches the
 * states a DOM can be put into, and `:hover` is not one of them in jsdom. The
 * rules themselves are, so a test can say "exactly one rule mentioning
 * `sh-ui-row` declares a height" and have that cover hover, focus-within,
 * selection and whatever the next state turns out to be.
 *
 * It recurses into grouping rules (`@media`, `@supports`) deliberately: the
 * coarse-pointer hit target lives inside one, and an invariant that a media
 * query can quietly break is not an invariant.
 */

/** Duck-typed rather than `instanceof CSSStyleRule` — one less global to exist. */
function isStyleRule(rule: CSSRule): rule is CSSStyleRule {
  return typeof (rule as CSSStyleRule).selectorText === 'string';
}

function isGroupingRule(rule: CSSRule): rule is CSSGroupingRule {
  return (rule as CSSGroupingRule).cssRules !== undefined && !isStyleRule(rule);
}

function collect(rules: CSSRuleList, into: CSSStyleRule[]): void {
  for (const rule of Array.from(rules)) {
    if (isStyleRule(rule)) into.push(rule);
    else if (isGroupingRule(rule)) collect(rule.cssRules, into);
  }
}

/** Every style rule in every loaded sheet whose selector mentions `needle`. */
export function rulesMentioning(needle: string): CSSStyleRule[] {
  const all: CSSStyleRule[] = [];
  for (const sheet of Array.from(document.styleSheets)) collect(sheet.cssRules, all);
  return all.filter((rule) => rule.selectorText.includes(needle));
}
