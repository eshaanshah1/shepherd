import type { ComponentPropsWithRef, ReactElement } from 'react';
import { cn } from './cn.ts';

/**
 * The writing surface — a container, and the only primitive whose job is a
 * CONTEXT rather than a control.
 *
 * Flock's split says instruments get borders and writing surfaces get space.
 * `Composer` is where the second half lives: one well, the soft 16px radius, no
 * inner hairlines, generous padding. The ⌘T task composer is the first instance;
 * a command palette is the second, and that is the test a primitive has to pass
 * (spec §6) — a container with one caller would be a layout, not a primitive.
 *
 * **What makes it a primitive rather than a class name is the scoped role
 * re-declaration** (spec §2, and `composer.css` is where it is written). A
 * `<Field>` dropped inside gets no well and no hairline *without being told it is
 * inside a composer* — because the composer re-declared `--sh-surface`,
 * `--sh-sunken` and `--sh-line` for its subtree, and the field is still just
 * asking for the generic roles. That is the mechanism the whole token tier exists for, and it is why
 * this is not a parallel `--sh-composer-field-bg` family: the alternative is what
 * pane chrome does today, and it needs every component to know where it is.
 *
 * The consequence worth stating out loud: **a control that needs a visible edge
 * inside a composer re-declares `--sh-line` back on itself.** That is not a
 * workaround, it is the same mechanism used in the other direction, and it keeps
 * "no inner hairlines" as a property of the container rather than of a list of
 * components that remembered.
 */

export interface ComposerProps extends ComponentPropsWithRef<'div'> {}

export function Composer({ className, children, ...rest }: ComposerProps): ReactElement {
  return (
    <div
      className={cn('sh-ui-composer', className)}
      /*
       * The name of the scope, for the dev inspector (spec §4) and for anyone
       * reading the DOM to work out why a field inside here has no border. The
       * CSS selects on the class; this attribute is documentation that ships.
       */
      data-surface="composer"
      {...rest}
    >
      {children}
    </div>
  );
}
