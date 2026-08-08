import { describe, expect, it } from 'vitest';
import { IconPlus, IconTerminal2 } from '@tabler/icons-react';
import { metrics } from '@shepherd/design-tokens';
import { mount } from './test-dom.ts';
import { ICON_STROKE, Icon, iconSizes } from './icon.tsx';
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

  it('sizes from the type scale — 12 / 14 / 16 at the approved base', () => {
    expect(iconSizes).toEqual({ sm: 12, md: 14, lg: 16 });
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
    // The relation, not the numbers: an icon beside 12px text is 12px, and if the
    // base font size moves the ramp has to move with it. Rounded UP to even,
    // because an odd box has no centre pixel for a symmetric glyph to straddle.
    expect(iconSizes.sm).toBeGreaterThanOrEqual(metrics.type.medium);
    expect(iconSizes.md).toBeGreaterThanOrEqual(metrics.type.body);
    expect(iconSizes.lg).toBeGreaterThanOrEqual(metrics.type.large);
    for (const px of Object.values(iconSizes)) expect(px % 2).toBe(0);
  });

  it('fixes the stroke at one weight, whatever the size', () => {
    // Tabler's own default is 2. One weight is the Flock rule; a `weight` prop is
    // how two apparent line weights in one row start.
    expect(ICON_STROKE).toBe(1.5);
    for (const size of ['sm', 'md', 'lg'] as const) {
      const dom = mount(<Icon icon={IconTerminal2} size={size} />);
      expect(svg(dom.container).getAttribute('stroke-width'), size).toBe('1.5');
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
