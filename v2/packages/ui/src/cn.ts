/**
 * Join class names, dropping anything falsy.
 *
 * This is `clsx` + `tailwind-merge`'s job in a shadcn tree, and it is three lines
 * because we threw away the half that made those two necessary. `tailwind-merge`
 * exists to resolve *conflicting utilities* (`px-2` losing to a later `px-4`);
 * with plain CSS classes there is nothing to merge — `.sh-button` and
 * `.sh-button--primary` are not in competition, the cascade already decides, and
 * a merger that tried to would be guessing at rules it cannot see.
 *
 * Objects and nested arrays are deliberately unsupported: `cn('a', cond && 'b')`
 * is the whole idiom a primitive needs, and every extra input shape is a way for
 * a call site to express something the CSS cannot honour.
 */
export type ClassValue = string | false | null | undefined;

export function cn(...parts: ClassValue[]): string {
  return parts.filter(Boolean).join(' ');
}
