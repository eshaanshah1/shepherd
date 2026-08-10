import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { IconButton, Field } from '@shepherd/ui';
import { IconChevronDown, IconChevronUp, IconX } from '@tabler/icons-react';
import type { PaneID } from '@shepherd/sdk';
import type { TerminalSearch } from './pane-sessions.ts';

/**
 * ⌘F over the grid.
 *
 * It drives ONE pane — the focused one — because a find that searched every
 * terminal would answer with a count spread across screens you cannot see, and
 * the next/previous buttons would have to mean "next pane" as well as "next
 * match". The pane it is bound to is the app's `focusedPaneId`, so clicking
 * another terminal retargets it rather than leaving it pointing at a pane that
 * has stopped being the one you are reading.
 *
 * **The bar keeps DOM focus while it is open**, which is the whole reason it can
 * exist over a terminal at all: xterm claims the keyboard, so a find bar that
 * let focus fall back to the grid would type its own query into the pty. Every
 * key it handles is therefore handled on the input, not on the window — the one
 * exception being ⌘F itself, which has to be reachable while the terminal has
 * focus and so is bound in `app.tsx` the way ⌘K is.
 *
 * The count is authoritative and comes from the addon (`onResults`), never from
 * the return of `findNext` — which says only "there was a match", and a bar that
 * counted its own calls would drift the moment output arrived mid-search.
 */

export interface FindBarProps {
  /**
   * The focused pane's search, or null when it has no terminal (a pane in a root
   * nobody is looking at holds none). Null draws the bar disabled rather than
   * hiding it — ⌘F did something, and a bar that vanishes says it did not.
   */
  readonly search: TerminalSearch | null;
  /** The pane being searched. Presentation only — it is what the bar sits over. */
  readonly paneId: PaneID | null;
  readonly onClose: () => void;
}

export function FindBar({ search, paneId, onClose }: FindBarProps): ReactNode {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState({ resultIndex: -1, resultCount: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const anchor = usePaneAnchor(paneId);

  // Open with the caret already in the field and any previous query selected, so
  // ⌘F-and-type replaces rather than appends. Runs once per mount: the bar is
  // unmounted when it closes, so a mount IS an open.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (search === null) return;
    const subscription = search.onResults(setResults);
    return () => subscription.dispose();
  }, [search]);

  /*
   * Re-run on every keystroke AND whenever the pane changes, so the highlights
   * belong to the terminal the bar is currently pointing at.
   *
   * The cleanup clears the search it just ran — which is what stops a retarget
   * from leaving the previous pane permanently highlighted, and what makes
   * closing the bar drop the decorations without a second code path for it.
   */
  useEffect(() => {
    if (search === null) return;
    if (term === '') {
      search.clear();
      setResults({ resultIndex: -1, resultCount: 0 });
      return;
    }
    search.findNext(term, true);
    return () => search.clear();
  }, [search, term]);

  const step = (direction: 'next' | 'previous'): void => {
    if (search === null || term === '') return;
    if (direction === 'next') search.findNext(term);
    else search.findPrevious(term);
  };

  // `-1` is the addon's "too many matches to index", not "none" — reporting it
  // as 0 of N would be a lie about a search that is working.
  const count =
    results.resultCount === 0
      ? term === ''
        ? ''
        : 'no matches'
      : results.resultIndex < 0
        ? `${results.resultCount}`
        : `${results.resultIndex + 1}/${results.resultCount}`;

  return (
    <div className="sh-find" role="search" data-testid="find-bar" style={anchor}>
      <Field
        ref={inputRef}
        size="sm"
        className="sh-find-input"
        placeholder="Find"
        aria-label="Find in terminal"
        data-testid="find-input"
        value={term}
        disabled={search === null}
        onChange={(event) => setTerm(event.target.value)}
        onKeyDown={(event) => {
          // Handled here rather than on the window: this input has focus for as
          // long as the bar is open, and a window listener would keep answering
          // Esc and Enter for the terminal after it closed.
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            step(event.shiftKey ? 'previous' : 'next');
          }
        }}
      />
      <span className="sh-find-count" data-testid="find-count">
        {count}
      </span>
      <IconButton
        icon={IconChevronUp}
        size="sm"
        label="Previous match"
        title="Previous match (⇧⏎)"
        disabled={search === null || results.resultCount === 0}
        onClick={() => step('previous')}
      />
      <IconButton
        icon={IconChevronDown}
        size="sm"
        label="Next match"
        title="Next match (⏎)"
        disabled={search === null || results.resultCount === 0}
        onClick={() => step('next')}
      />
      <IconButton icon={IconX} size="sm" label="Close find" title="Close (esc)" onClick={onClose} />
    </div>
  );
}

/**
 * Where the bar sits: the top-right corner OF THE PANE IT SEARCHES, in the
 * stage's coordinates.
 *
 * Parked at the stage's own corner it would, on a split, hang over one pane
 * while highlighting matches in another — the count and the highlights would be
 * about a terminal the bar is not on. With one pane the two positions are the
 * same, which is why this is easy to miss.
 *
 * Measured from the DOM rather than derived from the layout: the pane frames
 * live in main (`layout.setViewport` pushes a rect the other way) and the only
 * thing here that knows where a leaf ended up after a divider drag is the box it
 * was drawn into. `data-pane-id` is already the published hook for that — the
 * terminal host and the smokes both address panes by it.
 *
 * Null while nothing can be measured (no pane, or before layout), and the
 * stylesheet's own corner is then the fallback — the bar always has a position.
 */
function usePaneAnchor(paneId: PaneID | null): CSSProperties | undefined {
  const [anchor, setAnchor] = useState<CSSProperties | undefined>(undefined);

  useLayoutEffect(() => {
    if (paneId === null) {
      setAnchor(undefined);
      return;
    }
    const measure = (): void => {
      /*
       * `[data-focused]` picks the LAYOUT LEAF and not the terminal pane nested
       * inside it — both carry the class and the id (see the one shared rule in
       * `styles.css`), and only the leaf's box is the pane's whole box.
       */
      const pane = document.querySelector(
        `.sh-pane[data-focused][data-pane-id="${CSS.escape(paneId)}"]`,
      );
      const stage = pane?.closest('.sh-stage');
      if (pane === null || stage === null || stage === undefined) {
        setAnchor(undefined);
        return;
      }
      const box = pane.getBoundingClientRect();
      const within = stage.getBoundingClientRect();
      // The inset stays the stylesheet's — measured offsets place the CORNER,
      // and the gap off it is a spacing decision that belongs to the tokens.
      setAnchor({
        top: `calc(${box.top - within.top}px + var(--sh-space-md))`,
        right: `calc(${within.right - box.right}px + var(--sh-space-md))`,
      });
    };
    measure();
    // Guarded because jsdom has none — the same guard `terminal-pane.tsx` and
    // the viewport effect in `app.tsx` carry, and for the same reason: a test
    // about this component must not need a polyfill to run.
    if (typeof ResizeObserver === 'undefined') return;
    // The STAGE, not the pane: a divider drag resizes siblings, and a window
    // resize reflows all of them. One observer on the container catches both.
    const observer = new ResizeObserver(measure);
    const stage = document.querySelector('.sh-stage');
    if (stage !== null) observer.observe(stage);
    return () => observer.disconnect();
  }, [paneId]);

  return anchor;
}
