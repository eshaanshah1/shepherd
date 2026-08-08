import type { ComponentType, ReactElement } from 'react';
import type { IconProps as TablerIconProps } from '@tabler/icons-react';
import { cn } from './cn.ts';
import { Button, type ButtonProps, type ButtonVariant } from './button.tsx';
import { Icon } from './icon.tsx';

/**
 * A square Button carrying one icon and no text.
 *
 * It exists because that control reached the screen with no CSS at all
 * (`.sh-icon-button`), which is the opening anecdote of the design-system spec.
 * It is built ON Button rather than beside it so there is exactly one answer to
 * what a hover does, what disabled looks like and how a click is guarded — a
 * second implementation is how the shipped shell ended up with three button
 * treatments that disagree.
 *
 * **The label is required, and that is the whole point.** An icon-only control
 * with no accessible name is a button that reads as "button" to a screen reader,
 * and it is also — measurably, on this codebase's own evidence — the control
 * nobody remembers to describe. `label` is a required prop, so it is a TYPE
 * error rather than a lint rule that has to be installed and kept on. The `Icon`
 * inside stays DECORATIVE (`aria-hidden`): the name belongs to the button, and
 * naming both would read the same word twice.
 *
 * Two sizes, 22 and 28, and no `lg`: a 34px icon button is a toolbar button, and
 * this app has no toolbar. A primitive with no call site is a design nobody has
 * tested (spec §6), and that applies to a size as much as to a component.
 */

export type IconButtonSize = 'sm' | 'md';

export interface IconButtonProps
  extends Omit<ButtonProps, 'size' | 'children' | 'aria-label' | 'asChild'> {
  /** A Tabler icon component, e.g. `IconPlus`. */
  readonly icon: ComponentType<TablerIconProps>;
  /**
   * The accessible name — REQUIRED. It also becomes the native `title`, so the
   * same string is the hover hint; a Tooltip is the richer answer and this is the
   * floor beneath it.
   */
  readonly label: string;
  readonly size?: IconButtonSize;
  readonly variant?: ButtonVariant;
}

export function IconButton({
  icon,
  label,
  size = 'md',
  variant = 'ghost',
  className,
  title,
  ...rest
}: IconButtonProps): ReactElement {
  return (
    <Button
      {...rest}
      variant={variant}
      size={size}
      aria-label={label}
      title={title ?? label}
      className={cn('sh-ui-icon-button', `sh-ui-icon-button--${size}`, className)}
    >
      {/*
       * `sm` on a 22px box and `md` on a 28px one: the glyph is ~55% of the
       * square either way, which is the proportion that reads as an icon rather
       * than as a letter that happens to be a picture.
       */}
      <Icon icon={icon} size={size === 'sm' ? 'sm' : 'md'} />
    </Button>
  );
}
