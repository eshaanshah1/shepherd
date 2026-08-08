import type { ComponentPropsWithRef, ReactElement, ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { cn } from './cn.ts';

/**
 * A modal dialog — Radix's, restyled.
 *
 * This is one of exactly two primitives that take a Radix dependency, and the
 * test is whether the BEHAVIOUR is real: a scrim, a focus trap, restoring focus
 * to whatever opened it, Esc, click-out, `aria-modal`, `inert` on the rest of
 * the page, scroll locking, and a portal so the card is not clipped by an
 * ancestor's `overflow: hidden`. Every one of those is a thing this codebase
 * would otherwise get wrong once and then get wrong again.
 *
 * **It draws no header.** The shipped composer proved the point: a title bar
 * over a form that asks one question is a label for nothing, and it cost a row
 * of vertical space at the top of the only surface in the app where space is the
 * structure. `title` is therefore an accessible name, rendered `sr-only`.
 *
 * That prop is REQUIRED, and not as ceremony. Radix warns at runtime when a
 * `Dialog.Content` has no `Dialog.Title`, and a dialog with no accessible name
 * announces itself as "dialog" — which for a surface that has just taken the
 * whole keyboard is the worst place in the app to say nothing. Making it a prop
 * means the name is a type error to omit rather than a console message nobody
 * reads.
 *
 * Sizes are `md` 460 and `lg` 620 and there is no `sm`: below 460 a modal is a
 * prompt, and a prompt that takes the whole keyboard to ask one short question
 * wants to be inline. The composer is `lg` — 460 made a brief read as a search
 * box, which is recorded in the shipped stylesheet.
 */

export type ModalSize = 'md' | 'lg';

export interface ModalProps extends Omit<ComponentPropsWithRef<'div'>, 'title'> {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The accessible name. Rendered `sr-only` — this component draws no header. */
  readonly title: string;
  readonly size?: ModalSize;
  readonly children?: ReactNode;
}

export function Modal({
  open,
  onOpenChange,
  title,
  size = 'md',
  className,
  children,
  ...rest
}: ModalProps): ReactElement {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="sh-ui-modal__scrim" />
        <Dialog.Content
          className={cn('sh-ui-modal', `sh-ui-modal--${size}`, className)}
          data-size={size}
          /*
           * Radix looks for a described-by target and warns when there is none.
           * There is deliberately none: a modal that draws no header has no
           * subtitle either, and pointing this at the body would read the entire
           * form as the dialog's description. `undefined` is Radix's own documented
           * way to say "there is no description", and it silences the warning
           * without inventing one.
           */
          aria-describedby={undefined}
          {...rest}
        >
          <Dialog.Title className="sh-ui-sr-only">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
