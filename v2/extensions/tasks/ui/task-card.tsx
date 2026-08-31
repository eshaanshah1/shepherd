import { useCallback, useEffect, useMemo, type ReactElement } from 'react';
import type { ExtensionRowProps } from '@shepherd/sdk';
import { Button, Icon, IconButton, NAMED_GLYPHS, StateMark, SuiteMeter, namedGlyph } from '@shepherd/ui';
import { readCardData, type CardAnswer, type CardData, type CardFact } from './card-data.ts';

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

/**
 * What other extensions say about this task — `tasks.cardFacts`. A PR's state, a
 * deploy, a check.
 *
 * **It is drawn at rest, and that is the change this component exists to make.**
 * These lived in the trailing cell, revealed with the row's hover verb, and the
 * old note beside them stated the cost plainly: "a fact is no longer readable
 * without pointing at the row, so the rail stops saying *this task's PR is red*
 * at a glance." That was the wrong trade for the one fact that turned out to
 * matter most. A rail exists to be scanned, and a state you have to hunt for
 * with the pointer is one you find out about from somewhere else.
 *
 * What paid for it: 320px of rail, and a permanent meta line that gives the
 * title its whole first line back — which is what the trailing cell was
 * protecting in the first place.
 *
 * **A tone is never the only difference between two facts.** Every one carries
 * `title` as its accessible name and its tooltip, and a provider that separates
 * two states by hue alone has made a distinction that cannot be read out,
 * screenshotted or asserted on. `github` gives each rollup state its own glyph
 * from the pull-request family for exactly this reason.
 *
 * A fact with a command is a real `<button>` and one without is a `<span>` —
 * never a div with a click handler, and never a button that does nothing.
 */
function Facts({
  facts,
  invoke,
}: {
  readonly facts: readonly CardFact[] | undefined;
  readonly invoke: ExtensionRowProps['invoke'];
}): ReactElement | null {
  if (facts === undefined || facts.length === 0) return null;
  return (
    <>
      {facts.map((fact) => {
        /*
          `NAMED_GLYPHS` directly rather than `namedGlyph`, whose fallback is a
          `…` — right for a hover action, which is an invisible button without
          one, and wrong here: a fact can be a label alone, so an unknown name
          should cost the glyph and not invent a mark that means nothing.
        */
        const glyph = fact.icon === undefined ? undefined : NAMED_GLYPHS[fact.icon];
        const inside = (
          <>
            {glyph === undefined ? null : <Icon icon={glyph} size="sm" />}
            {fact.label === undefined ? null : <span aria-hidden="true">{fact.label}</span>}
            <span className="sh-ui-sr-only">{fact.title}</span>
          </>
        );
        const shared = {
          className: 'sh-task-card__fact',
          'data-tone': fact.tone,
          title: fact.title,
        } as const;
        return fact.command === undefined ? (
          <span key={fact.title} {...shared}>
            {inside}
          </span>
        ) : (
          <button
            key={fact.title}
            type="button"
            {...shared}
            onClick={(event) => {
              // This sits inside a row that is itself a button.
              event.stopPropagation();
              if (fact.command === undefined) return;
              void invoke(fact.command.id, fact.command.args);
            }}
          >
            {inside}
          </button>
        );
      })}
    </>
  );
}

/**
 * The incognito glyph, resolved once.
 *
 * Read out of the allow-list rather than imported, because the import
 * boundaries keep Tabler out of an extension — a view reaching the icon package
 * directly could ship a glyph at a fourth size and a second stroke weight.
 * `namedGlyph` is the wrong door for this one: its fallback is `IconDots`, and
 * dots in the state column would be a picture that means something else. A build
 * whose `@shepherd/ui` predates the name draws nothing, which is the same
 * failure `contributedIcon` chooses in the shell, for the same reason.
 */
