import type { ComponentPropsWithRef, ReactElement, ReactNode } from 'react';
import { cn } from './cn.ts';

/**
 * `Waiting on you ──────────── 2` — the label that heads a list.
 *
 * **Sentence case, 11.5 / 600, no tracking.** §10 refuses uppercase micro-labels
 * with tracking by name: this is the one string on the surface a reader scans
 * rather than reads, and uppercase costs word shape, which is the thing scanning
 * uses. Weight carries it instead. (This docstring argued the opposite for a
 * while after the stylesheet had already been changed — the CSS is the one that
 * was right.) The count is part of the label rather than a badge pill, which the
 * refusals also ban.
 *
 * It is a HEADING, not a row: no hover, no selection, no fixed 12px slot. It
 * happens to be one row tall so the list has a single vertical rhythm, and that
 * is the only thing it shares with `Row`.
 *
 * The separator between label and count is DRAWN, not typed. The caller supplies
 * two values and the stylesheet supplies the `·`, so a heading with no count has
 * no orphaned dot and nobody has to remember which side it goes on.
 */

export interface SectionLabelProps extends ComponentPropsWithRef<'div'> {
  /**
   * Shown after the label, separated by a drawn `·`. `0` still renders.
   *
   * `ReactNode` rather than `number`, and that widening is a finding from the
   * shell port rather than a convenience. A heading in the sidebar is a
   * CONTRIBUTED row, and what a contribution supplies is `TreeItem.description`
   * — an opaque string it wrote (`2`, but also `3 archived`, and whatever the
   * next extension decides). Typed `number`, the shell would have to parse an
   * extension's text to hand it over, and the first unparseable one becomes
   * `NaN` on screen. The `·` is drawn either way, so nothing about the treatment
   * depends on which it is.
   */
  readonly count?: ReactNode;
  /**
   * The hairline that runs from the label to the container's edge. On by
   * default: it is what makes the heading read as a rule with a name on it
   * rather than as a very quiet row.
   */
  readonly rule?: boolean;
}

export function SectionLabel({
  count,
  rule = true,
  className,
  children,
  ...rest
}: SectionLabelProps): ReactElement {
  return (
    <div
      className={cn('sh-ui-section-label', className)}
      data-rule={rule ? 'true' : 'false'}
      {...rest}
    >
      <span className="sh-ui-section-label__text">{children}</span>
      {count === undefined ? null : (
        <span className="sh-ui-section-label__count">{count}</span>
      )}
    </div>
  );
}
