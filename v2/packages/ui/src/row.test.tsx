import { describe, expect, it } from 'vitest';
import { palette, relativeLuminance, roleToken, type RoleName } from '@shepherd/design-tokens';
import { mount } from './test-dom.ts';
import { rulesMentioning } from './css-rules.ts';
import { Row, rowClasses } from './row.tsx';
import { StateMark } from './state-mark.tsx';
import { IconButton } from './icon-button.tsx';
import { IconDots } from '@tabler/icons-react';
import './styles.css';

const row = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>('.sh-ui-row');
  if (!found) throw new Error('no row rendered');
  return found;
};

describe('Row', () => {
  it('renders the label, the leading slot and the trailing area', () => {
    const dom = mount(
      <Row leading={<StateMark state="working" />} meta="3" actions={<IconButton icon={IconDots} label="More" />}>
        shepherd/v2
      </Row>,
    );
    const el = row(dom.container);
    expect(el.querySelector(`.${rowClasses.label}`)?.textContent).toBe('shepherd/v2');
    expect(el.querySelector(`.${rowClasses.leading} .sh-ui-mark`)).not.toBeNull();
    expect(el.querySelector(`.${rowClasses.meta}`)?.textContent).toBe('3');
    expect(el.querySelector(`.${rowClasses.actions} .sh-ui-icon-button`)).not.toBeNull();
  });

  it('renders the leading slot even with nothing in it', () => {
    // The box is what holds the label's x position for every row in a list. A
    // slot that appeared with its contents would start each label at a different
    // place depending on whether that row happened to have a status.
    const dom = mount(<Row>plain</Row>);
    expect(row(dom.container).querySelector(`.${rowClasses.leading}`)).not.toBeNull();
  });

  it('renders the trailing area even with nothing in it', () => {
    const dom = mount(<Row>plain</Row>);
    const el = row(dom.container);
    expect(el.querySelector(`.${rowClasses.trailing}`)).not.toBeNull();
    expect(el.querySelector(`.${rowClasses.meta}`)).not.toBeNull();
    expect(el.querySelector(`.${rowClasses.actions}`)).not.toBeNull();
  });

  it('marks selection with a class and an attribute, and nothing else', () => {
    const dom = mount(<Row selected>picked</Row>);
    const el = row(dom.container);
    expect(el.className).toContain(rowClasses.selected);
    expect(el.dataset.selected).toBe('true');

    const plain = mount(<Row>not picked</Row>);
    expect(row(plain.container).className).not.toContain(rowClasses.selected);
    expect(row(plain.container).dataset.selected).toBeUndefined();
  });

  it('marks a quiet row with a class and an attribute, and nothing else', () => {
    const dom = mount(<Row quiet>20 more</Row>);
    const el = row(dom.container);
    expect(el.className).toContain(rowClasses.quiet);
    expect(el.dataset.quiet).toBe('true');

    const loud = mount(<Row>a task</Row>);
    expect(row(loud.container).className).not.toContain(rowClasses.quiet);
    expect(row(loud.container).dataset.quiet).toBeUndefined();
  });

  it('keeps every part of a quiet row, so it is a volume knob and not a variant', () => {
    // Quiet and gutter-less are separate claims, and this is what keeps them
    // separate: a quiet row still reserves the state column, because a control among
    // rows that HAVE marks belongs in their label column.
    const dom = mount(<Row quiet>20 more</Row>);
    const el = row(dom.container);
    expect(el.querySelector(`.${rowClasses.leading}`)).not.toBeNull();
    expect(el.querySelector(`.${rowClasses.trailing}`)).not.toBeNull();
  });

  /**
   * MUTATION TARGET #1a. `quiet` is colour and type only — it must not be allowed
   * to grow into a second row shape.
   *
   * This is the door §10's "no row declares a second height" would be broken
   * through: the critique that produced `quiet` also asked for a 26px archive row,
   * and the two arriving together is exactly how a volume control acquires a
   * height. Asserted on the DECLARATIONS, so adding `block-size`, `padding` or a
   * `margin` to the quiet rules fails here rather than being noticed on screen.
   */
  it('quiet changes only colour and size, never geometry', () => {
    const geometry = ['height', 'block-size', 'min-height', 'padding', 'margin', 'margin-inline', 'gap'];
    for (const rule of rulesMentioning('sh-ui-row--quiet')) {
      for (const property of geometry) {
        expect(rule.style.getPropertyValue(property), `${rule.selectorText} declares ${property}`).toBe('');
      }
    }
  });

  it('drops the leading slot only when the list has no state column', () => {
    /*
     * The bound on rule 2, and the reason it is a prop rather than an inference:
     * whether a list HAS a state column is a fact about a row's siblings, which this
     * component cannot see. Default on, so every existing list is untouched.
     */
    const withColumn = mount(<Row>a task</Row>);
    expect(row(withColumn.container).querySelector(`.${rowClasses.leading}`)).not.toBeNull();

    const without = mount(<Row gutter={false}>20 more</Row>);
    const el = row(without.container);
    expect(el.querySelector(`.${rowClasses.leading}`)).toBeNull();
    // The label is now the first child, so it sits at the row's own inset — which is
    // the whole point: the region's heading, its rows and this share one left edge.
    expect(el.firstElementChild?.className).toContain(rowClasses.label);
    // And the trailing cell is untouched, because metadata is not what moved.
    expect(el.querySelector(`.${rowClasses.trailing}`)).not.toBeNull();
  });

  it('draws a quiet row from the role whose job is "a control at rest"', () => {
    // `textFaint`, and the search field one row above it in the rail already quotes
    // the same rule — so this is the ink ramp being obeyed rather than a taste.
    const base = rulesMentioning('sh-ui-row--quiet').find(
      (rule) => rule.selectorText === '.sh-ui-row--quiet',
    );
    expect(base?.style.color).toBe('var(--sh-text-faint)');
    expect(base?.style.getPropertyValue('font-size')).toBe('var(--sh-font-size-medium)');

    // …and comes back UP the ramp on hover. A control that got fainter under the
    // cursor reads as disabled at the moment you reach for it.
    const hover = rulesMentioning('sh-ui-row--quiet').find(
      (rule) => rule.selectorText === '.sh-ui-row--quiet:hover',
    );
    expect(hover?.style.color).toBe('var(--sh-text-dim)');
  });

  /**
   * MUTATION TARGET #1. Adding a height to any state rule — `.sh-ui-row:hover`,
   * `.sh-ui-row--selected`, a `:has()` on the actions — must fail THIS test by
   * name. It is the CSS half of the invariant and it is the half that matters,
   * because `:hover` is not a state a jsdom element can be put into.
   */
  it('height is declared by exactly one rule, so no state can change it', () => {
    const heightProps = ['height', 'min-height', 'max-height'];

    // A rule TARGETS the row when the last compound of any of its selectors is
    // the row itself rather than a part of it — so `.sh-ui-row:hover` and
    // `.sh-ui-row--selected:hover` count, and `.sh-ui-row__leading` (a 12×12
    // box, which has its own height by design) does not.
    const targetsTheRow = (selectorText: string): boolean =>
      selectorText
        .split(',')
        .map((part) => part.trim().split(/\s+|>/).pop() ?? '')
        .some((last) => last.includes('sh-ui-row') && !last.includes('sh-ui-row__'));

    const declaring = rulesMentioning('sh-ui-row')
      .filter((rule) => targetsTheRow(rule.selectorText))
      .map((rule) => ({
        selector: rule.selectorText,
        declared: heightProps.filter((prop) => rule.style.getPropertyValue(prop) !== ''),
      }))
      .filter((entry) => entry.declared.length > 0);

    expect(declaring).toEqual([{ selector: '.sh-ui-row', declared: ['height'] }]);
    expect(
      rulesMentioning('sh-ui-row').find((rule) => rule.selectorText === '.sh-ui-row')?.style.height,
    ).toBe('var(--sh-row-height)');
  });

  it('the leading slot is a fixed box, whatever is in it', () => {
    // Rule 2 of the four: the CONTENTS vary — dot, spinner, glyph, eventually
    // the sheep — and the box never does, including when it is empty.
    // The rule whose selector IS the slot, not merely the first rule mentioning
    // it: another primitive may legitimately re-style the slot inside itself
    // (the palette hides it), and `[0]` picks whichever sheet the alphabetical
    // `@import` order happens to put first.
    const slot = rulesMentioning('sh-ui-row__leading').find(
      (rule) => rule.selectorText === '.sh-ui-row__leading',
    );
    expect(slot?.style.width).toBe('var(--sh-font-size-medium)');
    expect(slot?.style.height).toBe('var(--sh-font-size-medium)');
    expect(slot?.style.flex).toBe('0 0 auto');
  });

  /**
   * MUTATION TARGET #1, the DOM half. The states a jsdom element CAN be put
   * into, checked through the real cascade.
   */
  it('height is the same computed value resting, selected and with trailing actions', () => {
    const cases: Record<string, HTMLElement> = {
      resting: row(mount(<Row>a</Row>).container),
      selected: row(mount(<Row selected>a</Row>).container),
      withMeta: row(mount(<Row meta="12">a</Row>).container),
      withActions: row(
        mount(<Row actions={<IconButton icon={IconDots} label="More" />}>a</Row>).container,
      ),
      selectedWithActions: row(
        mount(
          <Row selected meta="12" actions={<IconButton icon={IconDots} label="More" />}>
            a
          </Row>,
        ).container,
      ),
    };

    const heights = Object.fromEntries(
      Object.entries(cases).map(([name, element]) => [name, getComputedStyle(element).height]),
    );
    expect(heights).toEqual({
      resting: 'var(--sh-row-height)',
      selected: 'var(--sh-row-height)',
      withMeta: 'var(--sh-row-height)',
      withActions: 'var(--sh-row-height)',
      selectedWithActions: 'var(--sh-row-height)',
    });
  });

  it('selection is a solid fill, not a wash', () => {
    // Rule 4: if the fill ever becomes a `color-mix` wash, hover and selection
    // stop being one glance apart — the argument recorded on the role itself.
    const selected = row(mount(<Row selected>a</Row>).container);
    const style = getComputedStyle(selected);
    expect(style.background).toBe('var(--sh-fill-selected)');
    expect(style.background).not.toContain('color-mix');
  });

  /**
   * MUTATION TARGET #3. The ink on a selected row must be READABLE on it.
   *
   * This replaces an assertion that pinned the two token NAMES —
   * `fillSelected` and `textOnWool` — and passed happily while the pair stopped
   * meaning anything. `fillSelected` was re-pointed from `wool` (white) to
   * `raised` (a dark luminance step) and the on-white ink was left beside it, so
   * every selected row in the app rendered `#0A0A0A` on `#161616`: the label,
   * the metadata and the leading mark all went black on black, and no test
   * noticed because both names were still exactly what was expected.
   *
   * So the assertion is about the COLOURS, resolved through the role chain, and
   * it is a contrast ratio rather than an identity — that is the property the
   * design language actually promises ("the label stays legible"), and it holds
   * whichever roles a later wave decides to point at each other.
   */
  it.each(['dark', 'light'] as const)('keeps a selected row’s label legible in %s', (mode) => {
    const ratio = (a: string, b: string): number => {
      const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
        number,
        number,
      ];
      return (light + 0.05) / (dark + 0.05);
    };
    const hex = (role: RoleName): string => palette[roleToken(role)][mode];

    // 4.5:1 is WCAG AA for body text, and a row's label is body text. The
    // shipped pair scored 1.09:1 dark and 1.15:1 light — indistinguishable in
    // both modes, which is what "black on black" looks like as a number.
    expect(ratio(hex('fillSelected'), hex('text'))).toBeGreaterThan(4.5);
  });

  /**
   * MUTATION TARGET #2. The fill is a chip, and its inset is paid for out of the
   * padding — so rounding the selection cannot move the labels.
   *
   * Asserted on the declarations rather than through `getComputedStyle`, because
   * the invariant is the ARITHMETIC (margin + padding = the inset the label has
   * always been at) and jsdom resolves neither the `calc()` nor the custom
   * properties inside it. Swapping the subtractions for the two smaller tokens
   * they equal at today's scale would pass a computed-value test and silently
   * decouple the two halves the next time the space scale moves.
   */
  it('the chip is inset out of its own padding, so the label does not move', () => {
    const base = rulesMentioning('sh-ui-row').find((rule) => rule.selectorText === '.sh-ui-row');
    expect(base?.style.getPropertyValue('border-radius')).toBe('var(--sh-radius-md)');
    expect(base?.style.getPropertyValue('margin-inline')).toBe('var(--sh-space-sm)');

    const padding = base?.style.getPropertyValue('padding') ?? '';
    expect(padding).toContain('calc(var(--sh-space-xl) - var(--sh-space-sm))');
    expect(padding).toContain('calc(var(--sh-space-lg) - var(--sh-space-sm))');

    // A percentage width beside that margin overflows by exactly the inset, and
    // on the right that is the pixel the sidebar's seam is drawn in.
    expect(base?.style.getPropertyValue('width')).toBe('auto');
  });

  it('hover is the fillHover wash, so a re-declared --sh-text carries it', () => {
    const hoverRule = rulesMentioning('sh-ui-row').find(
      (rule) => rule.selectorText === '.sh-ui-row:hover',
    );
    expect(hoverRule?.style.background).toBe('var(--sh-fill-hover)');
  });

  it('stacks meta and actions in one grid cell so revealing them cannot reflow', () => {
    const dom = mount(
      <Row meta="12" actions={<IconButton icon={IconDots} label="More" />}>
        a
      </Row>,
    );
    const trailing = dom.container.querySelector<HTMLElement>(`.${rowClasses.trailing}`);
    if (!trailing) throw new Error('no trailing area');
    expect(getComputedStyle(trailing).display).toBe('grid');

    // Both children name the SAME area. That is the mechanism: the track is as
    // wide as the wider of them, and swapping which one is visible moves nothing.
    const stacked = rulesMentioning('sh-ui-row__meta').find((rule) =>
      rule.selectorText.includes('sh-ui-row__actions'),
    );
    expect(stacked?.style.getPropertyValue('grid-area')).toBe('stack');
  });

  it('reveals the actions on focus within, not on hover alone', () => {
    // A control that only exists on hover is a control a keyboard can reach and
    // cannot see.
    const reveal = rulesMentioning('sh-ui-row__actions').map((rule) => rule.selectorText);
    expect(reveal.some((selector) => selector.includes(':focus-within'))).toBe(true);
  });

  it('exports its class constants so an extension-s own markup can look native', () => {
    const dom = mount(
      <Row selected meta="1" actions={<span>x</span>} leading={<StateMark state="resting" />}>
        a
      </Row>,
    );
    const el = row(dom.container);
    expect(el.className).toContain(rowClasses.root);
    expect(el.className).toContain(rowClasses.selected);
    for (const part of ['leading', 'label', 'trailing', 'meta', 'actions'] as const) {
      expect(el.querySelector(`.${rowClasses[part]}`), part).not.toBeNull();
    }
  });

  it('spreads unanticipated props onto the root and forwards a ref', () => {
    let node: HTMLDivElement | null = null;
    const dom = mount(
      <Row
        data-testid="task-row"
        role="option"
        aria-selected={false}
        tabIndex={0}
        ref={(element) => {
          node = element;
        }}
      >
        a
      </Row>,
    );
    const el = row(dom.container);
    expect(el.getAttribute('data-testid')).toBe('task-row');
    expect(el.getAttribute('role')).toBe('option');
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(node).toBe(el);
  });

  /**
   * The entrance, and what it is allowed to move.
   *
   * A contributed list is re-read whole, so a task appearing is one paint with N
   * rows and the next with N+1 — which reads as the list flickering rather than
   * as something joining it. The mark is the caller's decision (only it knows
   * what the list was); this is the half that says what arriving LOOKS like.
   */
  it('marks a row as arriving only when it is', () => {
    const arriving = mount(<Row entering>new</Row>);
    expect(row(arriving.container).classList.contains(rowClasses.entering)).toBe(true);

    const settled = mount(<Row>old</Row>);
    expect(settled.container.querySelector(`.${rowClasses.entering}`)).toBeNull();
  });

  /**
   * MUTATION TARGET: the entrance animates opacity and transform, and NOTHING
   * that costs layout.
   *
   * The height invariant above already refuses a height on this rule. This is the
   * other half — the keyframes themselves, which that test cannot see, and where
   * a `height` or a `margin` would reflow every row below for the length of the
   * animation.
   */
  it('animates only compositable properties, never layout', () => {
    const frames = [...(document.styleSheets as unknown as CSSStyleSheet[])]
      .flatMap((sheet) => [...sheet.cssRules])
      .filter((rule): rule is CSSKeyframesRule => rule.constructor.name === 'CSSKeyframesRule')
      .filter((rule) => rule.name === 'sh-ui-row-enter');
    expect(frames).toHaveLength(1);

    const touched = new Set<string>();
    for (const frame of [...(frames[0]?.cssRules ?? [])] as CSSKeyframeRule[]) {
      for (const property of [...frame.style]) touched.add(property);
    }
    expect([...touched].sort()).toEqual(['opacity', 'transform']);
  });

  it('turns the entrance off under prefers-reduced-motion', () => {
    // Off, not shortened: an entrance carries no information, so the honest
    // accommodation is that the row is simply there.
    const media = [...(document.styleSheets as unknown as CSSStyleSheet[])]
      .flatMap((sheet) => [...sheet.cssRules])
      .filter((rule): rule is CSSMediaRule => rule.constructor.name === 'CSSMediaRule')
      .filter((rule) => rule.conditionText.includes('prefers-reduced-motion'));
    const off = media
      .flatMap((rule) => [...rule.cssRules] as CSSStyleRule[])
      .filter((rule) => rule.selectorText === `.${rowClasses.entering}`);
    expect(off.map((rule) => rule.style.animation)).toEqual(['none']);
  });
});
