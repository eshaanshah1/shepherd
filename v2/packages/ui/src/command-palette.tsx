import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { Composer } from './composer.tsx';
import { Field } from './field.tsx';
import { KeyCap } from './keycap.tsx';
import { Modal } from './modal.tsx';
import { Row } from './row.tsx';
import { fuzzyFilter } from '@shepherd/sdk';
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
}

export function CommandPalette({
  open,
  onOpenChange,
  commands,
  onRun,
  placeholder = 'Run a command…',
  emptyLabel = 'No matching command',
  className,
}: CommandPaletteProps): ReactElement {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);

  const matches = useMemo(
    () => fuzzyFilter(query, commands, (command) => command.title),
    [query, commands],
  );

  /*
   * Reopening starts clean. A palette that remembers the last query is a palette
   * that opens showing four results out of two hundred, and the reason is
   * invisible until you notice the text you did not type.
   */
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
  }, [open]);

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
              <Row
                key={command.id}
                id={`${listId}-${command.id}`}
                role="option"
                aria-selected={position === index}
                data-active={position === index ? 'true' : undefined}
                data-command-id={command.id}
                data-testid="palette-item"
                selected={position === index}
                className="sh-ui-palette__item"
                meta={command.shortcut === undefined ? undefined : <KeyCap>{command.shortcut}</KeyCap>}
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
              </Row>
            ))
          )}
        </div>
      </Composer>
    </Modal>
  );
}
