/**
 * `@shepherd/ui` — the Shepherd primitive set.
 *
 * PUBLIC on purpose (design-system spec): an extension imports this, so a third
 * party's contributed view looks native and re-themes for free. That is the
 * substrate claim made real rather than marketed — the alternative is an
 * extension reaching for `var(--sh-ink-raised)`, a private palette name that was
 * already a public API by accident.
 *
 * **Seventeen now, and none of the five arrived alone.** Spec §6 names the risk a
 * primitive set built ahead of its call sites runs — it grows members nobody
 * needs — and the mitigation is the rule that each new one lands with its first
 * real consumer in the same change, because a primitive with no caller is a
 * design nobody has tested. The five that joined the twelve, each with the
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
 *   `Switch`          the settings screen's `boolean` row. There was no boolean
 *                     control at all, so a toggle was a `Button` that lied about
 *                     its state or a checkbox that lied about when it applies.
 *   `Select`          the settings screen's `enum` row. It was on the list below
 *                     until this wave, and its absence is why `tasks` built
 *                     `RepoPicker` inside its own UI: an extension that had to
 *                     pick from a list had to hand-roll the listbox.
 *
 * Still deliberately absent, and still for the same reason: Tabs, Toast, Popover,
 * Table.
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
export { Switch, type SwitchProps } from './switch.tsx';
export { Select, DEFAULT_OPTION_LABEL, type SelectOption, type SelectProps } from './select.tsx';
export { KeyCap, type KeyCapProps } from './keycap.tsx';
/**
 * Display only, and here beside `KeyCap` for that reason rather than because a
 * pill is a control. It is a token that stands INSIDE a sentence — a pasted
 * image, an attachment — and it is shaped so it cannot open the line it is in.
 */
export { Pill, type PillProps } from './pill.tsx';

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
 * The palette's ranking, re-exported from where it now lives.
 *
 * A contributed view with its own list to filter should rank it the way the
 * palette does, or the app has two ideas about what a better match is. The
 * component is the one that owns a dialog; the scoring is just a comparison.
 *
 * It MOVED to `@shepherd/sdk` with the repo picker, because an extension's
 * service half needs the same ranking — it holds the history and reads the
 * directory, so it is the side that must filter and cap before the answer
 * crosses a message port, and this package is importable only from the page.
 * Re-exported rather than deleted: a view that already had it should not have to
 * learn a second import path to keep it.
 */
export { fuzzyFilter, fuzzyMatch, fuzzyScore, type FuzzyMatch } from '@shepherd/sdk';

// Structure
export { Row, rowClasses, rowEnterMs, type RowProps } from './row.tsx';
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
export { BRAILLE_FRAMES, SPINNER_TICK_MS, useBrailleFrame } from './spinner.ts';
export { PromptField, readValue, type PromptFieldHandle, type PromptFieldProps } from './prompt-field.tsx';
