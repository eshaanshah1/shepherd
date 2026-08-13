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
  quiet: 'sh-ui-row--quiet',
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
   * This row is a CONTROL on the list, not an entry in it — one step down the
   * ink ramp and one step down the type scale.
   *
   * For `20 more`, `Show fewer`, and anything else whose job is to operate on the
   * list it sits in. Such a row shipped at full `text` ink in body type, which
   * made the quietest region of the rail end in its loudest line — and `textFaint`
   * is the role whose stated job is "a control at rest", so the ramp already had
   * the answer.
   *
   * **Everything else about the row is unchanged**, deliberately: same height,
   * same leading slot, same hover fill, same focus ring. This is a volume knob,
   * not a second row variant — a control that also got shorter would be the
   * second-height defect §10 refuses, arriving through a door marked "quiet".
   */
  readonly quiet?: boolean;
  /**
   * This row is in a list with **no state column** — drop the leading slot
   * entirely rather than reserving an empty one.
   *
   * Rule 2 above argues the opposite and is still right about what it covers: within
   * one list the slot is fixed so a label's x cannot depend on whether that row has
   * a status. This is the case the rule does not reach — a whole REGION where nothing
   * has a mark, where the reserved box is 21px of indent every row pays for a column
   * that is always empty.
   *
   * The rail's Shipped region is the case it exists for: its rows' state is declared
   * once by the heading above them, so the heading, the day labels, the titles and
   * the `N more` control all share one left edge.
   *
   * **Declared by the caller, never inferred.** Whether a list has a state column is
   * a fact about the row's SIBLINGS, which neither this component nor the shell can
   * see — the same `… +3` row is right to reserve the box among tab rows that have
   * marks and wrong to reserve it among shipped rows that do not. Defaults to `true`,
   * so every existing list is unchanged.
   */
  readonly gutter?: boolean;
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
  quiet = false,
  gutter = true,
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
        quiet && rowClasses.quiet,
        entering && rowClasses.entering,
        className,
      )}
      data-selected={selected ? 'true' : undefined}
      data-quiet={quiet ? 'true' : undefined}
      {...rest}
    >
      {/*
       * Rendered whenever the list HAS a state column, empty or not: the box holds
       * the label's x position for every row in the list, whether or not this
       * particular one has anything to put in it.
       *
       * `gutter={false}` is the one way out, and it is a claim about the whole list
       * rather than about this row — see the prop.
       */}
      {gutter ? <span className={rowClasses.leading}>{leading}</span> : null}
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
