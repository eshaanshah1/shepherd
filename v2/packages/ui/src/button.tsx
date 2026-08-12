import type { ComponentPropsWithRef, MouseEvent, ReactElement } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { cn } from './cn.ts';
import { useBrailleFrame } from './spinner.ts';

/**
 * The one action element.
 *
 * "One" is the load-bearing word. The shipped shell has three button treatments
 * (`.sh-key`, `.sh-ext-card button`, `.sh-composer-create`) that were each
 * invented where they were written and now disagree about height, radius, case
 * and what a hover does. Four variants of one component is a vocabulary; three
 * components that are all buttons is the absence of one.
 *
 * `variant` answers HOW LOUD, never what the button does — there is no `submit`
 * or `confirm` variant, because rule 3 assigns colour a job and "this one is the
 * form's" is not a job. `danger` is bordered and only fills on hover for the same
 * reason `success` is not a variant at all: green means a state, not an action
 * (the `success` role's own `notFor`).
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export const buttonVariants = cva('sh-ui-button sh-ui-focusable', {
  variants: {
    variant: {
      primary: 'sh-ui-button--primary',
      secondary: 'sh-ui-button--secondary',
      ghost: 'sh-ui-button--ghost',
      danger: 'sh-ui-button--danger',
    },
    size: {
      sm: 'sh-ui-button--sm',
      md: 'sh-ui-button--md',
      lg: 'sh-ui-button--lg',
    },
  },
  defaultVariants: { variant: 'secondary', size: 'md' },
});

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /**
   * Render the caller's own element with this Button's styling and behaviour —
   * a link that looks like a button, without a second component that has to be
   * kept in step with this one.
   *
   * The label/spinner wrapper is NOT applied in this mode: Radix's `Slot` merges
   * onto exactly one child, so the caller's element is rendered as written. That
   * means `busy` cannot pin a width here and is therefore ignored — an `asChild`
   * button that has to show progress wants to be a real Button.
   */
  readonly asChild?: boolean;
  /**
   * A braille spinner replaces the label, and the box does not move.
   *
   * The width is pinned by keeping the label in the layout with `visibility:
   * hidden` and floating the spinner over it, rather than by a min-width guess.
   * A guess is wrong for every label that is not the one it was measured
   * against, and a button that narrows when it starts working reflows the row it
   * sits in — which in a toolbar moves every control beside it, mid-click.
   *
   * Busy is also INERT, like disabled: the click that started the work must not
   * be able to start it twice.
   */
  readonly busy?: boolean;
}

export function Button({
  variant,
  size,
  asChild = false,
  busy = false,
  className,
  disabled,
  onClick,
  children,
  ...rest
}: ButtonProps): ReactElement {
  const frame = useBrailleFrame(busy);
  const inert = Boolean(disabled) || busy;
  const classes = cn(buttonVariants({ variant, size }), className);

  /*
   * The guard is HERE and not left to the `disabled` attribute alone.
   *
   * `asChild` can render an anchor, which has no `disabled` — and even on a real
   * button, a synthetic click dispatched at the element (which is what a
   * programmatic caller, a drag-release and a test all do) still reaches a React
   * handler. One place that decides whether a click counts, so "inert" means the
   * same thing for every variant and every element this can become.
   */
  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (inert) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClick?.(event);
  };

  const shared = {
    className: classes,
    onClick: handleClick,
    'data-variant': variant ?? 'secondary',
    'data-size': size ?? 'md',
    'data-busy': busy ? ('true' as const) : undefined,
    'aria-busy': busy ? true : undefined,
    'aria-disabled': inert ? true : undefined,
    ...rest,
  };

  if (asChild) {
    return (
      <Slot {...shared} data-disabled={inert ? 'true' : undefined}>
        {children}
      </Slot>
    );
  }

  return (
    <button type="button" disabled={inert} {...shared}>
      {/* Stays in the layout while busy — hidden, not removed. That IS the width pin. */}
      <span className="sh-ui-button__label">{children}</span>
      {busy ? (
        <span className="sh-ui-button__spinner" aria-hidden="true">
          {frame}
        </span>
      ) : null}
    </button>
  );
}
