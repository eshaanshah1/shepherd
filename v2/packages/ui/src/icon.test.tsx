import { describe, expect, it } from 'vitest';
import { NAMED_GLYPHS } from './glyphs.ts';
import { IconPlus, IconTerminal2 } from '@tabler/icons-react';
import { metrics } from '@shepherd/design-tokens';
import { mount } from './test-dom.ts';
import { ICON_STROKE, Icon, glyphElement, iconSizes } from './icon.tsx';
import { cn } from './cn.ts';

const svg = (container: HTMLElement): SVGSVGElement => {
  const found = container.querySelector('svg');
  if (!found) throw new Error('no icon rendered');
  return found;
};

describe('Icon', () => {
  it('renders the glyph it was handed', () => {
    const dom = mount(<Icon icon={IconPlus} />);
    expect(svg(dom.container).getAttribute('class')).toContain('tabler-icon-plus');
  });

  it('carries the sh-icon class so the stylesheet can reach it', () => {
    const dom = mount(<Icon icon={IconPlus} />);
    expect(svg(dom.container).getAttribute('class')).toContain('sh-icon');
  });

  it('sizes from the type scale — 13 / 15 / 17 at the approved base', () => {
    expect(iconSizes).toEqual({ sm: 13, md: 15, lg: 17 });
    for (const [size, px] of Object.entries(iconSizes)) {
      const dom = mount(<Icon icon={IconPlus} size={size as keyof typeof iconSizes} />);
      expect(svg(dom.container).getAttribute('width'), size).toBe(`${px}`);
      expect(svg(dom.container).getAttribute('height'), size).toBe(`${px}`);
    }
  });

  it('defaults to md', () => {
    const dom = mount(<Icon icon={IconPlus} />);
    expect(svg(dom.container).getAttribute('width')).toBe(`${iconSizes.md}`);
  });

  it('derives the ramp from the type scale rather than hardcoding it', () => {
    // The relation, not the numbers: an icon beside a control's label is that
    // label's size, and if the base font size moves the ramp moves with it.
    expect(iconSizes.sm).toBeGreaterThanOrEqual(metrics.type.medium);
    expect(iconSizes.md).toBeGreaterThanOrEqual(metrics.type.body);
    expect(iconSizes.lg).toBeGreaterThanOrEqual(metrics.type.large);
    // ODD, so a symmetric glyph has a centre PIXEL to sit on rather than a centre
    // boundary for its 1.75px stroke to straddle. §7 sizes icons 11–17 and the
    // prototypes draw 11 / 13 / 15 / 17, which is the same answer from the
    // drawings rather than from the geometry.
    for (const px of Object.values(iconSizes)) expect(px % 2, `${px}`).toBe(1);
  });

  it('never collides two rungs, at any base', () => {
    // Three independent roundings of three type steps did collide — at base 16
    // `sm` and `md` both landed on 17. Stepping by 2 from one anchor is what
    // makes that unrepresentable.
    expect(iconSizes.sm).toBeLessThan(iconSizes.md);
    expect(iconSizes.md).toBeLessThan(iconSizes.lg);
  });

  it('fixes the stroke at one weight, whatever the size', () => {
    // Tabler's own default is 2. §7: one stroke weight, 1.7–1.8 — a `weight` prop
    // is how two apparent line weights in one row start.
    expect(ICON_STROKE).toBe(1.75);
    expect(ICON_STROKE).toBeGreaterThanOrEqual(1.7);
    expect(ICON_STROKE).toBeLessThanOrEqual(1.8);
    for (const size of ['sm', 'md', 'lg'] as const) {
      const dom = mount(<Icon icon={IconTerminal2} size={size} />);
      expect(svg(dom.container).getAttribute('stroke-width'), size).toBe('1.75');
    }
  });

  it('paints in currentColor, so a themed subtree carries it', () => {
    const dom = mount(<Icon icon={IconPlus} />);
    expect(svg(dom.container).getAttribute('stroke')).toBe('currentColor');
  });

  it('is decorative by default and named only when asked', () => {
    // An icon beside its own label, read aloud twice, is worse than one read not
    // at all. An icon that IS the control belongs in IconButton, whose label is
    // required.
    const bare = mount(<Icon icon={IconPlus} />);
    expect(svg(bare.container).getAttribute('aria-hidden')).toBe('true');
    expect(svg(bare.container).getAttribute('role')).toBeNull();

    const named = mount(<Icon icon={IconPlus} label="New task" />);
    expect(svg(named.container).getAttribute('aria-hidden')).toBeNull();
    expect(svg(named.container).getAttribute('role')).toBe('img');
    expect(svg(named.container).getAttribute('aria-label')).toBe('New task');
  });

  it('keeps a caller class alongside its own', () => {
    const dom = mount(<Icon icon={IconPlus} className="sh-row-glyph" />);
    const classes = svg(dom.container).getAttribute('class') ?? '';
    expect(classes).toContain('sh-icon');
    expect(classes).toContain('sh-row-glyph');
  });
});

describe('cn', () => {
  it('joins what is there and drops what is not', () => {
    expect(cn('a', 'b')).toBe('a b');
    expect(cn('a', false, undefined, null, 'b')).toBe('a b');
    expect(cn()).toBe('');
  });
});

/**
 * The DOM-node form, for the pills the composer builds by hand.
 *
 * Its whole reason for existing is that those pills used to hand-write an
 * `<svg>`, which `icon.tsx` calls a review flag — so the assertions are about the
 * two things a hand-written one gets wrong: the size and the stroke.
 */
describe('glyphElement', () => {
  it('draws a named glyph at the kit’s one stroke and one ramp', () => {
    const drawn = glyphElement('hash');
    expect(drawn?.tagName.toLowerCase()).toBe('svg');
    expect(drawn?.getAttribute('stroke-width')).toBe(String(ICON_STROKE));
    expect(drawn?.getAttribute('width')).toBe(String(iconSizes.sm));
    expect(drawn?.getAttribute('height')).toBe(String(iconSizes.sm));
    expect(drawn?.getAttribute('stroke')).toBe('currentColor');
  });

  it('carries the kit’s class, so a surface can colour it', () => {
    expect(glyphElement('brand-jira')?.getAttribute('class')).toContain('sh-icon');
  });

  it('is decorative, because the pill it sits in has a label', () => {
    expect(glyphElement('brand-jira')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('takes a size from the ramp', () => {
    expect(glyphElement('brand-jira', 'lg')?.getAttribute('width')).toBe(String(iconSizes.lg));
  });

  /**
   * Null rather than `namedGlyph`'s dots fallback. That fallback keeps a hover
   * action from being an invisible button; a pill has its label either way, and a
   * wrong name should read as a missing mark rather than as a glyph that means
   * something else.
   */
  it('is null for a name the allow-list does not have', () => {
    expect(glyphElement('not-a-glyph')).toBeNull();
  });

  it('survives being asked twice, leaving no host behind', () => {
    // It mounts a React root to render, and a root that outlived the call would
    // leak one per pasted link.
    const before = document.body.childElementCount;
    expect(glyphElement('hash')).not.toBeNull();
    expect(glyphElement('hash')).not.toBeNull();
    expect(document.body.childElementCount).toBe(before);
  });
});

describe('the incognito glyph', () => {
  it('is in the allow-list, since a contributed row can only send a name', () => {
    expect(NAMED_GLYPHS['spy']).toBeDefined();
  });
});
