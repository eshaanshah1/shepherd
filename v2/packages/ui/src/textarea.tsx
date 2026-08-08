import type { CSSProperties, ComponentPropsWithRef, ReactElement, ReactNode } from 'react';
import { useId } from 'react';
import { lines } from '@shepherd/design-tokens';
import { cn } from './cn.ts';
import { fieldControlVariants, type FieldSize, type FieldVariant } from './field.tsx';

/**
 * A multi-line input — `Field` with more lines, and it shares Field's classes
 * rather than restating them.
 *
 * **`autoGrow` is measured in lines, never in px.** Synara's trick, and the
 * reason `lines()` exists in `design-tokens`: "two lines" is a real height that
 * survives the type scale moving, whereas `72px` (which is what the shipped
 * composer's brief says) is a guess that was correct exactly once. The shipped
 * value is already slightly wrong — 72 against a 24px line box is three lines,
 * not the two the comment beside it claims.
 *
 * The growth itself is CSS's `field-sizing: content`, not a ResizeObserver and
 * not a mirrored div. Electron 43 is Chromium 136 and the property landed in 123,
 * so the JS alternative would be reimplementing something the engine does — and
 * doing it a frame late, which is visible as the caret jumping. Where it is
 * unsupported the field simply stays at `minLines` and scrolls, which is the
 * behaviour without `autoGrow` at all.
 */

export interface TextAreaProps extends ComponentPropsWithRef<'textarea'> {
  readonly variant?: FieldVariant;
  readonly size?: FieldSize;
  readonly invalid?: boolean;
  readonly message?: ReactNode;
  /**
   * Grow with the content between `minLines` and `maxLines`.
   *
   * Off by default: a fixed box is the honest default for a form, and a field
   * that resizes while you type is a decision about the layout around it.
   */
  readonly autoGrow?: boolean;
  readonly minLines?: number;
  readonly maxLines?: number;
}

export function TextArea({
  variant,
  size,
  invalid = false,
  message,
  autoGrow = false,
  minLines = 2,
  maxLines = 12,
  className,
  style,
  ...rest
}: TextAreaProps): ReactElement {
  const messageId = useId();
  const hasMessage = message !== undefined && message !== null && message !== false;

  /*
   * The bounds are custom properties rather than direct `min-height` /
   * `max-height`, so the stylesheet keeps the opinion about which property they
   * drive and the component supplies only the two numbers. `lines()` spells them
   * `calc(N * var(--sh-line-height))` — deliberately not CSS's own `lh` unit,
   * which resolves against the ELEMENT's line-height and would give a textarea
   * that set its own a different "two lines" than the chrome around it.
   */
  const bounds = {
    '--sh-ui-textarea-min': lines(minLines),
    '--sh-ui-textarea-max': lines(maxLines),
  } as CSSProperties;

  return (
    <div className="sh-ui-field" data-invalid={invalid ? 'true' : undefined}>
      <textarea
        className={cn('sh-ui-textarea', fieldControlVariants({ variant, size }), className)}
        style={{ ...bounds, ...style }}
        data-variant={variant ?? 'bordered'}
        data-size={size ?? 'md'}
        data-auto-grow={autoGrow ? 'true' : undefined}
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
