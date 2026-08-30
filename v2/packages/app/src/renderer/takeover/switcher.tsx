import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { StateMark, markSlot } from '@shepherd/ui';
import { filterPlaces, places, type PlaceItem } from './places.ts';
import type { TriageEntry } from './triage.ts';

/**
 * ⌘K — the pull half of the router.
 *
 * Home is the push: it decides what you see. This is the other direction, and
 * the two have to agree — the rows here carry the same marks and the same region
 * words Home draws, so a task found by typing three letters says exactly what it
 * said on the screen you left.
 *
 * It is not `CommandPalette`. That primitive lists VERBS out of the kernel's
 * registry and its rows are things to run; these are PLACES and its rows are
 * things to be at. Sharing one dialog would mean either a palette that lists
 * your tasks or a switcher that offers `layout.setRatio`, and both are worse
 * than two lists — the palette is still there, on ⌘⇧P.
 */

export interface SwitcherProps {
  readonly entries: readonly TriageEntry[];
  readonly onPick: (item: PlaceItem) => void;
  readonly onClose: () => void;
}

export function Switcher({ entries, onPick, onClose }: SwitcherProps): ReactElement {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const hits = useMemo(() => filterPlaces(places(entries), query), [entries, query]);
  /*
   * Clamped on the way OUT rather than corrected in an effect: a query that
   * shortens the list mid-keystroke would otherwise leave the cursor past the
   * end for one paint, and Enter in that frame opens nothing at all.
   */
  const selected = Math.min(at, Math.max(0, hits.length - 1));

  useEffect(() => {
    input.current?.focus();
  }, []);

  return (
    <div
      className="sh-take__scrim"
      data-testid="takeover-switcher"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="sh-take__kcard" role="dialog" aria-modal="true" aria-label="Jump anywhere">
        <div className="sh-take__kq">
          <input
            ref={input}
            className="sh-take__kin"
            placeholder="Jump anywhere"
            value={query}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              setAt(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setAt(Math.min(selected + 1, hits.length - 1));
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setAt(Math.max(selected - 1, 0));
                return;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                const hit = hits[selected];
                if (hit !== undefined) onPick(hit);
              }
            }}
          />
        </div>
        <div className="sh-take__klist">
          <div className="sh-take__klabel">Jump to</div>
          {hits.length === 0 ? (
            <div className="sh-take__krow" data-empty="true">
              Nothing matches
            </div>
          ) : (
            hits.map((hit, index) => (
              <button
                type="button"
                key={hit.id}
                className="sh-take__krow"
                data-testid="switcher-row"
                data-on={index === selected ? 'true' : undefined}
                // `mousedown`, not `click`: the input has focus and a click would
                // blur it first, which closes nothing but loses the caret for the
                // one frame before the pick lands.
                onMouseDown={(event) => {
                  event.preventDefault();
                  onPick(hit);
                }}
              >
                {hit.mark === undefined ? (
                  <span className={markSlot} aria-hidden="true" />
                ) : (
                  <StateMark state={hit.mark} />
                )}
                <span>{hit.name}</span>
                <span className="sh-take__where">{hit.where}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
