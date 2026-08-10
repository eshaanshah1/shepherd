import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Row } from '@shepherd/ui';
import { rowText, type DisplaySegment } from './mention.ts';

/**
 * The caret-anchored repo picker.
 *
 * Presentation and nothing else: it holds no query, no active index and no
 * knowledge of how a `#` is found. The composer owns all of that, because the
 * query lives in the editor's text — the popover is a projection of it, and a
 * component that kept its own copy would be the second source of truth ADR 0035
 * is about.
 *
 * **`aria-activedescendant`, not roving `tabIndex`** — the `CommandPalette`
 * pattern, for the same reason it gives: focus stays in the editor the whole
 * time, because you are typing. Moving real focus to a row is what makes a picker
 * lose the text it is filtering on the first arrow press.
 *
 * **It PORTALS to the body, and that is not a stylistic choice.** The composer is
 * mounted inside `Modal`, and `.sh-ui-modal` carries `overflow: auto` together
 * with `transform: translateX(-50%)`. The transform makes that element the
 * containing block for even a `position: fixed` descendant, and the overflow then
 * clips it — so an in-tree popover is cut off the moment the list is taller than
 * the card, which with four rows it always is. The design has it hanging past the
 * card's bottom edge, and a portal is the only way a child of a clipping,
 * transformed ancestor can do that. Its coordinates are therefore VIEWPORT
 * coordinates, measured by the caller.
 */

export interface PickerRow {
  readonly path: string;
  readonly name: string;
  readonly isRepo: boolean;
  /** The home-collapsed text the port sends. */
  readonly display: string;
  /** `display`, already cut into matched runs by the ranker. */
  readonly segments: readonly DisplaySegment[];
}

export interface RepoPickerProps {
  readonly rows: readonly PickerRow[];
  readonly query: string;
  readonly activeIndex: number;
  /** VIEWPORT coordinates, already clamped by the caller that measured the caret. */
  readonly x: number;
  readonly y: number;
  readonly listId: string;
  readonly onHover: (index: number) => void;
  readonly onPick: (row: PickerRow) => void;
}

/** One id scheme, so `aria-activedescendant` and the row it names cannot drift. */
export function rowId(listId: string, index: number): string {
  return `${listId}-row-${index}`;
}

function Runs({ segments }: { readonly segments: readonly DisplaySegment[] }): React.JSX.Element {
  return (
    <>
      {segments.map((run, at) => (
        <span
          // Index, because the runs ARE positional: two runs of the same text in
          // one path are two different places in it.
          key={at}
          className={run.matched ? 'sh-composer-picker-hit' : undefined}
        >
          {run.text}
        </span>
      ))}
    </>
  );
}

export function RepoPicker({
  rows,
  query,
  activeIndex,
  x,
  y,
  listId,
  onHover,
  onPick,
}: RepoPickerProps): React.JSX.Element {
  const list = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = list.current?.querySelector<HTMLElement>('[data-selected="true"]');
    // jsdom implements no layout and therefore no `scrollIntoView`. Guarded
    // rather than stubbed in the test, for the reason `CommandPalette` gives: a
    // component that throws in a host without layout is one an extension cannot
    // render in one either.
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, rows]);

  return createPortal(
    <div
      className="sh-composer-picker"
      data-testid="composer-picker"
      style={{ left: `${x}px`, top: `${y}px` }}
    >
      <div className="sh-composer-picker-head">
        {/* The live query, echoed. It is the one place the `#` is visible as the
            thing that opened this rather than as a character in a sentence. */}
        <span data-testid="composer-picker-query">#{query}</span>
        <span className="sh-composer-picker-hint" aria-hidden="true">
          ↑↓ ↵ esc
        </span>
      </div>
      <div className="sh-composer-picker-list" ref={list} role="listbox" id={listId}>
        {rows.length === 0 ? (
          <div className="sh-composer-picker-empty" data-testid="composer-picker-empty">
            no repo matches that
          </div>
        ) : (
          rows.map((row, at) => {
            const { name, parent } = rowText(row.display, row.segments);
            return (
              <Row
                key={row.path}
                id={rowId(listId, at)}
                role="option"
                aria-selected={at === activeIndex}
                selected={at === activeIndex}
                data-testid="composer-picker-row"
                data-path={row.path}
                title={row.display}
                leading={
                  /*
                   * NOT a `StatusDot`. Its five roles are the agent lifecycle and
                   * it always renders a status word as its accessible name, so a
                   * repo row would announce "Idle". This says the one thing the
                   * port actually knows about a candidate, and it replaces the
                   * `not a repo` text label the previous field spent a run of
                   * uppercase micro-type on.
                   */
                  <span
                    className="sh-composer-picker-mark"
                    data-repo={row.isRepo ? 'true' : 'false'}
                  >
                    <span className="sh-ui-sr-only">{row.isRepo ? 'repo' : 'not a repo'}</span>
                  </span>
                }
                meta={parent.length === 0 ? null : <Runs segments={parent} />}
                onMouseEnter={() => onHover(at)}
                /*
                 * `mousedown`, not `click`: the editor loses its selection on
                 * mousedown, and the insertion needs that selection to know where
                 * the `#` was. Preventing the default keeps the caret where it is.
                 */
                onMouseDown={(event) => {
                  event.preventDefault();
                  onPick(row);
                }}
              >
                <Runs segments={name} />
              </Row>
            );
          })
        )}
      </div>
    </div>,
    document.body,
  );
}

/** How far below the caret the panel sits, and its inset from the card's edges. */
export const CARET_GAP = 8;
export const EDGE = 14;
/** Enough of the list to be worth showing; below this it flips above the caret. */
export const MIN_ROOM = 180;

/**
 * Where the panel goes, in VIEWPORT coordinates.
 *
 * Pure, and separated from the component for the reason the rest of this feature
 * is: it is arithmetic with edge cases, and every one of them is a state somebody
 * has to be able to reproduce without a window. The rules, in order:
 *
 *   - it hangs from just under the `#` itself, so the panel is visibly about the
 *     thing being typed rather than about the card;
 *   - it is clamped to the CARD horizontally, not the viewport, because a popover
 *     that wanders off the side of the composer stops reading as part of it;
 *   - and it FLIPS above the caret when the space below is too small to show a
 *     useful amount of list. Clamping instead would slide the panel away from the
 *     caret it is anchored to, which is worse than moving it to the other side.
 */
export function placePicker(
  hash: { readonly left: number; readonly bottom: number; readonly top: number },
  card: { readonly left: number; readonly width: number },
  viewportHeight: number,
  panelHeight: number,
): { readonly x: number; readonly y: number } {
  const room = card.width - PICKER_WIDTH - EDGE;
  const x = card.left + Math.max(EDGE, Math.min(hash.left - card.left, Math.max(room, EDGE)));
  const below = viewportHeight - (hash.bottom + CARET_GAP);
  const y =
    below >= Math.min(panelHeight, MIN_ROOM)
      ? hash.bottom + CARET_GAP
      : Math.max(EDGE, hash.top - CARET_GAP - panelHeight);
  return { x, y };
}

/**
 * Exported for the composer's clamp — one width, declared once.
 *
 * A pixel literal rather than a token because it IS one: the no-hex rule is
 * about colour, and there is no width scale to read this off. It is here rather
 * than in the stylesheet because the clamp arithmetic needs the number, and the
 * stylesheet reads it back through a custom property.
 */
export const PICKER_WIDTH = 360;
