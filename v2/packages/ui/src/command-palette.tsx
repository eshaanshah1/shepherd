import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { IconSearch } from '@tabler/icons-react';
import { Composer } from './composer.tsx';
import { Icon } from './icon.tsx';
import { namedGlyph } from './glyphs.ts';
import { StateMark, type MarkState } from './state-mark.tsx';
import { Field } from './field.tsx';
import { KeyCap } from './keycap.tsx';
import { Modal } from './modal.tsx';
import { Row } from './row.tsx';
import { fuzzyFilter, type DisplaySegment } from '@shepherd/sdk';
import { cn } from './cn.ts';

/**
 * ⌘K — the command palette.
 *
 * **Built from the primitives that already exist, and that is the finding rather
 * than a shortcut taken.** `metrics.ts` writes the soft radius as "writing
 * surfaces ONLY (the composer, the palette)" and `composer.tsx` says "the ⌘T task
 * composer is the first instance; a command palette is the second, and that is
 * the test a primitive has to pass". Both of those were written before this
 * component existed. A palette that brought its own dialog and its own surface
 * would have made two statements in the shipped design system false, and the
 * second instance the Composer needed to justify itself would never have arrived.
 *
 * So: `Modal` is the dialog, `Composer` is the surface, `Field variant="bare"` is
 * the input (it needs no prop to lose its border — the Composer's scoped role
 * re-declaration does that, which is the token tier's whole mechanism working),
 * `Row` is a result and `KeyCap` is its shortcut. The new code here is a filter
 * and an active index.
 *
 * **`cmdk` was evaluated and declined**, and the decision is worth recording
 * because it is the one the reference apps went the other way on. In its favour:
 * T3 Code and Orca both use it, and every one of its dependencies is already
 * resolved in this tree (it wants `@radix-ui/react-dialog`, `-primitive`, `-id`
 * and `-compose-refs`, all of which Modal and Tooltip already brought), so it
 * would have cost one package rather than five. Against it, and decisive:
 *
 *   - It ships its own `Command.Dialog`, which would be a SECOND dialog
 *     implementation beside `Modal` — the thing this package exists to stop.
 *     Using only its non-dialog `Command` avoids that but then most of what was
 *     bought is unused.
 *   - Its styling surface is `[cmdk-item]` attribute selectors: a second naming
 *     convention beside `sh-ui-*`, in the one package a third party reads to
 *     learn ours.
 *   - Its ranking is `command-score`, which nobody here can tune and nobody can
 *     test without mounting a component. `@shepherd/sdk`'s `fuzzyFilter` is a
 *     pure function with the ranking argued in comments, and the four bonuses in
 *     it are each a pair of results that would otherwise tie.
 *
 * What Radix genuinely buys — the focus trap, Esc, click-out, the portal, the
 * scrim, restoring focus to whatever opened the palette — is bought here too. It
 * arrives through `Modal`, which already took that dependency for a reason that
 * has not changed.
 *
 * **The list is `aria-activedescendant`, not roving `tabindex`.** Focus stays in
 * the input the whole time — you are typing — and the active row is named rather
 * than focused. Moving real focus to a row is what makes a palette lose its query
 * on the first arrow press, which is the defect every hand-rolled one has.
 */

