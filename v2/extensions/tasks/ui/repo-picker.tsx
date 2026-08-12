import { useEffect, useRef } from 'react';
import { Icon, Row, namedGlyph } from '@shepherd/ui';
import { rowText, type DisplaySegment } from './mention.ts';

/**
 * The repo picker — the bottom of the well, not a layer over it.
 *
 * Presentation and nothing else: it holds no query, no active index and no
 * knowledge of how a `#` is found. The composer owns all of that, because the
 * query lives in the editor's text — the list is a projection of it, and a
 * component that kept its own copy would be the second source of truth ADR 0035
 * is about.
 *
 * **`aria-activedescendant`, not roving `tabIndex`** — the `CommandPalette`
 * pattern, for the same reason it gives: focus stays in the editor the whole
 * time, because you are typing. Moving real focus to a row is what makes a picker
 * lose the text it is filtering on the first arrow press.
 *
 * **It is FUSED, and it used to be a portalled popover.** The design draws it as
 * part of the well — "the picker is part of the well, not a popover over it" —
 * one hairline under the control row, a step darker than the card, sharing the
 * card's own bottom corners. It grows the card downward rather than floating
 * anywhere, so there is no caret to anchor to, no viewport arithmetic, no flip
 * when the space below runs out, and no shadow: every one of those existed to
 * make a free-floating layer behave, and a panel that is structurally part of the
 * card needs none of them.
 *
 * What that deleted, and why it is not a loss: `placePicker` and its clamp/flip
 * rules, the caret rect measured per keystroke, `PICKER_WIDTH`/`PICKER_HEIGHT`
 * (a *constant* upper bound the old code needed because it had to decide where
 * the panel went before the panel existed), and the portal itself — which was
 * there only because `.sh-ui-modal`'s `overflow: auto` and `translateX(-50%)`
 * clip and contain a fixed child. Nothing in the card has to escape the card any
 * more.
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

  return (
    <div className="sh-composer-picker" data-testid="composer-picker">
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
                    {/*
                      A FOLDER, filled or outline — the same full-versus-empty
                      language the filled dot and hollow ring this replaced were
                      speaking, in a mark that reads without being taught.

                      `Icon` and `namedGlyph`, NOT a hand-rolled path. The
                      primitive owns the one stroke weight and the three sizes,
                      and `sm` is 13px, whose own comment in `icon.tsx` reads "a
                      folder glyph in a pill" — this is the case it was written
                      for. An extension cannot import Tabler directly (the
                      boundaries forbid it, so nobody can ship a glyph at a fourth
                      size and a second weight), which is exactly what the
                      `NAMED_GLYPHS` allow-list is for: it grew by the two lines
                      this needed.
                    */}
                    <Icon icon={namedGlyph(row.isRepo ? 'folder-filled' : 'folder')} size="sm" />
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
    </div>
  );
}
