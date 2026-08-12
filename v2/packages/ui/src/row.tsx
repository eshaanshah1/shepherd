import type { ComponentPropsWithRef, ReactElement, ReactNode } from 'react';
import { motion } from '@shepherd/design-tokens';
import { cn } from './cn.ts';

/**
 * How long a row's entrance lasts, for a caller that has to clear the mark when
 * it is over.
 *
 * Exported from the token rather than written twice: the CSS reads
 * `--sh-motion-enter` and the renderer reads this, both from `motion.enterMs`.
 * Two numbers that must match are one number that will not.
 */
export const rowEnterMs = motion.enterMs;

/**
 * The fixed-height list row.
 *
 * Four rules, each one a recorded defect rather than a preference:
 *
 *   1. **The height never changes.** Not for selection, not for hover, not for
 *      an alert, not for a trailing action appearing. v1 shipped a row that grew
 *      into a two-line card when its agent needed you and reverted it for being
 *      visually noisy; rule 9 is that finding. A row whose height depends on
 *      state also makes every list a layout that reflows while you read it.
 *   2. **The leading slot is a fixed box whose CONTENTS vary.** A dot, a
 *      spinner, a glyph, eventually the sheep. 12×12 whatever is in it and 12×12
 *      when it is empty — otherwise every row in a list starts its label at a
 *      different x depending on whether that particular row has a status.
 *   3. **Hover is a wash, selection is inverse video.** Rule 4, and the
 *      `fillSelected` role carries the argument: a wash next to a solid block is
 *      one glance apart, two washes one luminance step apart are not. The wash
 *      is `fillHover` (a `color-mix` over `text`) rather than a palette entry
 *      precisely so an extension's re-declared `--sh-text` moves it too.
 *   4. **The trailing area is a 1-cell grid.** Resting metadata and hover
 *      actions occupy the SAME cell, stacked, so revealing the actions cannot
 *      reflow the row. Swapping one for the other in the flow is what makes a
 *      list twitch as the pointer travels down it.
 *
 * **The root is a `<div>`, not a `<button>`,** and that is a real trade. The
 * shipped `.sh-row` is a button, which works only while a row contains nothing
 * clickable — and rule 4 above puts a hover ACTION in every row that wants one.
 * Nested interactive elements are invalid HTML and the inner control is
 * unreachable by keyboard inside a button. So the row is a div and the caller
 * supplies `role`, `tabIndex` and `onClick`, which is exactly the kind of prop
 * this component spreads.
 */

/**
 * The class names, exported.
 *
 * Synara's `sidebarRowStyles.ts` (reference item #5): an extension drawing its
 * own markup — a virtualised list, a drag-and-drop wrapper, a row that is really
 * a link — can look native without taking this component. That is a smaller
 * public API than the component, and it is the one an extension reaches for when
 * `Row`'s shape is nearly right but not quite; without it the extension writes
 * `className="sh-ui-row"` from a string it read in our source, which is the same
 * accidental public API the private palette names already were.
 */
export const rowClasses = {
  root: 'sh-ui-row',
  selected: 'sh-ui-row--selected',
  entering: 'sh-ui-row--entering',
  leading: 'sh-ui-row__leading',
  label: 'sh-ui-row__label',
  trailing: 'sh-ui-row__trailing',
  meta: 'sh-ui-row__meta',
  actions: 'sh-ui-row__actions',
} as const;

export interface RowProps extends ComponentPropsWithRef<'div'> {
  /** The 12×12 slot's occupant. `StateMark` is the default one. */
  readonly leading?: ReactNode;
  /** Resting metadata — a count, a branch, a time. Shares a cell with `actions`. */
  readonly meta?: ReactNode;
  /** Revealed on hover and on keyboard focus within, over `meta`, never beside it. */
  readonly actions?: ReactNode;
  readonly selected?: boolean;
  /**
   * This row is ARRIVING — fade and settle in, once.
   *
   * For a list that is re-read whole (every contributed tree is), where a row
   * appearing is otherwise one paint with N rows and the next with N+1: the list
   * reads as flickering rather than as something joining it.
   *
   * **It animates opacity and a 4px slide, and nothing else.** Not height: rule 1
   * above is that a row's height never changes, and an entrance that grew one
   * would reflow the list under the cursor for the length of the animation. Not a
   * pulse or a shimmer, which are banned outright. `prefers-reduced-motion` turns
   * it off entirely — an entrance is decoration, so there is nothing to preserve
   * a fallback for.
   *
   * The caller decides WHICH rows are new, because only it knows what the list
   * was a moment ago; this component only knows how the arrival looks.
   */
  readonly entering?: boolean;
}

export function Row({
  leading,
  meta,
  actions,
  selected = false,
  entering = false,
  className,
  children,
  ...rest
}: RowProps): ReactElement {
  return (
    <div
      className={cn(
        rowClasses.root,
        selected && rowClasses.selected,
        entering && rowClasses.entering,
        className,
      )}
      data-selected={selected ? 'true' : undefined}
      {...rest}
    >
      {/*
       * Rendered unconditionally. An empty slot is the point: the box holds the
       * label's x position for every row in the list, whether or not this
       * particular one has anything to put in it.
       */}
      <span className={rowClasses.leading}>{leading}</span>
      <span className={rowClasses.label}>{children}</span>
      {/*
       * Also unconditional, and also for a layout reason rather than a tidiness
       * one: a trailing area that appears with its first child changes the space
       * the label has, so a row that gains an action mid-list would re-truncate
       * its own text.
       */}
      <span className={rowClasses.trailing}>
        <span className={rowClasses.meta}>{meta}</span>
        <span className={rowClasses.actions}>{actions}</span>
      </span>
    </div>
  );
}