export interface PaletteCommand {
  readonly id: string;
  /** What the user reads and what the filter matches against. */
  readonly title: string;
  /** Display only, in a `KeyCap`. The palette binds nothing. */
  readonly shortcut?: string;
  /**
   * Which heading this command sits under — `Layout`, `Jump to`.
   *
   * Optional, and an ungrouped command is drawn with no heading at all rather
   * than under an invented "Other". A palette with two commands does not need
   * headings, and one that grew them automatically would put a label above a
   * list of one.
   */
  readonly group?: string;
  /**
   * A glyph NAME from the allow-list, drawn in the row's leading slot.
   *
   * A command with neither `icon` nor `mark` draws an empty slot rather than
   * nothing — the slot is fixed, so a list where only some rows have a glyph
   * still reads as one column of labels.
   */
  readonly icon?: string;
  /**
   * A STATE, drawn in the leading slot instead of an icon.
   *
   * §1's `Jump to` rows carry marks rather than icons, and that is the whole
   * distinction between the two groups: a `Layout` row is a verb and takes a
   * picture of itself, while a `Jump to` row is a THING that is in some state,
   * and its mark is the same one the rail draws for it.
   */
  readonly mark?: MarkState;
  /**
   * A second line under the title — the transcript line that matched, cut into
   * runs so the hit can be painted.
   *
   * **Pre-segmented by whoever searched**, deliberately: this component has no
   * matcher and must not acquire one. A palette that re-derived the highlight
   * would be a second opinion about which characters were the match, which is
   * exactly the drift `segmentsOfRange` living in the sdk exists to prevent.
   */
  readonly detail?: readonly DisplaySegment[];
  /** Right-aligned, beside `shortcut`'s slot — a time. Display only. */
  readonly meta?: string;
  /** Right-aligned under `meta` — `4 more`. Display only. */
  readonly note?: string;
}

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly commands: readonly PaletteCommand[];
  /**
   * Run the chosen command. The palette closes itself immediately after — a
   * palette still on screen over the thing it just did is a palette you have to
   * dismiss twice.
   */
  readonly onRun: (id: string) => void;
  readonly placeholder?: string;
  /** Shown when the query matches nothing. */
  readonly emptyLabel?: string;
  readonly className?: string;
  /**
   * The query, when the CALLER owns it — which it does whenever the results come
   * from somewhere else and have to be re-fetched as you type.
   *
   * Uncontrolled by default, so the ⌘K palette is untouched by this.
   */
  readonly query?: string;
  readonly onQueryChange?: (query: string) => void;
  /**
   * `commands` is already the result set — do not filter it here.
   *
   * A transcript search runs in an extension, over text this component does not
   * hold, so the rows arriving ARE the answer. Running `fuzzyFilter` over them
   * again would drop every row whose match is in the body rather than the title,
   * which is most of them.
   */
  readonly filtered?: boolean;
}

