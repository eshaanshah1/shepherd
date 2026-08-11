import type { ComponentPropsWithRef, ReactElement } from 'react';
import { IconArrowUp } from '@tabler/icons-react';
import { cn } from './cn.ts';

/**
 * The send button — **the only round element in the product**, and the only
 * weighted control on the composer's card.
 *
 * It is a separate primitive rather than a `Button` variant for a reason that is
 * about the rules rather than about the styling: §4 says one primary per surface
 * and that primary is `wool`. This is neither. It is a `sky` circle, and if it
 * were a variant then every surface in the app could grow one — which is exactly
 * how a language ends up with two loud things per screen and neither reading as
 * the action.
 *
 * Being its own component means the refusal is structural: there is one place
 * that draws a circle, it is imported by the composer, and a second caller is a
 * conversation rather than a prop.
 */

export interface SendButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  /**
   * The accessible name. Required, like `IconButton`'s — a control whose whole
   * content is a glyph has no text to be announced by.
   */
  readonly label: string;
}

export function SendButton({ label, className, disabled, ...rest }: SendButtonProps): ReactElement {
  return (
    <button
      type="button"
      className={cn('sh-ui-send', className)}
      aria-label={label}
      title={label}
      disabled={disabled}
      aria-disabled={disabled === true ? true : undefined}
      {...rest}
    >
      {/*
        Not the `Icon` primitive: that fixes one stroke weight for the app's
        chrome, and this arrow sits inside a 34px circle where 1.75 reads as a
        hairline. The size and weight are the CIRCLE's, not the icon ramp's,
        which is the same argument that makes this a component rather than a
        variant.
      */}
      <IconArrowUp size={17} stroke={2.4} aria-hidden="true" />
    </button>
  );
}
