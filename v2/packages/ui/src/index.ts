/**
 * `@shepherd/ui` — the Shepherd primitive set.
 *
 * PUBLIC on purpose (design-system spec): an extension imports this, so a third
 * party's contributed view looks native and re-themes for free. That is the
 * substrate claim made real rather than marketed — the alternative is an
 * extension reaching for `var(--sh-ink-raised)`, a private palette name that was
 * already a public API by accident.
 *
 * Wave 1 is the foundation only: the class joiner, the component-tier
 * stylesheet, and the `Icon` primitive that half the others have a hole for.
 * The twelve components land in wave 2, each with a call site on the day it
 * lands — a primitive with no consumer is a design nobody has tested (spec §6).
 *
 * `cva` is a dependency and is deliberately NOT re-exported: a primitive uses it
 * to build its own variants, and an extension building variants of its own means
 * a primitive is missing rather than that `cva` should be public.
 */

export { cn, type ClassValue } from './cn.ts';
export { ICON_STROKE, Icon, iconSizes, type IconProps, type IconSize } from './icon.tsx';