export function CommandPalette({
  open,
  onOpenChange,
  commands,
  onRun,
  placeholder = 'Run a command…',
  emptyLabel = 'No matching command',
  className,
  query: controlledQuery,
  onQueryChange,
  filtered = false,
}: CommandPaletteProps): ReactElement {
  const [ownQuery, setOwnQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);

  const controlled = controlledQuery !== undefined;
  const query = controlledQuery ?? ownQuery;
  const setQuery = (next: string): void => {
    if (!controlled) setOwnQuery(next);
    onQueryChange?.(next);
  };

  const matches = useMemo(
    () => (filtered ? commands : fuzzyFilter(query, commands, (command) => command.title)),
    [query, commands, filtered],
  );

  /*
   * Reopening starts clean. A palette that remembers the last query is a palette
   * that opens showing four results out of two hundred, and the reason is
   * invisible until you notice the text you did not type.
   *
   * **A CONTROLLED query is left alone**, because then the caller decides what it
   * opens with — session search opens on whatever the rail's field already holds,
   * which is the whole reason the count row carries the query across.
   */
  useEffect(() => {
    if (!open) return;
    if (!controlled) setOwnQuery('');
    setActive(0);
  }, [open, controlled]);

  /*
   * The active index is CLAMPED against the current match list rather than reset
   * on every keystroke. Reset would send you back to the top each time you refine
   * a query you were already navigating; unclamped, deleting a character can
   * leave the index past the end and Enter then runs nothing at all.
   */
  const index = matches.length === 0 ? 0 : Math.min(active, matches.length - 1);
  const current = matches[index];

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    // jsdom implements no layout and therefore no `scrollIntoView`. Guarded
    // rather than stubbed in the test, because a component that throws in a host
    // without layout is a component an extension cannot render in one either.
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
  }, [index, matches]);

  const run = (id: string): void => {
    onRun(id);
    onOpenChange(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    /*
     * Esc is deliberately absent: `Modal` (Radix Dialog) already dismisses on it,
     * and handling it here too would be a second opinion about what Esc means —
     * the failure being that a palette with an open native autocomplete swallows
     * the first press and closes on the second.
     */
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      // Wraps. A list you can arrow off the end of is a list where the last item
      // is harder to reach than the first, for no reason.
      setActive(matches.length === 0 ? 0 : (index + 1) % matches.length);
      return;
    }
    if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      setActive(matches.length === 0 ? 0 : (index - 1 + matches.length) % matches.length);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActive(Math.max(matches.length - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      // Nothing highlighted means nothing matched. Enter does nothing rather than
      // running whatever happens to be first in the unfiltered list.
      if (current !== undefined) run(current.id);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      size="lg"
      className={cn('sh-ui-palette-modal', className)}
    >
      <Composer className="sh-ui-palette">
        {/*
          A row rather than a `leading` prop on `Field`: the magnifier is this
          palette's furniture, not something every field in the app wants a slot
          for — and a prop nobody else uses is API paid for once and carried
          forever.
        */}
        <div className="sh-ui-palette__query">
        <Icon icon={IconSearch} size="md" />
        <Field
          variant="bare"
          className="sh-ui-palette__input"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={current === undefined ? undefined : `${listId}-${current.id}`}
          data-testid="palette-input"
        />
        </div>
        <div
          className="sh-ui-palette__list"
          id={listId}
          role="listbox"
          aria-label="Commands"
          ref={listRef}
        >
          {matches.length === 0 ? (
            <p className="sh-ui-palette__empty">{emptyLabel}</p>
          ) : (
            matches.map((command, position) => (
              <Fragment key={command.id}>
                {/*
                  A heading whenever the group CHANGES, which is what keeps the
                  headings a property of the filtered list rather than of the
                  original one: a query that matches nothing under `Layout`
                  simply never emits that heading, instead of leaving an empty
                  section behind.

                  Deliberately NOT a separate pass that groups then flattens.
                  The keyboard index is a position in `matches`, and any regroup
                  that reorders rows makes ArrowDown skip — the headings are
                  drawn between rows that were already in order.
                */}
                {command.group === undefined || command.group === matches[position - 1]?.group ? null : (
                  <p className="sh-ui-palette__group" aria-hidden="true">
                    {command.group}
                  </p>
                )}
              <Row
                id={`${listId}-${command.id}`}
                role="option"
                aria-selected={position === index}
                data-active={position === index ? 'true' : undefined}
                data-command-id={command.id}
                data-testid="palette-item"
                selected={position === index}
                leading={
                  <span className="sh-ui-palette__glyph">
                    {command.mark === undefined ? (
                      command.icon === undefined ? null : <Icon icon={namedGlyph(command.icon)} size="sm" />
                    ) : (
                      <StateMark state={command.mark} />
                    )}
                  </span>
                }
                /*
                 * `--plain` marks a row with nothing in its leading slot, and it
                 * is what the stylesheet keys the slot-collapsing rule off. That
                 * rule used to apply to EVERY row on the grounds that "in a
                 * palette no row will ever have a status" — which stopped being
                 * true when `mark` was added for §1's `Jump to` rows, and it has
                 * been hiding marks this component passes ever since.
                 */
                className={cn(
                  'sh-ui-palette__item',
                  command.mark === undefined &&
                    command.icon === undefined &&
                    command.detail === undefined
                    ? 'sh-ui-palette__item--plain'
                    : undefined,
                )}
                meta={
                  command.shortcut !== undefined ? (
                    <KeyCap>{command.shortcut}</KeyCap>
                  ) : command.meta === undefined && command.note === undefined ? undefined : (
                    <span className="sh-ui-palette__aside">
                      {command.meta === undefined ? null : (
                        <span className="sh-ui-palette__when">{command.meta}</span>
                      )}
                      {command.note === undefined ? null : (
                        <span className="sh-ui-palette__note">{command.note}</span>
                      )}
                    </span>
                  )
                }
                /*
                 * `mousemove`, not `mouseenter`. With the pointer resting inside
                 * the list, `mouseenter` never fires again — so arrowing down
                 * moves the highlight, the pointer is now over a different row,
                 * and the next tiny mouse jitter yanks the selection back. Move
                 * is the event that means "the user is using the mouse now".
                 */
                onMouseMove={() => setActive(position)}
                onClick={() => run(command.id)}
              >
                {command.title}
                {/*
                  The matched line. Drawn INSIDE the row's label cell so it
                  inherits the ellipsis the label already has — a transcript line
                  is longer than any rail is wide, and a second cell would need
                  its own truncation rule to say the same thing twice.
                */}
                {command.detail === undefined ? null : (
                  <span className="sh-ui-palette__detail">
                    {command.detail.map((segment, at) => (
                      <span
                        // The segments are a fixed cut of one string and never
                        // reorder, so the position IS a stable identity.
                        key={at}
                        className={segment.matched ? 'sh-ui-palette__hit' : undefined}
                      >
                        {segment.text}
                      </span>
                    ))}
                  </span>
                )}
              </Row>
              </Fragment>
            ))
          )}
        </div>
      </Composer>
    </Modal>
  );
}
