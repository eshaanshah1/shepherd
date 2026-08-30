import { useState, type ReactElement } from 'react';
import type { RowAnswer, RowLater } from './row-facts.ts';

/**
 * "Not now" — and the three ways to say when.
 *
 * A small menu rather than a single button, because the useful part of the verb
 * is the WHEN. A snooze that always meant the same delay would be a mute button,
 * and a mute button on the one screen that exists to tell you what needs you is
 * a way of breaking the promise rather than of keeping it.
 *
 * The options are the extension's — labels and verbs both — so this component
 * knows only that pressing one runs something. It says so out loud in its own
 * header: `comes back on Home — never lost`, which is the sentence that makes
 * the verb usable at all.
 */

export interface LaterMenuProps {
  readonly name: string;
  readonly later: RowLater;
  readonly onPick: (option: RowAnswer) => void;
  readonly onClose: () => void;
}

export function LaterMenu({ name, later, onPick, onClose }: LaterMenuProps): ReactElement {
  const [at, setAt] = useState(0);
  const selected = Math.min(at, Math.max(0, later.options.length - 1));

  return (
    <div
      className="sh-take__scrim"
      data-testid="takeover-later-menu"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="sh-take__kcard sh-take__snz"
        role="dialog"
        aria-modal="true"
        aria-label={`${later.label} — ${name}`}
        tabIndex={-1}
        ref={(node) => node?.focus()}
        onKeyDown={(event) => {
          const chosen = later.options.find((option) => option.key === event.key);
          if (chosen !== undefined) {
            event.preventDefault();
            onPick(chosen);
            return;
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setAt(Math.min(selected + 1, later.options.length - 1));
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setAt(Math.max(selected - 1, 0));
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            const option = later.options[selected];
            if (option !== undefined) onPick(option);
          }
        }}
      >
        <div className="sh-take__kq sh-take__snzhead">
          <span className="sh-take__cardname">{name}</span>
          {/*
            The promise, written where the decision is made. Everything else on
            this surface depends on it being believed.
          */}
          <span className="sh-take__why">comes back on Home — never lost</span>
        </div>
        <div className="sh-take__klist">
          {later.options.map((option, index) => (
            <button
              type="button"
              key={option.command + String(index)}
              className="sh-take__krow"
              data-testid="later-option"
              data-on={index === selected ? 'true' : undefined}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(option);
              }}
            >
              <span className="sh-take__where sh-take__ord">{option.key ?? ''}</span>
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
