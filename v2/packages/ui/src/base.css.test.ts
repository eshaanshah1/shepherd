/**
 * `base.css` — the mechanisms every primitive shares and none owns.
 *
 * A stylesheet-level test, for the reason `refusals.css.test.ts` gives: these are
 * properties of the CSS rather than of any markup, so there is no component to
 * render and ask. `::selection` in particular cannot be reached through
 * `getComputedStyle` at all — jsdom paints nothing and has no highlight
 * pseudo-element to query — so the rule itself is the only thing there is to
 * assert on.
 */
import { describe, expect, it } from 'vitest';
import { allRules } from './css-rules.ts';
import './styles.css';

const selectionRule = (): CSSStyleRule => {
  const rule = allRules().find((candidate) => candidate.selectorText === '::selection');
  if (!rule) throw new Error('no bare `::selection` rule — base.css should own exactly one');
  return rule;
};

describe('the selection', () => {
  it('is painted in the app’s own colour, not the platform’s', () => {
    // Before this rule the OS painted its accent, which is a colour from no
    // palette in this app and one the user can change in System Settings — so
    // nothing here could be designed to sit beside it.
    expect(selectionRule().style.backgroundColor).toBe('var(--sh-fill-selection)');
  });

  it('is the SAME token the prompt paints its own band with', () => {
    /*
     * `PromptField` draws the selection itself — one rounded bar per line, which
     * `::selection` cannot do — and it must use this token, not one that merely
     * looks like it. A field painting its own band in a second colour is the
     * defect this whole pair was added for, one layer along.
     */
    const bar = allRules().find((rule) => rule.selectorText.includes('.sh-ui-prompt-band__bar'));
    expect(bar?.style.background).toBe(selectionRule().style.backgroundColor);
  });

  it('does not flip the ink, because §6 refuses inverse video', () => {
    // The wash is chosen to leave `text` legible on its own. Setting `color`
    // here would also repaint selected CODE, whose whole point is that its
    // syntax colours survive being selected.
    expect(selectionRule().style.color).toBe('');
  });

  it('uses `background-color`, the property the highlight pseudo actually takes', () => {
    // The highlight pseudo-elements accept a small fixed set of properties and
    // the `background` shorthand is not reliably among them — a selection that
    // silently does not paint is the failure mode.
    expect(selectionRule().style.background).toBe('');
  });
});
