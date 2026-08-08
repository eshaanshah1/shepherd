import type { ComponentPropsWithRef, ReactElement } from 'react';
import { cn } from './cn.ts';
import { useBrailleFrame } from './spinner.ts';

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
  /**
   * Something is happening to the thing this dot describes, right now.
   *
   * The mark becomes rule 7's braille spinner — the SAME glyph sequence
   * `Button`'s `busy` uses, in the same fixed slot, so nothing moves and the app
   * has one way of looking busy rather than two. Not a pulse on the dot: rule 7
   * bans that in the same breath as it names this, and a state indicator that
   * eases is a state indicator you cannot read at a glance.
   *
   * It is orthogonal to `role`, which still says what the thing IS — a task
   * being archived is `success` *and* busy, and it goes back to being just
   * `success` when the archiving finishes.
   */
  readonly busy?: boolean;
}

export function StatusDot({ role, label, busy, className, ...rest }: StatusDotProps): ReactElement {
  const frame = useBrailleFrame(busy === true);
  const word = label ?? (busy === true ? statusWords.working : statusWords[role]);
  return (
    <span
      className={cn('sh-ui-status-dot', className)}
      data-status={role}
      data-busy={busy === true ? 'true' : undefined}
      title={word}
      {...rest}
    >
      {busy !== true ? null : (
        // Decorative: the word below is the readable content, and a screen
        // reader announcing a braille cell would read the animation aloud.
        <span className="sh-ui-status-dot__spinner" aria-hidden="true">
          {frame}
        </span>
      )}
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
