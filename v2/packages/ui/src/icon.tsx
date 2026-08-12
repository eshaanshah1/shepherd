import type { ComponentType, ReactElement } from 'react';
import type { IconProps as TablerIconProps } from '@tabler/icons-react';
import { metrics } from '@shepherd/design-tokens';
import { cn } from './cn.ts';

/**
 * The icon primitive — the ONLY way a glyph reaches the screen.
 *
 * Flock named Tabler; this is the wrapper that makes "we use Tabler" a property
 * of the app rather than of whoever wrote each call site. Three things are fixed
 * here and are not props, and each one is a rule the reference study found the
 * shipped apps breaking:
 *
 *   - **One stroke weight.** Superset ships `react-icons` *and* `lucide-react`,
 *     and the tell is not the two libraries — it is two apparent line weights in
 *     one row. A `weight` prop is how that starts.
 *   - **`currentColor`, always.** An icon takes the colour of the text it sits
 *     in, so it is correct inside a hover, inside an inverse-video selection, and
 *     inside a `[data-surface]` subtree that re-declared `--sh-text`, with none of
 *     those knowing it exists. A `color` prop would make every one of those a
 *     call-site decision, which is how a themed extension gets a black glyph on a
 *     black row.
 *   - **Three sizes, from the type scale.** Not an arbitrary px: an icon beside
 *     12px text is 12px, and if the base size moves they move together.
 *
 * A raw `<svg>` at a call site is a review flag. So is importing a Tabler
 * component and rendering it directly — it would default to `size=24` and
 * `stroke=2`, which is a fourth size and a second weight in one line.
 */

export type IconSize = 'sm' | 'md' | 'lg';

/**
 * ONE weight — §7: "Tabler, one stroke weight (1.7–1.8), sized 11–17".
 *
 * 1.75 is the middle of the stated band. The prototypes draw a few glyphs at 2.2
 * and the send arrow at 2.4; the skill is normative on the *rule* and the screens
 * on the *values*, and "one stroke weight" is a rule — two apparent line weights
 * in one row is exactly what it exists to prevent.
 *
 * Lives here rather than in `tokens.css` because Tabler renders it as an SVG
 * `stroke-width` *attribute*; a CSS variable beside it would be a second source
 * that wins or loses depending on stylesheet order.
 */
export const ICON_STROKE = 1.75;

/**
 * The size ramp: the type scale, rounded to an ODD px and stepped by 2.
 *
 * **Odd, where this used to round up to even.** The even rule came with a reason
 * — a symmetric glyph wants a centre to straddle — but it had the parity
 * backwards: a 13px box has a centre PIXEL (index 6), while a 12px box has a
 * centre BOUNDARY, which is what puts a 1.75px stroke unevenly across the grid.
 * Shepherd UI's own icons are 11 / 13 / 15 / 17, which is the same conclusion
 * reached from the drawings rather than from the geometry.
 *
 * Stepped by 2 from one derived anchor rather than rounded from three separate
 * type steps, because three independent roundings collide: at base 16 the old
 * shape gave `sm` and `md` the same number, and a ramp whose two lowest rungs are
 * one size is a ramp with two names for one thing. At the approved base (13) this
 * is 13 / 15 / 17; move the base and it moves with it.
 */
const oddUp = (size: number): number => {
  const whole = Math.round(size);
  return whole % 2 === 1 ? whole : whole + 1;
};

const ICON_BASE = oddUp(metrics.type.medium);

export const iconSizes: Readonly<Record<IconSize, number>> = {
  sm: ICON_BASE, //     13 — beside a control label; a folder glyph in a pill
  md: ICON_BASE + 2, // 15 — beside body text, the default
  lg: ICON_BASE + 4, // 17 — standalone, in a fixed slot
};

export interface IconProps {
  /** A Tabler icon component, e.g. `IconPlus`. */
  readonly icon: ComponentType<TablerIconProps>;
  readonly size?: IconSize;
  readonly className?: string;
  /**
   * The accessible name.
   *
   * Omitted, the icon is DECORATIVE and `aria-hidden` — which is the right
   * default, because an icon beside its own label read aloud twice is worse than
   * an icon read not at all. An icon that is the whole control belongs in
   * `IconButton`, whose `aria-label` is required.
   */
  readonly label?: string;
}

export function Icon({ icon: Glyph, size = 'md', className, label }: IconProps): ReactElement {
  return (
    <Glyph
      className={cn('sh-icon', className)}
      size={iconSizes[size]}
      stroke={ICON_STROKE}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
    />
  );
}
