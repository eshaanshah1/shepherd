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
 * ONE weight (Tabler's own default is 2, which is heavier than this language
 * wants beside 11px text). Lives here rather than in `tokens.css` because Tabler
 * renders it as an SVG `stroke-width` *attribute*; a CSS variable beside it would
 * be a second source that wins or loses depending on stylesheet order.
 */
export const ICON_STROKE = 1.5;

/**
 * The size ramp: the type scale, rounded UP to an even px.
 *
 * Even because a Tabler glyph is symmetric about the centre of its box, and an
 * odd box has no centre pixel — a 1.5px stroke then straddles the grid unevenly
 * and one side of a symmetric shape renders heavier than the other. At the
 * approved base (13) this is 12 / 14 / 16; move the base and it moves with it.
 */
const evenUp = (size: number): number => size + (size % 2);

export const iconSizes: Readonly<Record<IconSize, number>> = {
  sm: evenUp(metrics.type.medium), // 12 — beside a control label
  md: evenUp(metrics.type.body), //   14 — beside body text, the default
  lg: evenUp(metrics.type.large), //  16 — standalone, in a fixed slot
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
