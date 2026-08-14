import type { ComponentType, ReactElement, ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { IconProps as TablerIconProps } from '@tabler/icons-react';
import { Icon } from './icon.tsx';
import { KeyCap } from './keycap.tsx';
import { StateMark, type MarkState } from './state-mark.tsx';
import { cn } from './cn.ts';

/**
 * The right-click menu — Radix's, restyled. **The thirteenth primitive, and it
 * arrived with its caller.**
 *
 * Spec §3 lists `Menu` under "deliberately not in v1" with the reason attached:
 * each of those arrives with its first real consumer, because a primitive with
 * no caller is a design nobody has tested. The caller is a right-click on a
 * sidebar task row — Reveal / Archive / Delete — and the shape of this component
 * is a consequence of what that caller actually has, which is the paragraph
 * below.
 *
 * **`@radix-ui/react-context-menu`, not `react-dropdown-menu`.** They are the
 * same component with a different trigger, over the same `Menu` internals. The
 * consumer that bought this is a right-click; a `⋯` button opening the same list
 * has no caller yet, and taking both would be taking one on spec. The day one
 * appears it is a second Radix package and a `trigger` prop here, not a rewrite —
 * which is the trade worth stating, because the alternative reading is that this
 * component is context-only forever.
 *
 * What the dependency buys, and it is the same test Modal and Tooltip had to
 * pass — the behaviour, never the box: the typeahead, roving focus and
 * arrow/Home/End keyboard model; ONE `data-highlighted` item whether the pointer
 * or the keyboard put it there (a hand-rolled menu has a hover state and a
 * selection state and they disagree the moment you use both); dismissal on Esc,
 * on click-out and on scroll; collision-aware placement from the click point, so
 * a menu opened on the last row of the sidebar does not open below the window;
 * focus returning to the trigger on close; and `role="menu"`/`menuitem` wiring
 * with the modal-while-open semantics that keep the rest of the page inert.
 *
 * **The items are DATA, not children.** Radix's own API is compositional and
 * this one is deliberately not, because of who the caller is: the actions on a
 * task row are declared by an extension and cross a structured-clone port to get
 * here (`TreeItem.actions`). They are already an array by the time anything can
 * render them, so a compositional API would make every call site map data to
 * elements — and the one call site that matters is a generic dock that knows
 * nothing about tasks. An array in, an id out.
 *
 * **`onSelect` takes an id and returns nothing.** The menu does not know what an
 * action does and must not: for the sidebar consumer the id is a COMMAND id
 * belonging to the contributing extension, and running it is the dock's job
 * under M3 D14's attribution rule (a row's verb runs as the extension, never as
 * the user). A component that took a callback per item would invite a call site
 * to close over a bridge.
 */

/** A Tabler icon component, as `Icon` takes it — never a name, never an `<svg>`. */
type Glyph = ComponentType<TablerIconProps>;

export interface MenuItemSpec {
  /** Handed back to `onSelect`. For a contributed menu this is a command id. */
  readonly id: string;
  readonly label: string;
  readonly icon?: Glyph;
  /**
   * The destructive treatment: ember text, and an ember FILL when highlighted.
   *
   * Not a `variant` union, because there are exactly two states an item can be in
   * and the second one is "this deletes something". A union invites a third that
   * is a colour rather than a meaning.
   */
  readonly danger?: boolean;
  /**
   * The shortcut, DISPLAYED. Rendered in a `KeyCap`, which is display-only by
   * construction — the menu does not bind it and never has: a key equivalent is
   * the application's to own, and a menu that bound its own would bind it only
   * while open, which is the one time you do not need it.
   */
  readonly shortcut?: string;
  readonly disabled?: boolean;
  /**
   * A STATE, in the leading slot, instead of a glyph.
   *
   * The caller is a list of live agents: each row's state is what decides
   * whether handing to it sends now or queues behind its turn, so the mark is
   * not decoration — it is half of what the row says. It shares the icon's box,
   * because they are the same 12px slot and an item never has both.
   */
  readonly mark?: MarkState;
  /**
   * A short fact at the trailing edge — `sends now`, `queues`, `opens a tab`.
   *
   * Not `shortcut`, which renders a `KeyCap` and means "press this". This means
   * "here is what choosing me does", which is the opposite direction: one is an
   * instruction to the user and the other is a promise from the app. An item may
   * carry both; the shortcut sits last, where a key always is.
   */
  readonly meta?: string;
}

/** A rule between groups. An object rather than a `null` so the array is typed. */
export interface MenuSeparatorSpec {
  readonly separator: true;
}

export type MenuEntry = MenuItemSpec | MenuSeparatorSpec;

export const isMenuSeparator = (entry: MenuEntry): entry is MenuSeparatorSpec =>
  (entry as MenuSeparatorSpec).separator === true;

export interface MenuProps {
  readonly items: readonly MenuEntry[];
  /** Called with the chosen item's `id`. Never called for a disabled item. */
  readonly onSelect: (id: string) => void;
  /** The trigger. See `trigger` for what opening it means. */
  readonly children: ReactNode;
  readonly className?: string;
  /** Controlled open, for a test or for a menu something else has to close. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /**
   * How it opens — `context` (right-click, the default) or `click`.
   *
   * The day this file predicted, arriving: "the two share Radix's `Menu`
   * internals, so the day a click-trigger appears it is a second package and a
   * `trigger` prop on the component already here — not a rewrite." The caller is
   * `Hand to agent`, which opens the task's live agents under the button that
   * says it.
   *
   * A `click` menu is ANCHORED to its trigger and a `context` menu opens at the
   * pointer, which is the only behavioural difference and is Radix's to
   * implement. Everything else — the one highlight, the typeahead, Esc,
   * click-out, focus returning to the trigger — is identical, which is what
   * makes this a prop rather than a second component.
   */
  readonly trigger?: 'context' | 'click';
}

export function Menu({
  items,
  onSelect,
  children,
  className,
  open,
  onOpenChange,
  trigger = 'context',
}: MenuProps): ReactElement {
  /*
   * One set of parts, chosen once.
   *
   * Radix's two packages export the same names over the same internals, so the
   * body below is written against `Parts` and never against either package. The
   * alternative — the whole tree twice under a conditional — is two renderings
   * of one design, and the second one drifts.
   */
  const Parts = trigger === 'click' ? DROPDOWN_PARTS : CONTEXT_PARTS;

  return (
    <Parts.Root open={open} onOpenChange={onOpenChange}>
      {/*
       * `asChild`: the trigger IS the row, not a wrapper around it. A wrapper
       * element between the list and its rows would be a box with no styles in
       * the middle of a flex column — which is how a list grows a second layout
       * nobody declared. It also means the row keeps its own `data-testid`, which
       * the smokes select on.
       */}
      <Parts.Trigger asChild>{children}</Parts.Trigger>
      <Parts.Portal>
        <Parts.Content className={cn('sh-ui-menu', className)} collisionPadding={8} {...Parts.contentProps}>
          {items.map((entry, index) =>
            isMenuSeparator(entry) ? (
              // Keyed by position, which is the only identity a separator has:
              // it is not a thing in the list, it is the gap between two of them.
              <Parts.Separator key={`sep-${index}`} className="sh-ui-menu__separator" />
            ) : (
              <Parts.Item
                key={entry.id}
                className={cn('sh-ui-menu__item', entry.danger && 'sh-ui-menu__item--danger')}
                data-danger={entry.danger ? 'true' : undefined}
                disabled={entry.disabled}
                onSelect={() => onSelect(entry.id)}
              >
                {/*
                 * Rendered unconditionally, and it is `Row`'s argument exactly:
                 * the box holds the label's x position for every item in the
                 * menu, so a list where two of five verbs have a glyph does not
                 * start three of its labels somewhere else.
                 *
                 * A `mark` and an `icon` share it: one item never has both, and
                 * two boxes would put the label at two different x positions in
                 * one list — which is the thing the box exists to prevent.
                 */}
                <span className="sh-ui-menu__icon">
                  {entry.mark !== undefined ? (
                    <StateMark state={entry.mark} />
                  ) : entry.icon ? (
                    <Icon icon={entry.icon} size="sm" />
                  ) : null}
                </span>
                <span className="sh-ui-menu__label">{entry.label}</span>
                {entry.meta === undefined ? null : <span className="sh-ui-menu__meta">{entry.meta}</span>}
                {entry.shortcut === undefined ? null : (
                  <KeyCap className="sh-ui-menu__shortcut">{entry.shortcut}</KeyCap>
                )}
              </Parts.Item>
            ),
          )}
        </Parts.Content>
      </Parts.Portal>
    </Parts.Root>
  );
}

/**
 * The two Radix packages, behind one shape.
 *
 * `contentProps` is the only place they genuinely differ: a dropdown is anchored
 * to its trigger and so takes a side and an offset, while a context menu opens at
 * the pointer and has neither. Six pixels because that is one hairline plus the
 * gap the menu's own padding already implies — close enough to read as belonging
 * to the button, far enough not to touch it.
 */
const CONTEXT_PARTS = {
  Root: ContextMenu.Root,
  Trigger: ContextMenu.Trigger,
  Portal: ContextMenu.Portal,
  Content: ContextMenu.Content,
  Separator: ContextMenu.Separator,
  Item: ContextMenu.Item,
  contentProps: {},
} as const;

const DROPDOWN_PARTS = {
  Root: DropdownMenu.Root,
  Trigger: DropdownMenu.Trigger,
  Portal: DropdownMenu.Portal,
  Content: DropdownMenu.Content,
  Separator: DropdownMenu.Separator,
  Item: DropdownMenu.Item,
  contentProps: { side: 'bottom', align: 'end', sideOffset: 6 },
} as const;
