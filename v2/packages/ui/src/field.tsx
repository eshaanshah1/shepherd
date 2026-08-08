import type { ComponentPropsWithRef, ReactElement, ReactNode } from 'react';
import { useId } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from './cn.ts';

/**
 * A single-line input.
 *
 * Flock's split, made structural: **instruments get borders, writing surfaces
 * get space.** `bordered` is the instrument — a settings row, a filter — and it
 * is a recessed well (`surfaceSunken`) with a hairline. `bare` has neither: it
 * sits directly ON the surface it is in, which is what a `Composer` gives it, and
 * the caret plus the card's own luminance step are the whole focus signal.
 *
 * The two variants are a single component and not two, because the difference is
 * one paint job over identical behaviour, sizing and validity handling — and the
 * shipped shell's evidence is that two of them drift (`.sh-ext-card input` and
 * `.sh-composer input` already disagree about padding, radius, colour and focus).
 *
 * **Invalid is an ember border PLUS a message, never a colour alone.** A red edge
 * with nothing to read tells you something is wrong and not what, and to anyone
 * who cannot see the red it tells them nothing at all. `invalid` without
 * `message` is legal (the caller may be showing the reason elsewhere) but the
 * message slot is why `Field` has a wrapper element and is not just an `<input>`.
 */

export type FieldVariant = 'bordered' | 'bare';
export type FieldSize = 'sm' | 'md';

/**
 * The control's own classes — shared with `TextArea`, which is this component
 * with more lines. Exported so that reuse is a real import rather than a second
 * copy of the same six rules under a different name.
 */
export const fieldControlVariants = cva('sh-ui-field__control', {
  variants: {
    variant: {
      bordered: 'sh-ui-field__control--bordered',
      bare: 'sh-ui-field__control--bare',
    },
    size: {
      sm: 'sh-ui-field__control--sm',
      md: 'sh-ui-field__control--md',
    },
  },
  defaultVariants: { variant: 'bordered', size: 'md' },
});

export interface FieldProps extends Omit<ComponentPropsWithRef<'input'>, 'size'> {
  readonly variant?: FieldVariant;
  readonly size?: FieldSize;
  readonly invalid?: boolean;
  /** The reason. Rendered under the control and wired up as its description. */
  readonly message?: ReactNode;
}

export function Field({
  variant,
  size,
  invalid = false,
  message,
  className,
  ...rest
}: FieldProps): ReactElement {
  const messageId = useId();
  const hasMessage = message !== undefined && message !== null && message !== false;

  /*
   * `rest`, `ref` and `className` all land on the INPUT, not on the wrapper.
   *
   * The wrapper is an implementation detail — it exists to stack the message
   * under the control and has no other job — whereas everything a caller means by
   * "this field" (a `value`, a `data-testid`, an `aria-describedby` we did not
   * anticipate, a width) is about the thing you type in. Splitting them would put
   * an extension's `data-*` on a box and its `className` on another.
   */
  return (
    <div className="sh-ui-field" data-invalid={invalid ? 'true' : undefined}>
      <input
        className={cn(fieldControlVariants({ variant, size }), className)}
        data-variant={variant ?? 'bordered'}
        data-size={size ?? 'md'}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={hasMessage ? messageId : undefined}
        {...rest}
      />
      {hasMessage ? (
        <span className="sh-ui-field__message" id={messageId}>
          {message}
        </span>
      ) : null}
    </div>
  );
}
