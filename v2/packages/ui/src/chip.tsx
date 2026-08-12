import type { ComponentPropsWithRef, ReactElement, ReactNode } from 'react';
import { cn } from './cn.ts';

/**
 * A chip — a small, flat, non-interactive label for a fact.
 *
 * The distinction from `Pill`, which is the only reason both exist: a `Pill`
 * stands for a THING you put there (a repo mention in the brief, removable, part
 * of the text), and a chip states a fact ABOUT something (a repo a task touches,
 * a branch a pane is on). One is an object, the other is a caption.
 *
 * It carries no border. §6 refuses "a badge pill on every count", and a bordered
 * chip beside a 13px row is the loudest thing on it — the fill is the whole
 * treatment.
 */

export interface ChipProps extends ComponentPropsWithRef<'span'> {
  /**
   * A design-token ROLE name for the identity square, e.g. `repo2`. Never a
   * colour: a call site that can name a colour is a call site that will, and a
   * chip with a hex in it is a visible bug the moment a user swaps themes.
   */
  readonly mark?: string;
  readonly children?: ReactNode;
}

export function Chip({ mark, className, children, ...rest }: ChipProps): ReactElement {
  return (
    <span className={cn('sh-ui-chip', className)} {...rest}>
      {mark === undefined ? null : (
        <i className="sh-ui-chip__mark" style={{ background: `var(--sh-${mark})` }} aria-hidden="true" />
      )}
      {children}
    </span>
  );
}
