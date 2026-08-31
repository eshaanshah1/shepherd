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
 *     8×8 and a square is 8×8 and a meter is 8 tall, and none of that is visible
 *     as motion when a task changes state, because the box does not move. This
 *     is also why the eventual animated sheep (`flock`) can land here without
 *     re-laying-out every row that draws one.
 *   - **A square always means *your move*.** A meter means an agent is running.
 *     A dashed ring means you have already answered — put off, with a way back —
 *     which makes it the one state that is neither yours nor an agent's right
 *     now. The SHAPE is the vocabulary; `wool`, `grass` and `red` are all squares
 *     because all three are your move, and they differ in urgency rather than in
 *     kind — a question, a finished turn nobody has read, a run that failed.
 *
 *     **There is no mark for a task that is merely idle.** Nothing running IS
 *     your move, so an idle task wears the green square a finished turn wears:
 *     both mean look at this, and a shape that said "nothing is happening" was
 *     drawing the absence of an agent as though it were the absence of work.
 *   - **Every mark carries its word**, as a `title` and as `sr-only` text that is
 *     always in the DOM. Two states will eventually share a hue, and a fact
 *     encoded only in colour cannot be read out, searched, or asserted on.
 */

export type MarkState = 'working' | 'waiting' | 'ready' | 'later' | 'failed' | 'shipped';

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
  ready: 'Ready for you',
  later: 'Later',
  failed: 'Failed',
  shipped: 'Shipped',
};

/**
 * The empty slot, as a class name — for a row that must hold the state column
 * without claiming a state.
 *
 * The same escape hatch `rowClasses` is: a consumer drawing its own markup gets
 * the box without taking the component. The box is all there is to get, since
 * every shape in the stylesheet hangs off `[data-state]` — omit the attribute and
 * `.sh-ui-mark` is exactly 12×12 of nothing.
 *
 * It exists so the 12px stays in ONE file. `state-mark.css` opens by saying these
 * are the sizes of marks rather than of chrome and are not repeated elsewhere; a
 * consumer that wrote its own `inline-size: 12px` would be the repetition that
 * comment forbids, and it would drift the first time a mark changed size.
 *
 * The honest use is a row whose state is already stated by the region it sits in
 * — a shipped task under a heading that says Shipped. The other is a row whose
 * state is genuinely unknown: no payload yet, or a tint word this build does not
 * carry. `StateMark` renders this box for an absent `state`, so a consumer taking
 * the component gets the same answer without reaching for the class.
 */
export const markSlot = 'sh-ui-mark';

export interface StateMarkProps extends Omit<ComponentPropsWithRef<'span'>, 'role' | 'title'> {
  /**
   * Which of the six, by state. There is no colour prop and there will not be.
   *
   * Absent draws the empty slot — the 12×12 box and nothing in it, with no word
   * and no tooltip. That is for a row whose state this build cannot name: a
   * payload that has not arrived, or a tint spelling nothing maps. Guessing a
   * state there would put a claim in the one column the eye scans first, and the
   * only honest guess is silence.
   */
  readonly state?: MarkState;
  /** Overrides the default word — for a reason ("Waiting on you — approve Bash"). */
  readonly label?: string;
}

export function StateMark({ state, label, className, ...rest }: StateMarkProps): ReactElement {
  const word = state === undefined ? undefined : (label ?? markWords[state]);
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
      {word === undefined ? null : <span className="sh-ui-sr-only">{word}</span>}
    </span>
  );
}
