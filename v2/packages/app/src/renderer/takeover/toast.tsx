import type { ReactElement } from 'react';
import { StateMark } from '@shepherd/ui';
import type { TriageEntry } from './triage.ts';

/**
 * The interrupt, and it is deliberately small.
 *
 * It says three things and offers one gesture: what, why, and how to get there.
 * It is not a copy of the question card — a card is for ANSWERING, which needs
 * the sentence and both verbs in front of you, and this is for DECIDING WHETHER
 * TO LOOK, which needs a name and a reason. Putting the answer buttons here
 * would make the toast the primary surface for a thing that was designed to
 * interrupt as little as possible.
 *
 * `esc` takes the card away and does NOT dequeue the task: it is still in
 * `Needs you`, and the line says so out loud rather than leaving you to trust
 * it. That sentence is the whole reason an interrupt is tolerable here.
 */

export interface ToastProps {
  readonly entry: TriageEntry;
  readonly onGo: () => void;
  readonly onDismiss: () => void;
  /**
   * Put it off from here, without going. Absent when the row publishes no way
   * to be deferred — and then the key is not printed either, because a hint for
   * a key that does nothing is worse than no hint.
   */
  readonly onLater?: (() => void) | undefined;
}

export function Toast({ entry, onGo, onDismiss, onLater }: ToastProps): ReactElement {
  const why = entry.facts.question?.text ?? entry.facts.summary ?? entry.description ?? 'Needs you';
  return (
    <div
      className="sh-take__toast"
      data-testid="takeover-toast"
      data-entry={entry.id}
      role="alertdialog"
      aria-label={entry.label}
    >
      <button type="button" className="sh-take__toastgo" onClick={onGo} data-testid="toast-go">
        <span className="sh-take__toasttop">
          <StateMark state={entry.mark} />
          {entry.label}
        </span>
        <span className="sh-take__why-line">{why}</span>
      </button>
      <div className="sh-take__keys">
        <b>⏎</b> go &nbsp;{' '}
        {onLater === undefined ? null : (
          <>
            <button type="button" className="sh-take__dismiss" onClick={onLater} data-testid="toast-later">
              <b>S</b> later
            </button>
            &nbsp;{' '}
          </>
        )}
        <button type="button" className="sh-take__dismiss" onClick={onDismiss} data-testid="toast-dismiss">
          <b>esc</b> not now — stays on Home
        </button>
      </div>
    </div>
  );
}
