/**
 * §10's refusals, as assertions over the whole primitive stylesheet.
 *
 * Every other test in this package asks what one component declares. These ask
 * whether ANYTHING declares something the language refuses, which is a different
 * question and needs the other walk (`allRules`) — a rule that must not exist has
 * no selector to look it up by.
 *
 * This file exists because §9's checklist was unenforceable prose. Three defects
 * shipped in the composer that 2,000 green tests could not see, all three
 * properties of the stylesheet rather than of the markup; the ones below are the
 * same family, caught before they render rather than after somebody notices.
 *
 * **Every exception is named here with its reason, and that is the point.** A
 * refusal with a silent carve-out is not a refusal. When a surface genuinely
 * needs one — §10 permits exactly one, a menu over an already-raised surface —
 * the exception is added HERE, deliberately, next to the others. There is one,
 * and it is `Select`'s list: see the assertion below.
 *
 * Scope is `@shepherd/ui` — the primitive set the shell and every extension build
 * on. The app's own renderer sheet is a second consumer with the same class of
 * defect (`composer-picker.css.test.ts` is its first guard) and is not covered
 * from here; `allRules` only sees what this file imports.
 */
import { describe, expect, it } from 'vitest';
import { allRules } from './css-rules.ts';
import './styles.css';

/** `selectorText` + the declaration, for a failure that names where to look. */
const describeRule = (rule: CSSStyleRule, prop: string): string =>
  `${rule.selectorText} { ${prop}: ${rule.style.getPropertyValue(prop)} }`;

const declaring = (prop: string): CSSStyleRule[] =>
  allRules().filter((rule) => rule.style.getPropertyValue(prop) !== '');

/**
 * Rules whose value for `prop` matches, minus the selectors allowed to.
 *
 * Allowlist entries are substrings of `selectorText` rather than exact matches,
 * because a rule may legitimately gain a `:hover` or a second selector and the
 * exception is about the element, not the state it is in.
 */
const offenders = (prop: string, matches: RegExp, allowed: readonly string[]): string[] =>
  declaring(prop)
    .filter((rule) => matches.test(rule.style.getPropertyValue(prop)))
    .filter((rule) => !allowed.some((sel) => rule.selectorText.includes(sel)))
    .map((rule) => describeRule(rule, prop));

describe('§10 — the refusals, over the whole sheet', () => {
  it('runs no continuous animation but the working meter', () => {
    // §8: the meter repaints twice a second via `steps(1, end)` rather than every
    // frame, because twelve panes of continuously-animating indicators peg the
    // GPU. It is the one thing in the app allowed to loop, and `state-mark.css`
    // stops it dead under `prefers-reduced-motion` — a frozen partial meter reads
    // as broken, so that media query renders it complete and static.
    expect(offenders('animation', /infinite/, ['.sh-ui-mark__bars'])).toEqual([]);
    expect(offenders('animation-iteration-count', /infinite/, ['.sh-ui-mark__bars'])).toEqual([]);
  });

  it('draws no drop shadow — a seam and a focus ring are not elevation', () => {
    // Elevation is a luminance step, and the neutral ramp has fourteen of them.
    // An `inset` shadow is a hairline drawn without spending a border (`card.css`
    // uses one for its header seam), and `--sh-focus-ring` is required by §9.
    // Neither lifts anything off the page, which is what §10 refuses.
    //
    // The single permitted exception, and the terms it is permitted on: a MENU,
    // over a surface that is already raised. `Select`'s list opens out of a modal
    // and over a pane of live terminal output — one luminance step against
    // arbitrary text is not a boundary, and the alternative is a control the user
    // cannot find the edges of. Anything else that wants this has to come here
    // and argue for itself.
    const allowedDrop = '.sh-ui-select__list';
    const drops = declaring('box-shadow')
      .filter((rule) => {
        const value = rule.style.getPropertyValue('box-shadow');
        return !value.includes('inset') && !value.includes('--sh-focus-ring');
      })
      .filter((rule) => !rule.selectorText.includes(allowedDrop))
      .map((rule) => describeRule(rule, 'box-shadow'));
    expect(drops).toEqual([]);

    // …and the exception is a claim about ONE selector, so it fails if the list
    // stops drawing the shadow this carve-out exists for.
    expect(declaring('box-shadow').map((rule) => rule.selectorText)).toContain(allowedDrop);
  });

  it('fills nothing with a gradient', () => {
    // The one decorative surface in the app is the rail's sky strip, and it lives
    // in the app's renderer sheet, not here. A primitive that needs a gradient is
    // a primitive reaching for depth it should be spending a ramp step on.
    for (const prop of ['background', 'background-image'] as const) {
      expect(offenders(prop, /gradient/, [])).toEqual([]);
    }
  });

  it('uses no backdrop filter, because glass is refused outright', () => {
    // The scrim is flat so that what is behind it stays readable as itself.
    expect(declaring('backdrop-filter').map((r) => describeRule(r, 'backdrop-filter'))).toEqual([]);
  });

  it('transitions no transform but the switch knob and an arriving row action', () => {
    // §10 refuses motion that moves a control, because a control that moves under
    // the cursor is one whose target moved mid-click. A Switch's knob travelling
    // between its two ends is not that — the knob IS the state, and the control
    // it belongs to has not moved.
    //
    // A row's hover action is the second exception, and it earns it on the same
    // terms rather than on taste. It ARRIVES: a frame earlier there was nothing to
    // aim at, so no target moved out from under a pointer that was tracking one.
    // And the travel is bounded BELOW the size of the thing travelling — 4px
    // (`space-xs`) inside a 24px (`control-sm`) button — so the button's hit area
    // contains its own final position for every frame of the animation. A click
    // aimed where the button will be lands on the button the whole way in.
    //
    // Both halves of that are load-bearing. Widen the distance past the control's
    // own width and the guarantee is gone; put it on a control that is merely
    // moving rather than arriving and it is the refusal itself.
    expect(offenders('transition', /transform/, ['.sh-ui-switch', '.sh-ui-row__actions'])).toEqual([]);
  });

  it('puts no emoji in generated content', () => {
    // Iconography is Tabler, in markup. An emoji in `content:` renders at the
    // platform's whim in the platform's palette, which is every rule in §7 at
    // once — and §6 refuses emoji anywhere regardless.
    const emoji = /\p{Extended_Pictographic}/u;
    expect(offenders('content', emoji, [])).toEqual([]);
  });
});
