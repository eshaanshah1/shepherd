import type { ComponentPropsWithRef, ComponentType, ReactElement } from 'react';
import type { IconProps as TablerIconProps } from '@tabler/icons-react';
import { cn } from './cn.ts';
import { Icon } from './icon.tsx';

/**
 * A token that stands inside a sentence — `[icon] Image`.
 *
 * The shape is the mock's "+ Add action": fully-rounded ends, a hairline, a
 * subtle fill, an icon ahead of the label. What makes it a primitive rather
 * than a `Button` variant is WHERE it goes: a pill sits in the run of text,
 * standing for something the prose cannot say — a pasted image, an attachment,
 * a thing the composer is holding on the user's behalf. It is drawn in
 * `accent`, which is rule 3's "here, now" rather than a status.
 *
 * **It does not change the line it is in.** An inline-flex box contributes its
 * whole margin box to the line, so a pill taller than the line box would open
 * every line that happens to contain one and the paragraph would breathe
 * unevenly. Its height is therefore derived from `--sh-line-height` and stays
 * under it, and there is no margin — see `pill.css`.
 *
 * **Display only**, for `KeyCap`'s reason: a pressable thing in a run of text is
 * a link, and a link that looks like a control teaches the wrong gesture. No
 * `onClick` type, no hover state, `cursor: default`. When a pill needs to be
 * removable, the removal belongs to whatever owns the text — not to the token.
 */

export interface PillProps extends Omit<ComponentPropsWithRef<'span'>, 'onClick'> {
  /**
   * A Tabler icon, drawn at the control size and DECORATIVE — the label beside
   * it is the accessible name, and an icon read out twice is worse than an icon
   * read not at all (`Icon`'s own rule).
   */
  readonly icon?: ComponentType<TablerIconProps>;
}

export function Pill({ icon, className, children, ...rest }: PillProps): ReactElement {
  return (
    <span className={cn('sh-ui-pill', className)} {...rest}>
      {icon === undefined ? null : <Icon icon={icon} size="sm" />}
      {children}
    </span>
  );
}
