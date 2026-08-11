import type { ComponentPropsWithRef, ReactElement } from 'react';
import { cn } from './cn.ts';

/**
 * The state mark — §3, and the primitive everything else in this language leans
 * on.
 *
 * **A glance must be enough.** The app hosts other people's programs; its own
 * chrome should recede and let you read the one thing that changed. So state is
 * carried by a *mark* — a shape, in a fixed slot — and never by a word sitting
 * next to that mark. The word exists, as the mark's tooltip and its accessible
 * name, and that is where it stays. `StatusDot`, which this replaces, drew one
 * circle in five hues and let the shell write "Working" beside it; §6 refuses
 * both halves of that.
 *
 * Three properties, each load-bearing:
 *
 *   - **A fixed 12×12 slot, and the mark inside never resizes it.** A ring is
 *     7×7 and a square is 8×8 and a meter is 8 tall, and none of that is visible
 *     as motion when a task changes state, because the box does not move. This
 *     is also why the eventual animated sheep (`flock`) can land here without
 *     re-laying-out every row that draws one.
 *   - **A square always means *your move*.** A ring means nothing is happening.
 *     A meter means something is. The SHAPE is the vocabulary; `wool` and `red`
 *     are both squares because both are your move, and they differ in urgency
 *     rather than in kind.
 *   - **Every mark carries its word**, as a `title` and as `sr-only` text that is
 *     always in the DOM. Two states will eventually share a hue, and a fact
 *     encoded only in colour cannot be read out, searched, or asserted on.
 */

export type MarkState = 'working' | 'waiting' | 'resting' | 'failed' | 'shipped';

/**
 * The word each state says, and it is the accessible name unless overridden.
 *
 * Deliberately the MARK's vocabulary and not the agent lifecycle's (`needsCheck`,
 * `blocked`): a primitive does not know what a session is — the boundary rule
 * says so — and a consumer that wants `Waiting on you — approve Bash` passes
 * `label`.
 */
export const markWords: Readonly<Record<MarkState, string>> = {
  working: 'Working',
  waiting: 'Waiting on you',
  resting: 'Resting',
  failed: 'Failed',
  shipped: 'Shipped',
};

export interface StateMarkProps extends Omit<ComponentPropsWithRef<'span'>, 'role' | 'title'> {
  /** Which of the five, by state. There is no colour prop and there will not be. */
  readonly state: MarkState;
  /** Overrides the default word — for a reason ("Waiting on you — approve Bash"). */
  readonly label?: string;
}

export function StateMark({ state, label, className, ...rest }: StateMarkProps): ReactElement {
  const word = label ?? markWords[state];
  return (
    <span className={cn('sh-ui-mark', className)} data-state={state} title={word} {...rest}>
      {/*
       * The working meter is three real elements rather than a background image
       * or a pseudo-element pair, because only the THIRD one animates and a
       * pseudo-element cannot be addressed independently of its siblings.
       *
       * Every other state draws from `::before` on the host — one box, one shape,
       * nothing to lay out.
       */}
      {state !== 'working' ? null : (
        <span className="sh-ui-mark__bars" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
      {/*
       * Always rendered, never conditional. The mark itself is drawn by CSS, so
       * this text is the element's only real content and the ONLY thing that
       * survives a search, an assertion, or a theme in which two states landed on
       * one hue.
       */}
      <span className="sh-ui-sr-only">{word}</span>
    </span>
  );
}
