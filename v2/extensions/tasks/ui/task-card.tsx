import { useCallback, useEffect, useMemo, type ReactElement } from 'react';
import type { ExtensionRowProps } from '@shepherd/sdk';
import { Button, IconButton, StateMark, SuiteMeter, namedGlyph } from '@shepherd/ui';
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
 *   mark + title + the one verb
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

  const action = item.primaryAction;

  const open = useCallback(() => {
    const command = item.command;
    if (command !== undefined) void invoke(command.id, command.args);
  }, [invoke, item.command]);

  // Unreadable data falls back to the plainest true thing: the label and a
  // resting mark. The row still says what it stands for and is still clickable,
  // which is the whole point of the name-resolves-or-degrades seam.
  const card: CardData = data ?? { mark: 'resting' };
  const question = card.question;
  // Never on a shipped card. The ask block is the one thing below that `dense`
  // does not gate — it is what a card OPENS for — so a stale question on finished
  // work would draw answer buttons for an agent that is no longer running.
  const waiting = card.mark === 'waiting' && question !== undefined && card.shipped !== true;

  /*
   * **A task is a ROW until it has something to show.**
   *
   * §5: "Everything else is a fixed-height row or a fixed-shape card." The
   * first build made every task a card, and a rail of six resting tasks was
   * six bordered boxes with a title in each — six times the height for the same
   * six words, and the card treatment stopped meaning anything because
   * everything had it.
   *
   * A card is earned by having a second line worth drawing, and there are
   * exactly three ways to earn one:
   *
   *   - it is **waiting on you** — the question and its answers need the room;
   *   - the run **failed** — the exit code and the way back need the room;
   *   - it has **more than one tab** — the mark strip is the second line.
   *
   * An agent that is merely WORKING is a row. That is the correction that
   * matters most: working is the common case, and a rail where the common case
   * is tall is a rail you scroll to find the one thing that is not. The mark
   * already says it is working, in the same 12px slot a resting one uses.
   */
  /*
   * A SHIPPED task is always a row, and it wins over all three earners above.
   *
   * Each of those earns height for something a finished task does not have: there
   * is no question to answer, no run to return to from a failure, and no live tabs
   * for a mark strip to describe. It is also the reason the whole Shipped region
   * can live permanently in the rail — a dozen finished tasks are a dozen dimmed
   * lines, where a dozen cards would be the rail.
   */
  const dense =
    card.shipped === true ||
    (!waiting && card.mark !== 'failed' && (card.tabs === undefined || card.tabs.length < 2));

  return (
    <div
      className="sh-task-card"
      data-mark={card.mark}
      data-dense={dense ? 'true' : undefined}
      /*
        Dimming is the stylesheet's, not a colour chosen here: the card paints in
        role tokens and "finished work recedes" is a statement about emphasis.
      */
      data-shipped={card.shipped === true ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      data-open={waiting ? 'true' : undefined}
    >
      {/*
        The card is a button only where it is not already carrying buttons. A
        <button> wrapping Allow/Deny would nest interactive elements, which is
        invalid and makes the inner ones unreachable by keyboard in some AT.
      */}
      <button type="button" className="sh-task-card__head" onClick={open}>
        {/*
          **A mark whose value the region already states is not information — and
          neither is the space it was drawn in.**

          `state-mark.css` said the premise out loud — "a check, and then it leaves
          the list … transient by design: a shipped task becomes a count at the foot
          of the rail" — and that stopped being true when Shipped became a permanent
          region. Eight rows under a heading reading `Shipped` drew eight identical
          checks at the left edge where the eye starts scanning.

          **The slot goes with them**, which is the part worth stating because Row
          rule 2 argues the opposite: a label's x must not depend on whether its row
          happens to have a status. That rule is about ONE LIST, and the answer here
          is that Shipped is a region with no state column at all — its heading, its
          day labels, its titles and its `N more` all sit at one left edge, and the
          21px is title track back on a 332px rail (14% of it at the narrow width
          this was measured at).

          The exception is the mark that DEVIATES from what the heading says. A task
          can be shipped while its last run was failing, and `task-card.css` already
          keys the dimming on `data-shipped` rather than on the mark for exactly that
          reason: red must stay findable in a block you scan. That one row indents its
          own title, which is the honest cost — the row you are meant to notice is the
          row that looks different.
        */}
        {card.shipped === true && card.mark !== 'failed' ? null : <StateMark state={card.mark} />}
        <span className="sh-task-card__title">{item.label}</span>
        {/*
          The count of what this row stands for, OUTSIDE the trailing cell.

          It is not metadata that yields to a hover action — it is part of what the
          row says, and a badge that vanished under the pointer would take the
          disclosure with it. `flex: none`, so the title truncates around it rather
          than the row growing.
        */}
        {card.dupe === undefined ? null : (
          <span className="sh-task-card__dupe" title={`${card.dupe} tasks with this name`}>
            <span aria-hidden="true">{card.dupe}</span>
            <span className="sh-ui-sr-only">{card.dupe} tasks with this name</span>
          </span>
        )}
        {/*
          The row's ONE verb, revealed on hover, in the cell that used to share
          itself with the elapsed stamp.

          It stays a grid cell with a hidden-but-laid-out button rather than
          becoming a plain conditional child: §6 refuses a row that GROWS to reveal
          its actions, and `visibility` is what keeps the track at the button's
          width while it is not shown. With the stamp gone there is nothing left to
          swap WITH — but the reflow the cell prevents was never about the stamp, it
          was about the button appearing from nothing.
        */}
        <span className="sh-task-card__trail">
          {action === undefined ? null : (
            <IconButton
              className="sh-task-card__action"
              icon={namedGlyph(action.icon)}
              size="sm"
              label={action.label}
              title={action.label}
              /*
                This control sits INSIDE a button. Without the stop, archiving a
                task would also reveal it — and the window would move to a task
                on its way out of the list.
              */
              onClick={(event) => {
                event.stopPropagation();
                void invoke(action.id, action.args);
              }}
            />
          )}
        </span>
      </button>

      {/*
        Guarded by `dense` like every block below it, and the guard is the point
        rather than symmetry: a dense card IS the fixed-height row, and a summary
        under one would add two lines to it — rule 9 broken through a side door,
        by a field nothing populates today and something will.
      */}
      {dense || card.summary === undefined ? null : (
        <p className="sh-task-card__summary">{card.summary}</p>
      )}

      {dense || (card.diff === undefined && card.suite === undefined) ? null : (
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

      {dense || card.exitCode === undefined ? null : (
        <span className="sh-task-card__exit">exit {card.exitCode}</span>
      )}

      {dense || (card.repos === undefined && card.tabs === undefined) ? null : (
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

                  */
                  variant={index === 0 ? 'primary' : 'secondary'}
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
