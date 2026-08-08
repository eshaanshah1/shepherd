import type { ComponentPropsWithRef, ReactElement, ReactNode } from 'react';
import { cn } from './cn.ts';

/**
 * A bordered surface with a header slot — what a docked contributed view sits in.
 *
 * The shell styles the SLOT, not the extension: a contributed view owns its own
 * markup, and `Card` is the frame the shell puts around it so that three
 * extensions docked in one sidebar read as three sections of one app rather than
 * as three websites. That is the whole job, which is why it has no variants — a
 * `Card` with an `elevated` variant would be rule 2's elevation theater arriving
 * by the back door, and there is exactly one luminance step available.
 *
 * The header is a slot rather than a `title` string because what heads a docked
 * view is frequently a `SectionLabel` with a count and a control beside it. A
 * `title: string` would mean every one of those needs a second prop, and the
 * fourth such caller would render its own header and stop using this one.
 *
 * With no header, no header element is rendered — this is the one place a
 * conditional child is right, because the alternative is an empty bordered strip
 * at the top of every card that has nothing to say.
 */

export interface CardProps extends ComponentPropsWithRef<'section'> {
  readonly header?: ReactNode;
}

export function Card({ header, className, children, ...rest }: CardProps): ReactElement {
  const hasHeader = header !== undefined && header !== null && header !== false;
  return (
    <section className={cn('sh-ui-card', className)} {...rest}>
      {hasHeader ? <header className="sh-ui-card__header">{header}</header> : null}
      <div className="sh-ui-card__body">{children}</div>
    </section>
  );
}