const INCOGNITO_GLYPH = NAMED_GLYPHS['spy'];

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

  // Unreadable data falls back to the plainest true thing: the label, and the
  // empty mark slot rather than a state nobody reported. The row still says what
  // it stands for and is still clickable, which is the whole point of the
  // name-resolves-or-degrades seam.
  const card: CardData = data ?? {};
  const question = card.question;
  // Never on a shipped card. The ask block is the one thing below that `dense`
  // does not gate — it is what a card OPENS for — so a stale question on finished
  // work would draw answer buttons for an agent that is no longer running.
  const waiting = card.mark === 'waiting' && question !== undefined && card.shipped !== true;

  /*
   * **A task is a ROW until it has something to show.**
   *
   * §5: "Everything else is a fixed-height row or a fixed-shape card." The
   * first build made every task a card, and a rail of six idle tasks was
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
   * already says it is working, in the same 12px slot every other mark uses.
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

  /*
   * Does the second line have anything on it?
   *
   * Asked here rather than by each block below refusing to draw itself, because
   * the ELEMENT is what must not exist: a `__meta` div holding three nulls still
   * takes a line's height, which is exactly the empty strip this replaced.
   *
   * A shipped row never has one. It is one dimmed line by design — that is what
   * lets the whole Shipped region live permanently in the rail — and its one
   * fact stays in the trailing cell where it always was.
   */
  const multiRepo = card.repos !== undefined && card.repos.length > 1;
  const elapsed = card.elapsed;
  /*
   * **Every live row is a two-line card.** Unconditional, and it took three goes
   * to land there, so the reasoning is worth keeping.
   *
   * It shipped unconditional first, on §10's "a row must not grow to say
   * something" — and a rail of quiet tasks was a column of titles each trailed
   * by a reserved empty strip, which reads as a rendering fault. So it was made
   * conditional, and then a row would simply lose its second line whenever it
   * had nothing to say, which is a row changing height for a reason nothing on
   * screen states.
   *
   * The mistake in both was treating the emptiness as a layout problem. It is a
   * CONTENT problem: the writer now always has something true to put there, down
   * to the state in words when there is nothing else (`STATE_WORDS`). With a
   * floor under it, the line can be unconditional and never be empty — which is
   * what a card is.
   *
   * Glyphs are not on it. They live in the trailing column, stacked over the
   * row's verb — see the note there.
   */
  const meta = card.shipped !== true;

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
      /*
        **The whole card is the target, not its title line.**

        It was the head alone, which meant the half of the card below the title —
        the sentence, the duration, the diff line, the repo chips — looked exactly
        as clickable as the half above it and did nothing. A row you have to aim
        at the top of is a row you miss.

        A DIV with `role="button"`, not a `<button>` — `Row`'s trade, for `Row`'s
        reason: the card holds real controls (the glyph, the verb, the two
        answers) and a `<button>` wrapping any of them is invalid HTML that React
        objects to at runtime and that some AT cannot reach by keyboard. So the
        role, the tab stop and the keyboard activation are supplied by hand, which
        is all a `<button>` was giving us.

        Everything inside that is itself a control stops the event — see each of
        them. That is what keeps "archive this task" from also meaning "open it".
      */
      role="button"
      tabIndex={0}
      onClick={open}
      /*
        Enter and Space, because a div's role does not come with them. Space is
        `preventDefault`ed on keydown or the rail scrolls under the card the
        gesture is meant to open.

        `event.target` is checked, not just the key: with the whole card a target,
        Space typed on the Allow button would answer the question AND open the
        task, and Enter on it would do the same. A control inside handles its own
        keys.
      */
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        open();
      }}
    >
      <div className="sh-task-card__head">
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
          **What this task IS, at the end of the title's own line.**

          IN the flex line, not floating over it. This pair spent three rounds as
          an absolutely positioned column spanning both rows, told where those
          rows were by a grid whose track sizes had to be kept in step with the
          card's padding and its line heights BY HAND — and each time one of
          those numbers moved, the glyph landed on the wrong line or the verb
          fell out through the bottom of the card onto the row below.

          A thing that belongs on a line belongs IN it. The title is `flex: 1`,
          so this sits at the right edge without being told where that edge is,
          and the reservation stops being a number anyone maintains: the element
          IS the reservation.
        */}
        <Facts facts={card.facts} invoke={invoke} />
        {/*
          A row with no second line keeps its verb up here, beside the glyph,
          which is where the two of them started. That is a shipped row.
        */}
        {meta || action === undefined ? null : (
          <IconButton
            className="sh-task-card__action"
            icon={namedGlyph(action.icon)}
            size="sm"
            label={action.label}
            title={action.label}
            /*
              The card is a button and this sits inside it. Without the stop,
              archiving a task would also reveal it — and the window would move to
              a task on its way out of the list.
            */
            onClick={(event) => {
              event.stopPropagation();
              void invoke(action.id, action.args);
            }}
          />
        )}
      </div>

      {/*
        **The meta line — drawn when there is something on it, and not before.**

        Three things used to compete for the head: the PR fact hid inside the
        hover cell, the step sat beside the title and truncated it, and the diff
        numbers only ever drew on a card — which is to say never on a working
        task, the common case and the one you actually want them for.

        **This shipped as an UNCONDITIONAL line and that was wrong.** The
        argument for it was §10: a line that appears when work starts is a row
        that grows to say something. The argument is real and it lost to what it
        cost — a rail whose tasks have no PR, no step and no changes yet is a
        column of titles each trailed by an empty reserved strip, and reserved
        emptiness reads as a rendering fault rather than as a row at rest. §6's
        "a field with no data draws nothing rather than a placeholder" is the
        rule that actually governs here, and an empty line IS the placeholder.

        What makes the reflow affordable is that it happens ONCE, on the
        transition from a task that has done nothing to a task that has, and
        never again — the line's contents change after that, its presence does
        not. That is a different thing from the reflow §10 bans, which is a
        control moving under the cursor on a gesture you make constantly.

        It carries the STEP while the task is being built — the one fact about a
        task that has not started yet, and its disappearance is still the signal
        that the work has begun — and a duration at the trailing edge saying how
        long the task has been in the state its mark reports.

        **The diff numbers used to hold that slot and they are gone from the rail
        entirely**, not demoted to a hover. `+12 −4 · 3 files` answers "how big is
        this", which is a review-time question, asked once, by somebody who has
        already decided to look. The rail is scanned. Worse, it reads as a
        progress bar and is not one: an agent that wrote 400 lines is not further
        along than one that wrote 40, and a large diff is as often a wrong turn.
        The numbers belong beside the diff itself.

        What the slot is FOR, and the test any future tenant has to pass: it
        finishes the sentence the state mark started. Working → on what. Waiting
        → for what. Ready → with what result. Failed → why. A fact that does not
        complete that sentence is decoration, and at 320px decoration is noise.
      */}
      {!meta ? null : (
        <div className="sh-task-card__meta">
          {/*
            **Incognito, in the one place on the card that is reserved and empty.**

            `task-card.css` keeps the meta line indented past the mark's slot and
            says why — "the mark's slot is a column the eye uses to find state; a
            second line starting in it would put the meta text where a mark
            belongs". That argument is about TEXT, and this is the exception it
            leaves: a glyph in the gutter starts no second column of prose, costs
            no row height (the line's block-size is fixed), and does not move the
            summary, which keeps its own indent whether or not this is here.

            Deliberately NOT the state mark. Incognito is a property of the task
            and not a state of it — a working incognito task is still working —
            and §5's five marks stay five. It is also not a `Fact`: a fact
            finishes the sentence the mark started, and this one answers a
            different question, about where the session's history goes.
          */}
          {card.incognito !== true || INCOGNITO_GLYPH === undefined ? null : (
            <span className="sh-task-card__incognito" title="Incognito — this task's Claude profile is deleted with it">
              <Icon icon={INCOGNITO_GLYPH} size="sm" />
              {/*
                The word travels, because §5 refuses a fact encoded only in a
                picture: a glyph alone cannot be read out, searched, or asserted
                on by anything but a screenshot.
              */}
              <span className="sh-ui-sr-only">Incognito — this task&rsquo;s Claude profile is deleted with it</span>
            </span>
          )}
          {card.stage !== undefined ? (
            <span className="sh-task-card__stage">{card.stage}</span>
          ) : card.summary === undefined ? null : (
            /*
              What the agent last said — or, while it is working, what you asked
              it to do. The writer decides which (`summaryFor`); the card just
              draws the one line it was handed.

              Same class as `stage` and styled with it: one line, ellipsised,
              never growing. A summary that needed two lines would not be one.
            */
            <span className="sh-task-card__summary">{card.summary}</span>
          )}
          {/*
            **How long it has been like this** — at the trailing edge, and the
            reason the diff numbers are not here any more.

            `+12 −4 · 3 files` said work happened. It did not say whether you are
            needed, and on a rail of six parallel agents that is the only
            question being asked. It was a bad progress signal besides: an agent
            that wrote 400 lines is not further along than one that wrote 40, and
            a large diff is as often a wrong turn as it is progress.

            The mark says a task is waiting. This says how long you have been the
            one holding it up — the tiebreaker when three are waiting at once,
            and the thing that makes a rail a priority queue rather than a status
            list.

            `flex: none` and last, so the slot beside it truncates first: a
            duration is three characters and whole, where a step is a word that
            ellipsises fine.
          */}
          {elapsed === undefined ? null : (
            <span className="sh-task-card__elapsed" title={`${elapsed} in this state`}>
              <span aria-hidden="true">{elapsed}</span>
              <span className="sh-ui-sr-only">{elapsed} in this state</span>
            </span>
          )}
          {/*
            **The row's one verb, at the end of the second line** — under the
            glyph, which is what puts the two on two rows without either one
            being positioned or told where a row is.
          */}
          {action === undefined ? null : (
            <IconButton
              className="sh-task-card__action"
              icon={namedGlyph(action.icon)}
              size="sm"
              label={action.label}
              title={action.label}
              /*
                The card is a button and this sits inside it. Without the stop,
                archiving a task would also reveal it — and the window would move to
                a task on its way out of the list.
              */
              onClick={(event) => {
                event.stopPropagation();
                void invoke(action.id, action.args);
              }}
            />
          )}
          {/*
            The repo chips, at the trailing edge — and on DENSE rows too, which
            is the change.

            They used to live in the foot, which only a card has, so a task
            spanning two repos said so only while it was also waiting on you or
            failing. Which repos a task touches is not a property of how much
            trouble it is in; on a multi-repo task it is most of what
            distinguishes one row from the next.

            **More than one, or none.** A single chip beside a task in a
            single-repo workspace repeats the same word down the whole rail —
            §6's duplication rule, and the reason the foot's version was never
            worth ungating as-is.
          */}
          {!multiRepo || card.repos === undefined ? null : (
            <span className="sh-task-card__repos">
              {card.repos.map((repo) => (
                <span key={repo.name} className="sh-task-card__repo">
                  {/*
                    A ROLE name, resolved to a custom property here. The
                    extension said `repo2`; what colour that is stays a fact
                    about the token layer, and an extension that wrote a hex
                    would be a visible bug the moment a user swapped themes.
                  */}
                  <i style={{ background: `var(--sh-${repo.mark})` }} aria-hidden="true" />
                  {repo.name}
                </span>
              ))}
            </span>
          )}
        </div>
      )}

      {/*
        The suite meter, alone on its row now that the diff numbers moved up to
        the meta line where every live task can show them.

        It stays card-only rather than following them. A meter is a picture of a
        run that just happened, and it earns its width by being one — a strip of
        cells beside the counts would be two answers to "how big" competing for
        the same line, at the width the counts were only just given room in.
      */}
      {dense || card.suite === undefined ? null : (
        <div className="sh-task-card__suiteRow">
          <SuiteMeter className="sh-task-card__suite" total={card.suite.total} passed={card.suite.passed} />
        </div>
      )}

      {dense || card.exitCode === undefined ? null : (
        <span className="sh-task-card__exit">exit {card.exitCode}</span>
      )}

      {/*
        The mark strip, which is now the whole foot — the repo chips moved to the
        meta line, where a dense row can carry them too.

        This one cannot follow them: it is the second line a multi-tab task EARNS
        (see `dense` above), so drawing it on the meta line would give every
        single-tab task the strip's height for one mark it already has at the
        head.
      */}
      {dense || card.tabs === undefined ? null : (
        <div className="sh-task-card__foot">
          <span className="sh-task-card__tabs" title={`${card.tabs.length} tabs`}>
            {card.tabs.map((state, index) => (
              <StateMark key={index} state={state} />
            ))}
          </span>
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
            <Button
              variant="ghost"
              size="sm"
              className="sh-task-card__door"
              /*
                The stop is not redundant with the card doing the same thing: the
                card's handler would run a SECOND time as this bubbles, opening
                the task twice on one click.
              */
              onClick={(event) => {
                event.stopPropagation();
                open();
              }}
            >
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
                  /*
                    Stopped, because the whole card is a target now. Without it,
                    `Allow` would answer the question and then also open the task
                    — which moves the window to the pane you just answered from.
                  */
                  onClick={(event) => {
                    event.stopPropagation();
                    answer(choice);
                  }}
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
