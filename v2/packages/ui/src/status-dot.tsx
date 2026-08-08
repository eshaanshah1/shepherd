import type { ComponentPropsWithRef, ReactElement } from 'react';
import { cn } from './cn.ts';

/**
 * The 12×12 leading slot's default occupant.
 *
 * **It takes a role, never a colour.** `<StatusDot role="attention" />`, and
 * which hue that is stays a fact about the token layer. The shipped `.sh-dot`
 * shows what the alternative costs: `data-tint` accepts `working`, `cobalt` AND
 * `accent` as three spellings of one thing, and `blocked`, `needs-you`, `hay`
 * and `review` as four spellings of another — because once a call site can name
 * a colour, every call site names it differently and no rename is possible.
 *
 * **It always carries a word.** A native `title` for the pointer, and `sr-only`
 * text that is always in the DOM. Orca's pairing, and the reason is concrete
 * rather than compliance: five states over four accent hues means two of them
 * already share one, and the moment a sixth arrives a dot is genuinely
 * ambiguous to everyone, not only to a colour-blind user. A status encoded once,
 * in colour, is a status that cannot be read out, searched, or asserted on.
 *
 * Rule 8 names the eventual indicator — an animated sheep, one per activity —
 * and this is its documented micro fallback (status bar, collapsed pips, and any
 * row too small for a silhouette). When the flock lands it occupies this same
 * fixed box, which is the reason the box is fixed.
 */

export type StatusRole = 'working' | 'attention' | 'success' | 'danger' | 'idle';

/**
 * The word each role says, and it is the accessible name unless overridden.
 *
 * Deliberately the ROLE's vocabulary and not the agent lifecycle's (`needsCheck`,
 * `blocked`): a primitive does not know what a session is (the boundary rule says
 * so), and a consumer that wants `Blocked — approve Bash` passes `label`.
 */
export const statusWords: Readonly<Record<StatusRole, string>> = {
  working: 'Working',
  attention: 'Needs you',
  success: 'Done',
  danger: 'Error',
  idle: 'Idle',
};

export interface StatusDotProps extends Omit<ComponentPropsWithRef<'span'>, 'role' | 'title'> {
  /** Which of the five, by role. There is no colour prop and there will not be. */
  readonly role: StatusRole;
  /** Overrides the default word — for a reason ("Blocked — plan approval"). */
  readonly label?: string;
}

export function StatusDot({ role, label, className, ...rest }: StatusDotProps): ReactElement {
  const word = label ?? statusWords[role];
  return (
    <span
      className={cn('sh-ui-status-dot', className)}
      data-status={role}
      title={word}
      {...rest}
    >
      {/*
       * Always rendered, never conditional on anything. The dot itself is drawn
       * by a pseudo-element, so this text is the element's only real content and
       * the ONLY thing that survives a screenshot being described, a search, or a
       * theme in which two states landed on the same hue.
       */}
      <span className="sh-ui-sr-only">{word}</span>
    </span>
  );
}
