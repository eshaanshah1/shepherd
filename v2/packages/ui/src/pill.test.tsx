import { IconPhoto } from '@tabler/icons-react';
import { describe, expect, it } from 'vitest';
import { mount } from './test-dom.ts';
import { rulesMentioning } from './css-rules.ts';
import { Pill } from './pill.tsx';
import './styles.css';

const pill = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>('.sh-ui-pill');
  if (!found) throw new Error('no pill rendered');
  return found;
};

const base = (): CSSStyleRule => {
  const rule = rulesMentioning('sh-ui-pill').find((candidate) => candidate.selectorText === '.sh-ui-pill');
  if (!rule) throw new Error('no .sh-ui-pill rule');
  return rule;
};

describe('Pill', () => {
  it('renders its label, with the icon decorative beside it', () => {
    const dom = mount(<Pill icon={IconPhoto}>Image</Pill>);
    expect(pill(dom.container).textContent).toBe('Image');
    const glyph = pill(dom.container).querySelector('svg');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  });

  it('is a label on its own when handed no icon', () => {
    const dom = mount(<Pill>Image</Pill>);
    expect(pill(dom.container).querySelector('svg')).toBeNull();
    expect(pill(dom.container).textContent).toBe('Image');
  });

  /**
   * The invariant the component exists for. An inline-flex box contributes its
   * whole MARGIN box to the line, so a pill taller than the line box — or one
   * with a vertical margin — opens every line that contains one.
   */
  it('cannot open the line box it sits in', () => {
    expect(base().style.display).toBe('inline-flex');
    expect(base().style.height).toBe('var(--sh-ui-pill-height)');
    expect(base().style.getPropertyValue('--sh-ui-pill-height')).toContain('var(--sh-line-height)');
    for (const rule of rulesMentioning('sh-ui-pill')) {
      expect(rule.style.margin, rule.selectorText).toBe('');
      expect(rule.style.marginTop, rule.selectorText).toBe('');
      expect(rule.style.marginBottom, rule.selectorText).toBe('');
    }
  });

  it('draws a box — a fill, an edge and a lit top, all one accent', () => {
    // Three washes of ONE colour rather than three colours, which is what makes
    // it read as a lit box instead of as decoration.
    expect(base().style.background).toBe('var(--sh-fill-accent)');
    expect(base().style.borderRadius).toBe('var(--sh-radius-md)');
    // Per SIDE, because that is the only form jsdom's CSSOM keeps: it drops any
    // shorthand holding a `var()`, so `border` and `border-color` both read back
    // as empty here and would assert nothing at all.
    expect(base().style.borderTopColor).toBe('var(--sh-glint-accent)');
    for (const side of ['right', 'bottom', 'left']) {
      expect(base().style.getPropertyValue(`border-${side}-color`), side).toBe('var(--sh-line-accent)');
    }
  });

  it('spends no shadow on the glint, so all four edges are one pixel', () => {
    // The regression this pins, which shipped: the lit top edge was
    // `box-shadow: inset 0 1px 0`, which paints against the INNER face of the
    // border box rather than replacing the border. The top read 2px against 1px
    // everywhere else, and the extra band of light above the label dragged the
    // word optically low in a box it was in fact centred in. The light is a
    // border COLOUR now — same glint, one pixel, four even edges.
    for (const rule of rulesMentioning('sh-ui-pill')) {
      expect(rule.style.boxShadow, rule.selectorText).toBe('');
    }
  });

  it('breathes sideways only, so the fill cannot grow the line', () => {
    // `height` is the whole vertical story. A padding block is either ignored
    // under `border-box` or opens the line under `content-box`, and one of those
    // two is a bug on a machine nobody is looking at.
    for (const rule of rulesMentioning('sh-ui-pill')) {
      for (const property of ['padding', 'padding-top', 'padding-bottom']) {
        expect(rule.style.getPropertyValue(property), `${rule.selectorText} ${property}`).toBe('');
      }
    }
    expect(base().style.getPropertyValue('padding-block')).toBe('0px');
    expect(base().style.getPropertyValue('padding-inline')).toBe('var(--sh-space-sm)');
  });

  /**
   * The misalignment that shipped, pinned as the three declarations that fix it.
   *
   * `vertical-align: middle` centres the BOX on the baseline plus half an
   * x-height, which is not where the label's own line box is centred — so the
   * word inside a pill sat ~0.8px low against the prose beside it at 16px and
   * ~1.1px low at 13px. Measured in a real browser; jsdom lays out nothing, so
   * this asserts the mechanism rather than the pixels.
   */
  it('sits the label on the sentence’s baseline, at any font size', () => {
    // The label is what the flex container offers the line as its baseline —
    // with `center` there is no baseline-aligned item and the browser
    // synthesises one from the border box, which is the drift.
    expect(base().style.alignItems).toBe('baseline');
    expect(base().style.verticalAlign).toBe('baseline');
    // And it cannot hang below the line, because the label's box exactly fills
    // the content box and so leaves no slack to hang by. A `1` here would make
    // that slack — and the drift — a function of the inherited font size.
    expect(base().style.lineHeight).toBe('calc(var(--sh-ui-pill-height) - 2 * var(--sh-hairline))');
  });

  it('takes the glyph out of the baseline group, so it stays centred', () => {
    // An SVG has no baseline; a browser synthesises one at its bottom margin
    // edge, so left in the group it lines that edge up with the label's baseline
    // and rides a pixel high. This is also what leaves the LABEL alone defining
    // the pill's baseline.
    const glyph = rulesMentioning('sh-ui-pill').find(
      (candidate) => candidate.selectorText === '.sh-ui-pill .sh-icon',
    );
    expect(glyph?.style.alignSelf).toBe('center');
  });

  it('reads as prose — the sentence’s ink and the sentence’s size', () => {
    expect(base().style.color).toBe('var(--sh-text)');
    // Not the `small` step. A token a size down from its sentence reads as a
    // chip parked in the text rather than as a word of it.
    expect(base().style.fontSize).toBe('inherit');
  });

  it('puts the one signal on the glyph, in the ROLE', () => {
    // Named rather than hued: a theme that re-declares `--sh-sky` gets its own
    // pill for free, and cobalt stays a fact about the token layer.
    const glyph = rulesMentioning('sh-ui-pill').find(
      (candidate) => candidate.selectorText === '.sh-ui-pill .sh-icon',
    );
    expect(glyph?.style.color).toBe('var(--sh-sky)');
  });

  it('has one appearance — no per-kind colour at the call site', () => {
    // A `tone` prop and a `honey` hue lived here briefly and were taken back
    // out: a pill says the app is HOLDING something, and the kind is already in
    // the glyph beside the label. Asserted as an absence so it is a decision
    // rather than a thing nobody got round to.
    for (const rule of rulesMentioning('sh-ui-pill')) {
      expect(rule.selectorText, 'no tone variants').not.toContain('data-tone');
    }
  });

  it('draws no selected state of its own — the FIELD paints the band', () => {
    // `PromptField` lays one rounded bar per line behind the text, so a pill
    // inside a selection already has the band behind it. Every attempt to draw
    // it here instead is in the history of this file, and each one had to
    // reproduce a geometry only the field can measure.
    for (const rule of rulesMentioning('sh-ui-pill')) {
      expect(rule.selectorText, 'no selected state').not.toContain('data-selected');
      expect(rule.selectorText, 'no ::selection opinion').not.toContain('::selection');
    }
  });

  it('keeps ordinary ink on a pill with no glyph, because the BOX is the signal', () => {
    // There used to be a `:not(:has(.sh-icon))` rule handing the label the accent,
    // for a pill that had no box and so nowhere else to put the signal. Stacked on
    // the box it puts a sky label on a sky fill inside a sky edge — the one
    // arrangement of this palette where the word reads worse than the prose beside
    // it. Asserted as an absence so nobody restores it by reflex.
    const fallback = rulesMentioning('sh-ui-pill').filter((candidate) =>
      candidate.selectorText.includes(':has(.sh-icon)'),
    );
    expect(fallback.map((rule) => rule.selectorText)).toEqual([]);
  });

  it('paints in roles only', () => {
    for (const rule of rulesMentioning('sh-ui-pill')) {
      for (const property of ['background', 'color', 'border']) {
        const value = rule.style.getPropertyValue(property);
        if (value === '') continue;
        // `transparent` is not a colour and so cannot be a role: it is the
        // absence of paint, which is how `button.css` and `keycap.css` already
        // hold a border's space without drawing one. Everything that DOES put
        // ink on the screen goes through a role.
        if (value === 'transparent') continue;
        expect(value, `${rule.selectorText} ${property}`).toContain('var(--sh-');
      }
    }
  });

  it('is display only — no pointer, and no click to type', () => {
    // KeyCap's rule: a pressable thing in a run of text is a link, and a link
    // that looks like a control teaches the wrong gesture.
    expect(base().style.cursor).toBe('default');
  });

  /**
   * The regression this pins is a DATA loss, not a cosmetic one, and it shipped.
   *
   * `user-select: none` takes the element out of the selection's TEXT as well as
   * out of the mouse's reach, so copying a selection spanning a pill dropped its
   * label: `in shepherd now` came off the clipboard as `in  now`. Measured in a
   * real browser — jsdom has no selection text to assert on, so this asserts the
   * declaration that governs it.
   */
  it('stays in the text a selection copies, whole rather than by halves', () => {
    // `all`, not `auto`: `auto` allows HALF a pill into a selection, and half a
    // token is not a thing this component's model ("a pill is one character")
    // has. It is also what makes `containsNode(pill, false)` a reliable question
    // for the field that marks selected pills.
    expect(base().style.userSelect).toBe('all');
  });

  it('spreads unanticipated props and forwards a ref', () => {
    let node: HTMLSpanElement | null = null;
    const dom = mount(
      <Pill
        data-testid="attachment"
        ref={(element) => {
          node = element;
        }}
      >
        Image
      </Pill>,
    );
    expect(pill(dom.container).getAttribute('data-testid')).toBe('attachment');
    expect(node).toBe(pill(dom.container));
  });
});
