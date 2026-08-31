import { useState, type ReactElement } from 'react';
import type { RowAnswer, RowLater } from './row-facts.ts';

/**
 * "Not now" — and the ways to say when.
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
 *
 * **One option may ask for a value** (`RowAnswer.prompt`), and it is the reason
 * this component holds state at all. Presets are the whens worth one keypress;
 * every other when has to be typed, and rounding it to the nearest preset would
 * put the row somewhere the user did not ask for. The field does not parse what
 * it collects — it hands the text to the same verb the presets run, and draws
 * the refusal that comes back.
 */

export interface LaterMenuProps {
  readonly name: string;
  readonly later: RowLater;
  /**
   * Run one option, and say what went wrong.
   *
   * Resolving to a message keeps the menu OPEN on a refusal. A typed time that
   * could not be read has to be re-typed, and a surface that closed on it would
   * leave the row exactly where it was with nothing on screen saying why.
   */
  readonly onPick: (option: RowAnswer, text?: string) => Promise<string | undefined>;
  readonly onClose: () => void;
}

export function LaterMenu({ name, later, onPick, onClose }: LaterMenuProps): ReactElement {
  const [at, setAt] = useState(0);
  const [asking, setAsking] = useState<RowAnswer | null>(null);
  const [text, setText] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const selected = Math.min(at, Math.max(0, later.options.length - 1));

  /** Straight to the verb, or to the field first if the option wants one. */
  const choose = (option: RowAnswer): void => {
    if (option.prompt !== undefined) {
      setAsking(option);
      setFailed(null);
      return;
    }
    void onPick(option);
  };

  const submit = (): void => {
    if (asking === null || text.trim() === '') return;
    void onPick(asking, text).then((message) => setFailed(message ?? null));
  };

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
        ref={(node) => {
          // Only while the list has the focus. Once the field is up it claims it
          // instead, and re-focusing the card on every keystroke would take it
          // straight back out of the input being typed into.
          if (asking === null) node?.focus();
        }}
        onKeyDown={(event) => {
          // The list's keys are dead while the field is open — `4` is a digit in
          // a time, not the option that opened the thing you are typing into.
          if (asking !== null) {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setAsking(null);
            setText('');
            setFailed(null);
            return;
          }
          const chosen = later.options.find((option) => option.key === event.key);
          if (chosen !== undefined) {
            event.preventDefault();
            choose(chosen);
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
            if (option !== undefined) choose(option);
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
        {asking === null ? (
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
                  choose(option);
                }}
              >
                <span className="sh-take__where sh-take__ord">{option.key ?? ''}</span>
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="sh-take__klist">
            <input
              className="sh-take__snzfield"
              data-testid="later-field"
              autoFocus
              value={text}
              placeholder={asking.prompt?.placeholder ?? ''}
              aria-label={asking.label}
              aria-invalid={failed === null ? undefined : true}
              onChange={(event) => {
                setText(event.target.value);
                // The refusal was about the text that produced it; keeping it up
                // while that text changes points at the wrong thing.
                setFailed(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                submit();
              }}
            />
            {failed === null ? null : (
              <span className="sh-take__snzbad" data-testid="later-error" role="alert">
                {failed}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
