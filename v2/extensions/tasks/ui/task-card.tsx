import { useCallback, useEffect, useMemo, type ReactElement } from 'react';
import type { ExtensionRowProps } from '@shepherd/sdk';
import { Button, StateMark, SuiteMeter } from '@shepherd/ui';
import { readCardData, type CardAnswer, type CardData } from './card-data.ts';

/**
 * A task, as Shepherd UI draws it — the one element in the rail allowed to
 * change size.
 *
 * Everything else in the list is a fixed-height row or a fixed-shape card.
 * A task **waiting on you** opens into a card carrying the question and its two
 * answers inline, so answering costs no navigation — and that is the entire
 * reason this component exists rather than a richer `TreeItem`.
 *
 * What it draws, in order, and none of it is optional-by-accident:
 *
 *   mark + title + elapsed
 *   one sentence of what is happening
 *   the diff line — NUMBERS, never a bar
 *   repo chips, and the tab marks
 *
 * A field with no data draws nothing rather than a placeholder. A card that
 * omits a fact is honest; one that invents a zero is not.
 */

/** The card's own answer keys, live only while it is the top of the rail. */
function useAnswerKeys(answers: readonly [CardAnswer, CardAnswer] | undefined, run: (a: CardAnswer) => void): void {
  useEffect(() => {
    if (answers === undefined) return undefined;
    const bound = answers.filter((answer) => answer.key !== undefined);
    if (bound.length === 0) return undefined;

    const onKey = (event: KeyboardEvent): void => {
      // A modifier means the keystroke belongs to something else — ⌘Y is not an
      // answer, and a bare `y` typed into a field is not one either.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      const hit = bound.find((answer) => answer.key?.toLowerCase() === event.key.toLowerCase());
      if (hit === undefined) return;
      event.preventDefault();
      run(hit);
    };

    // Capture, on `window`, for the same reason ⌘K is: xterm has focus and a
    // bubbling listener never sees the key.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [answers, run]);
}

export function TaskCard({ item, selected, invoke }: ExtensionRowProps): ReactElement {
  const data = useMemo(() => readCardData(item.data), [item.data]);

  const answer = useCallback(
    (choice: CardAnswer) => {
      void invoke(choice.command, choice.args);
    },
    [invoke],
  );
  useAnswerKeys(data?.question?.answers, answer);

  const open = useCallback(() => {
    const command = item.command;
    if (command !== undefined) void invoke(command.id, command.args);
  }, [invoke, item.command]);

  // Unreadable data falls back to the plainest true thing: the label and a
  // resting mark. The row still says what it stands for and is still clickable,
  // which is the whole point of the name-resolves-or-degrades seam.
  const card: CardData = data ?? { mark: 'resting' };
  const question = card.question;
  const waiting = card.mark === 'waiting' && question !== undefined;

  return (
    <div
      className="sh-task-card"
      data-mark={card.mark}
      data-selected={selected ? 'true' : undefined}
      data-open={waiting ? 'true' : undefined}
    >
      {/*
        The card is a button only where it is not already carrying buttons. A
        <button> wrapping Allow/Deny would nest interactive elements, which is
        invalid and makes the inner ones unreachable by keyboard in some AT.
      */}
      <button type="button" className="sh-task-card__head" onClick={open}>
        <StateMark state={card.mark} />
        <span className="sh-task-card__title">{item.label}</span>
        {card.elapsed === undefined ? null : <span className="sh-task-card__elapsed">{card.elapsed}</span>}
      </button>

      {card.summary === undefined ? null : <p className="sh-task-card__summary">{card.summary}</p>}

      {card.diff === undefined && card.suite === undefined ? null : (
        <div className="sh-task-card__diff">
          {card.diff === undefined ? null : (
            <>
              {/*
                Numbers, not a bar. A stacked +/− bar encodes the same three
                facts as a ratio — which answers "was it mostly additions", a
                question nobody asks — while making "how big is this" something
                you estimate from a width.
              */}
              <span className="sh-task-card__added">+{card.diff.added}</span>
              <span className="sh-task-card__removed">−{card.diff.removed}</span>
              <span className="sh-task-card__sep" aria-hidden="true">
                ·
              </span>
              <span className="sh-task-card__files">
                {card.diff.files} {card.diff.files === 1 ? 'file' : 'files'}
              </span>
            </>
          )}
          {card.suite === undefined ? null : (
            <SuiteMeter className="sh-task-card__suite" total={card.suite.total} passed={card.suite.passed} />
          )}
        </div>
      )}

      {card.exitCode === undefined ? null : (
        <span className="sh-task-card__exit">exit {card.exitCode}</span>
      )}

      {card.repos === undefined && card.tabs === undefined ? null : (
        <div className="sh-task-card__foot">
          {card.repos?.map((repo) => (
            <span key={repo.name} className="sh-task-card__repo">
              {/*
                A ROLE name, resolved to a custom property here. The extension
                said `repo2`; what colour that is stays a fact about the token
                layer, and an extension that wrote a hex would be a visible bug
                the moment a user swapped themes.
              */}
              <i style={{ background: `var(--sh-${repo.mark})` }} aria-hidden="true" />
              {repo.name}
            </span>
          ))}
          {card.tabs === undefined ? null : (
            <span className="sh-task-card__tabs" title={`${card.tabs.length} tabs`}>
              {card.tabs.map((state, index) => (
                <StateMark key={index} state={state} />
              ))}
            </span>
          )}
        </div>
      )}

      {!waiting ? null : (
        <div className="sh-task-card__ask">
          <p className="sh-task-card__question">
            {question.subject === undefined ? (
              question.text
            ) : (
              <>
                {question.text} <code>{question.subject}</code>
              </>
            )}
          </p>
          {question.answers === undefined ? (
            /*
              The door. A question that does not fit — five options, a header,
              multi-select, or options that are sentences — keeps the card's
              shape and ends in one ghost bar that does what clicking the card
              does. The terminal renders the question properly already; the
              rail's job was only ever to say which task is asking.
            */
            <Button variant="ghost" size="sm" className="sh-task-card__door" onClick={open}>
              check →
            </Button>
          ) : (
            <div className="sh-task-card__answers">
              {question.answers.map((choice, index) => (
                <Button
                  key={choice.command}
                  /*
                    ONE primary per surface, and it is the first answer. The
                    second is bordered — never `danger`, because `Deny` is a
                    back-out path and back-out paths carry nothing.

                    `default` is the primitive's current name for what §4 calls
                    `secondary`; the rename lands with `Button`'s own rewrite
                    rather than here, so this file does not depend on a change it
                    does not make.
                  */
                  variant={index === 0 ? 'primary' : 'default'}
                  size="sm"
                  onClick={() => answer(choice)}
                >
                  {choice.label}
                  {choice.key === undefined ? null : (
                    <kbd className="sh-task-card__key">{choice.key.toUpperCase()}</kbd>
                  )}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
