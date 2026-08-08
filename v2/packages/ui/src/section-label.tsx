import type { ComponentPropsWithRef, ReactElement } from 'react';
import { cn } from './cn.ts';

/**
 * `NEEDS YOU · 2 ────────────` — the micro-label that heads a list.
 *
 * Rule 5's instrument voice: uppercase, 10px, tracked, with the count as part of
 * the label rather than as a badge pill (which the anti-tells ban by name). It
 * survived the reference comparison deliberately — both reference apps went
 * sentence-case for their section headings and both are duller for it, and this
 * is the one place the language is allowed to sound like an instrument panel
 * rather than a document.
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
  /** Shown after the label, separated by a drawn `·`. `0` still renders. */
  readonly count?: number;
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
