/**
 * `@shepherd/ui` — the Shepherd primitive set.
 *
 * PUBLIC on purpose (design-system spec): an extension imports this, so a third
 * party's contributed view looks native and re-themes for free. That is the
 * substrate claim made real rather than marketed — the alternative is an
 * extension reaching for `var(--sh-ink-raised)`, a private palette name that was
 * already a public API by accident.
 *
 * **Fifteen now, and none of the three arrived alone.** Spec §6 names the risk a
 * primitive set built ahead of its call sites runs — it grows members nobody
 * needs — and the mitigation is the rule that each new one lands with its first
 * real consumer in the same change, because a primitive with no caller is a
 * design nobody has tested. The three that joined the twelve, each with the
 * caller that bought it:
 *
 *   `Menu`            a right-click on a sidebar task row (Reveal / Archive /
 *                     Delete, the last two destructive). `Menu` was on the
 *                     "deliberately not in v1" list until that consumer existed.
 *   `Empty`           the shell's own empty state, which is now reachable: a
 *                     root can hold no panes, so "nothing here" is a real
 *                     projection rather than only the instant before main's
 *                     first push.
 *   `CommandPalette`  the kernel's command registry. Every command carries a
 *                     `title` documented as "shown in the palette", and there
 *                     was no palette — so `layout.zoom`, `layout.rename` and
 *                     every `tasks.*` verb had no way to be run from the UI.
 *
 * Still deliberately absent, and still for the same reason: Select, Tabs, Toast,
 * Popover, Table.
 *
 * `cva` is a dependency and is deliberately NOT re-exported: a primitive uses it
 * to build its own variants, and an extension building variants of its own means
 * a primitive is missing rather than that `cva` should be public.
 *
 * A page loads `@shepherd/ui/styles.css` once. It is not injected from here — a
 * stylesheet that mounts itself is a stylesheet whose cascade order nobody
 * controls, and the shell's own rules have to be able to come after it.
 */

export { cn, type ClassValue } from './cn.ts';
export { ICON_STROKE, Icon, iconSizes, type IconProps, type IconSize } from './icon.tsx';

// Controls
export { Button, buttonVariants, type ButtonProps, type ButtonSize, type ButtonVariant } from './button.tsx';
export { IconButton, type IconButtonProps, type IconButtonSize } from './icon-button.tsx';
export { KeyCap, type KeyCapProps } from './keycap.tsx';

// Input surfaces
export { Field, fieldControlVariants, type FieldProps, type FieldSize, type FieldVariant } from './field.tsx';
export { TextArea, type TextAreaProps } from './textarea.tsx';
export { Composer, type ComposerProps } from './composer.tsx';

export {
  CommandPalette,
  type CommandPaletteProps,
  type PaletteCommand,
} from './command-palette.tsx';
/**
 * The palette's ranking, exported as the pure function it is.
 *
 * A contributed view with its own list to filter should rank it the way the
 * palette does, or the app has two ideas about what a better match is. The
 * component is the one that owns a dialog; the scoring is just a comparison.
 */
export { fuzzyFilter, fuzzyScore, type FuzzyMatch } from './fuzzy.ts';

// Structure
export { Row, rowClasses, type RowProps } from './row.tsx';
export { Empty, type EmptyProps } from './empty.tsx';
export {
  Menu,
  isMenuSeparator,
  type MenuEntry,
  type MenuItemSpec,
  type MenuProps,
  type MenuSeparatorSpec,
} from './menu.tsx';
export { SectionLabel, type SectionLabelProps } from './section-label.tsx';
export { Card, type CardProps } from './card.tsx';
export { Modal, type ModalProps, type ModalSize } from './modal.tsx';
export {
  TOOLTIP_DELAY_MS,
  Tooltip,
  TooltipProvider,
  type TooltipProps,
  type TooltipSide,
} from './tooltip.tsx';
export { StatusDot, statusWords, type StatusDotProps, type StatusRole } from './status-dot.tsx';

/**
 * The braille spinner's frames and its cadence.
 *
 * Exported because `Button`'s `busy` is not the only place a working indicator
 * belongs — a contributed view that runs its own long operation needs the same
 * glyph sequence, and the alternative is that it picks a different one and the
 * app has two ways of looking busy. The hook stays private: it is React state and
 * an interval, and a consumer that wants it has a Button.
 */
export { BRAILLE_FRAMES, SPINNER_TICK_MS } from './spinner.ts';
