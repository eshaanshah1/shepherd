import type { ComponentPropsWithRef, ReactElement } from 'react';
import { cn } from './cn.ts';

/**
 * The suite meter — §3's sixth mark: `n cells, 4×8, gap 1.5, grass when green,
 * #2A2A2A pending`.
 *
 * It is a *count you can read without counting*: four cells with three filled is
 * "nearly all of them" at a glance, where `3/4` is a number you have to parse.
 * The same information is in the accessible name for anyone who wants it exactly.
 *
 * Two rules it inherits from `StateMark` and one of its own:
 *
 *   - **No word beside it.** The tooltip and the `sr-only` text carry `3 of 4
 *     passed`; the row does not.
 *   - **A pending cell is NEUTRAL, never a dim green.** `meterPending` is a step
 *     on the neutral ramp. A dimmed `grass` would say "passed, a bit" — and the
 *     difference between "has not run" and "ran and passed" is the entire point
 *     of drawing this at all.
 *   - **It never draws a failure.** A suite that failed is the *task* failing,
 *     and that is `StateMark`'s `failed` square in the row's mark slot. A red
 *     cell here would put the same fact in two places with two shapes.
 *
 * Unlike `StateMark` this has no fixed slot: its width is a function of `total`,
 * and it is drawn at the trailing edge of a card where it has room. A meter
 * squeezed into a 12px box would be a bar chart with one bar.
 */

export interface SuiteMeterProps extends Omit<ComponentPropsWithRef<'span'>, 'title' | 'children'> {
  /** How many cells to draw. Zero renders nothing at all — see below. */
  readonly total: number;
  /** How many of them have passed. Clamped into `0…total`. */
  readonly passed: number;
  /** Overrides the default sentence — the accessible name and the tooltip. */
  readonly label?: string;
}

/**
 * A cap, because this is a mark and not a chart.
 *
 * Twelve cells at 4px plus their gaps is ~65px, which is already the widest thing
 * on a task card's trailing edge. A 400-test suite drawn honestly would be a
 * scrollbar. Past the cap the meter shows twelve cells PROPORTIONALLY filled and
 * the exact numbers stay in the label, which is the honest trade: the shape still
 * answers "how much of it passed", and nothing on screen claims to be a count.
 */
export const SUITE_METER_MAX_CELLS = 12;

export function SuiteMeter({ total, passed, label, className, ...rest }: SuiteMeterProps): ReactElement | null {
  // A suite that does not exist draws nothing. Returning an empty 0-cell span
  // would leave its gap and its margin in the layout, and a card with a
  // mysterious blank at the end of its diff line is worse than one without a
  // meter.
  if (!Number.isFinite(total) || total < 1) return null;

  const ran = Math.min(Math.max(Math.trunc(passed), 0), Math.trunc(total));
  const cells = Math.min(Math.trunc(total), SUITE_METER_MAX_CELLS);
  // Proportional above the cap, exact below it — `Math.round` rather than floor
  // so an all-green suite cannot render one cell short of full, which would be
  // the one reading that is actively wrong.
  const filled = cells === Math.trunc(total) ? ran : Math.round((ran / Math.trunc(total)) * cells);
  const word = label ?? `${ran} of ${Math.trunc(total)} passed`;

  return (
    <span className={cn('sh-ui-suite', className)} data-total={cells} title={word} {...rest}>
      <span className="sh-ui-suite__cells" aria-hidden="true">
        {Array.from({ length: cells }, (_, index) => (
          <i key={index} data-passed={index < filled ? 'true' : undefined} />
        ))}
      </span>
      <span className="sh-ui-sr-only">{word}</span>
    </span>
  );
}
