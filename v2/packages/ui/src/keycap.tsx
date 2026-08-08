import type { ComponentPropsWithRef, ReactElement } from 'react';
import { cn } from './cn.ts';

/**
 * `⌘T` — a boxed keycap. Rule 5's instrument voice, and DISPLAY ONLY.
 *
 * It is a `<kbd>`, it has no variants and it is never a button. Both halves of
 * that are recorded lessons rather than taste:
 *
 *   - v1's cheatsheet is the reason the element exists at all — a shortcut
 *     rendered as prose ("press Command-T") is a shortcut nobody reads.
 *   - v2's sidebar footer is the reason it is not pressable. A keycap reading
 *     `⌘T NEW TASK` sat at the bottom of the list as the only way to add one,
 *     which teaches a shortcut instead of being a button. It was removed and
 *     replaced with a real `IconButton` at the top. A KeyCap that could be
 *     clicked would invite exactly that again, so it cannot be: no `onClick`
 *     type, no hover state, `cursor: default`.
 *
 * It renders whatever it is handed. There is no `keys={['cmd','t']}` array and
 * no symbol table — a modifier glyph is platform vocabulary the caller already
 * knows (the app is macOS-only), and a table here would be a second place where
 * `⌘` is spelled.
 */

export interface KeyCapProps extends Omit<ComponentPropsWithRef<'kbd'>, 'onClick'> {}

export function KeyCap({ className, children, ...rest }: KeyCapProps): ReactElement {
  return (
    <kbd className={cn('sh-ui-keycap', className)} {...rest}>
      {children}
    </kbd>
  );
}
