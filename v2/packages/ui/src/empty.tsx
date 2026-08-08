import type { ComponentPropsWithRef, ReactElement, ReactNode } from 'react';
import { cn } from './cn.ts';

/**
 * The stage with nothing on it — Flock rule 9's "personality lives in moments".
 *
 * Three slots, in the order they are read: an ILLUSTRATION, a SENTENCE, and a
 * HINT. That is the whole component, and the reason it is a primitive rather
 * than a page is the first slot: **the ewe stays in the app.** She is Shepherd's
 * mascot, not a generic empty box's decoration, and a contributed view with
 * nothing in it wants the same layout, the same serif voice and the same quiet
 * hint without inheriting somebody else's animal.
 *
 * **The sentence is serif, and that is the rule this component enforces.** Rule 6
 * is that serif appears only where the app SPEAKS in sentences, and an empty
 * state is the clearest instance of that in the product: it is the one surface
 * whose entire content is the app talking to you rather than reporting a value.
 * Written as a class on the caller's `<p>` it was a convention; written here it
 * is a property of every empty state anyone builds.
 *
 * FINDING, reported with this wave: the shipped `empty-state.tsx` referenced
 * `.sh-empty`, `.sh-ewe`, `.sh-ewe-eye`, `.sh-empty-say` and `.sh-empty-hint`,
 * and **not one of those had a rule anywhere in the repo**. The ewe therefore
 * drew as solid black default-filled circles, unpositioned, in the top-left
 * corner of the stage. It had never been seen because it had never been
 * reachable (the bug this wave also fixes), which is the argument for a
 * primitive with a stylesheet that ships beside it rather than a set of class
 * names a page is trusted to style.
 *
 * The illustration is styled BY THE CALLER, deliberately: this component gives it
 * a box and a size ceiling and says nothing about its fills, because a line
 * drawing, a photograph and a spinner are three different things and the only
 * one this package could have an opinion about is the one it does not own.
 */

export interface EmptyProps extends ComponentPropsWithRef<'div'> {
  /**
   * The picture. Passed IN — see above. Rendered in a box with a max size and no
   * opinion about its contents.
   */
  readonly illustration?: ReactNode;
  /**
   * The quiet line underneath — a shortcut, a next step. Optional, because an
   * empty state with nothing to suggest should say nothing rather than pad.
   */
  readonly hint?: ReactNode;
  /** The sentence. Set in serif, and it should be one sentence. */
  readonly children?: ReactNode;
}

export function Empty({ illustration, hint, className, children, ...rest }: EmptyProps): ReactElement {
  return (
    <div className={cn('sh-ui-empty', className)} {...rest}>
      {illustration === undefined ? null : (
        <div className="sh-ui-empty__art" aria-hidden="true">
          {illustration}
        </div>
      )}
      {/*
       * A `<p>`, and rendered even when empty is not a thing this one does: an
       * empty state with no sentence is an empty state that says nothing, which
       * is the failure mode the whole surface exists to avoid. A caller with
       * nothing to say has no business drawing this.
       */}
      <p className="sh-ui-empty__say">{children}</p>
      {hint === undefined ? null : <p className="sh-ui-empty__hint">{hint}</p>}
    </div>
  );
}
