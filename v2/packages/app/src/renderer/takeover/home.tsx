import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { IconButton, StateMark } from '@shepherd/ui';
import type { ViewContributionDTO, ViewsApi } from '../../shared/index.ts';
import { ComponentView } from '../view-dock.tsx';
import { PixelSheep } from '../sky-strip.tsx';
import { raiseIcon } from '../view-dock.tsx';
import type { MoreControl } from './entries.ts';
import type { RowAnswer, RowDiff, RowRepo } from './row-facts.ts';
import { liveCount, triage, type TriageEntry, type TriageSection } from './triage.ts';
import { REGION_COLUMNS, TRAIL_ORDER, ageFor, type RegionColumns, type TrailCell } from './columns.ts';
import type { FaceTab } from './faces.ts';
import type { Face } from './nav.ts';

/**
 * **Home: the whole window as one question — what needs me?**
 *
 * Not a dashboard and not a list of tasks. Every region here is an answer to
 * that question at a different volume, and the ordering is the design: the only
 * one drawn loud is the one that costs you something to ignore.
 *
 * The measure is 960px and centred, which is the one piece of geometry worth
 * arguing for. A triage row is a name on the left and a few numbers on the
 * right, and across a 1600px window the numbers end up a hand's width from the
 * name they belong to — you stop reading rows and start reading two columns.
 */

export interface TakeoverHomeProps {
  readonly entries: readonly TriageEntry[];
  /** Open what this row stands for. */
  readonly onOpen: (entry: TriageEntry) => void;
  /** The faces something claimed, so a row only offers the ones that exist. */
  readonly faces: readonly FaceTab[];
  /** Open a task straight at one of its faces, skipping Agents. */
  readonly onOpenFace: (entry: TriageEntry, face: Face) => void;
  /** Run one of a question card's two answers. */
  readonly onAnswer: (entry: TriageEntry, answer: RowAnswer) => void;
  /** Put this one off — the `Later` verb, and the `S` key. */
  readonly onLater: (entry: TriageEntry) => void;
  /** The one primary action on the surface. */
  readonly onNew: () => void;
  /**
   * Contributed PANELS — `surface: 'dock'` components, at the foot.
   *
   * They had the rail and the rail is gone. A contribution the shell silently
   * drops is the failure ADR 0033 is written against: the extension registered,
   * main logged it, and the screen showed nothing. So they land here, under the
   * regions — Home is the shell's "everything" screen, and a panel of controls
   * belongs below the work rather than beside it.
   */
  readonly panels?: readonly ViewContributionDTO[];
  readonly bridge?: ViewsApi | null;
  /**
   * Regions that are drawing a SUBSET, and the verb that finishes each one.
   *
   * Home does not draw a `Show all` button for these. It scrolls — which the
   * rail could not — so the region simply continues when you reach the foot of
   * it, and the cap goes back to meaning "how much loads before you ask" rather
   * than "how much there is".
   */
  readonly more?: readonly MoreControl[];
  readonly onReveal?: (control: MoreControl) => void;
}

export function TakeoverHome({
  entries,
  onOpen,
  onAnswer,
  onLater,
  onNew,
  faces,
  onOpenFace,
  panels = [],
  bridge = null,
  more = [],
  onReveal,
}: TakeoverHomeProps): ReactElement {
  const sections = triage(entries);
  const needs = sections.find((section) => section.group === 'needs');
  return (
    <>
      <header className="sh-take__head sh-take__head--home">
        <span className="sh-take__title">Shepherd</span>
        {/*
          A count, not a clock. The prototype carried the time of day and it is
          the one thing on that screen the OS already says, in a bar 20px above
          this one — and a number that changes every minute in the corner of a
          triage screen is a thing the eye returns to for no reason.
        */}
        <span className="sh-take__count">{liveCount(entries)} live</span>
        <span className="sh-take__spacer" />
        <TakeButton kind="primary" hint="N" onClick={onNew}>
          New
        </TakeButton>
      </header>
      <div className="sh-take__scroll">
        <div className="sh-take__home" data-testid="takeover-home">
          {needs === undefined ? <Quiet /> : null}
          {sections.map((section) => (
            <Section
              key={section.group}
              section={section}
              /*
               * The loud region never gets a window. It is the one thing on this
               * screen that costs you to ignore, and a question card is the one
               * element allowed to change size — clipping either would be the
               * screen hiding the work it exists to surface.
               */
              windowed={!section.loud && (section.entries.length > REGION_ROWS || more.some((control) => control.group === section.group))}
            >
              {section.entries.map((entry) =>
                section.group === 'needs' && entry.facts.question !== undefined ? (
                  <QuestionCard
                    key={entry.id}
                    entry={entry}
                    onOpen={onOpen}
                    onAnswer={onAnswer}
                    onLater={onLater}
                  />
                ) : (
                  <TriageRow
                    key={entry.id}
                    entry={entry}
                    group={section.group}
                    onOpen={onOpen}
                    faces={faces}
                    onOpenFace={onOpenFace}
                  />
                ),
              )}
              {more
                .filter((control) => control.group === section.group)
                .map((control) => (
                  <Reveal
                    key={control.id}
                    onReach={() => onReveal?.(control)}
                  />
                ))}
            </Section>
          ))}
          {panels.length === 0 ? null : (
            <section className="sh-take__panels" data-testid="takeover-panels">
              {panels.map((panel) => (
                <div className="sh-take__panel" key={panel.type} data-view-type={panel.type}>
                  <ComponentView view={panel} bridge={bridge} onDone={() => undefined} />
                </div>
              ))}
            </section>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The empty state, and it says something narrower than "nothing here".
 *
 * Nothing NEEDING you is not the same fact as nothing existing — five agents may
 * be mid-turn under this sentence — so it sits at the top of the screen with the
 * regions still under it rather than replacing them. That is also why it is not
 * `Empty`: that primitive centres one sentence on a stage that really is bare.
 */
/**
 * How many rows a region shows before it becomes a window onto itself.
 *
 * `Shipped` is a record, and a record has no end — 47 finished tasks drawn in
 * full push every other region off the screen and make the one surface that
 * answers "what needs me" a scroll through work that does not. So the region
 * keeps its ten rows and scrolls INSIDE them: the archive stays reachable and
 * costs the screen a fixed amount of room.
 *
 * The HEIGHT of that window is `--sh-take-region-rows` in `takeover.css`; this
 * decides which regions get one. Keep the two the same number.
 *
 * Ten and not eight, which is `SHIPPED_CAP` in `tasks`. They are different
 * numbers about different things — the cap is how many rows the extension hands
 * over before it is asked for more, and this is how many the screen draws at
 * once — and tying them together would make a load boundary a layout one.
 */
const REGION_ROWS = 10;

function Quiet(): ReactElement {
  return (
    <div className="sh-take__quiet" data-testid="takeover-quiet">
      <PixelSheep resting />
      <div className="sh-take__quiet-say">The flock is quiet.</div>
      <div className="sh-take__quiet-hint">Everything running will raise its hand when it needs you.</div>
    </div>
  );
}

/**
 * The foot of a truncated region — a row of nothing, watched.
 *
 * **A sentinel rather than a control**, and that is the whole of the gesture:
 * reaching the end of a list is already the user asking for more of it, so the
 * screen answers rather than offering a button to press. It draws no ink and
 * takes no focus, which is what lets it sit inside the region's grid without
 * being a row in it.
 *
 * It fires **once**, held in a ref rather than in state — a re-render must not
 * re-arm it, and the control it runs is a TOGGLE, so a second firing would fold
 * the region back up under the cursor that was reading it. The margin is a
 * screenful, so the rest is already drawn by the time the last row of the cap
 * reaches the fold and nothing appears to load.
 */
function Reveal({ onReach }: { onReach: () => void }): ReactElement {
  const at = useRef<HTMLDivElement | null>(null);
  const fired = useRef(false);
  /*
   * The callback, held rather than closed over. It is a fresh function every
   * render, and an effect that re-ran for it would tear the observer down
   * mid-scroll — a window the foot of the list can cross unnoticed.
   */
  const reach = useRef(onReach);
  reach.current = onReach;
  useEffect(() => {
    const node = at.current;
    if (node === null) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (!records.some((record) => record.isIntersecting) || fired.current) return;
        fired.current = true;
        reach.current();
      },
      /*
       * Watched inside the region's own window when it has one, so the load is
       * triggered by scrolling THAT box rather than by the page happening to
       * reach its foot. A margin of most of a window, because the rest should be
       * drawn by the time the last loaded row reaches the bottom edge.
       */
      { root: node.closest('.sh-take__window'), rootMargin: '240px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <div ref={at} className="sh-take__reveal" aria-hidden="true" data-testid="takeover-reveal" />;
}

function Section({
  section,
  windowed,
  children,
}: {
  section: TriageSection;
  /** Draw the rows inside a fixed window of `REGION_ROWS` that scrolls itself. */
  windowed: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="sh-take__group" data-group={section.group} data-windowed={windowed ? 'true' : undefined}>
      <div className="sh-take__grouphead" data-loud={section.loud ? 'true' : undefined}>
        <b>{section.label}</b>
        <span className="sh-take__rule" />
        <span className="sh-take__n">{section.entries.length}</span>
      </div>
      {/*
        The window OWNS the tracks when there is one — a scroll container cannot
        also be the grid its rows subgrid onto and keep its heading still, so the
        section steps down to a block and the tracks move one level in. The rows
        are unchanged either way, which is the point: they borrow whatever grid
        they are in.
      */}
      {windowed ? <div className="sh-take__window">{children}</div> : children}
    </section>
  );
}

function TriageRow({
  entry,
  group,
  onOpen,
  faces,
  onOpenFace,
}: {
  entry: TriageEntry;
  group: TriageSection['group'];
  onOpen: (entry: TriageEntry) => void;
  faces: readonly FaceTab[];
  onOpenFace: (entry: TriageEntry, face: Face) => void;
}): ReactElement {
  const sub = subtitleOf(entry, group);
  const columns = REGION_COLUMNS[group];
  const cells = TRAIL_ORDER.filter((cell) => columns.cells.includes(cell));
  /*
   * A place has no faces — a loose shell has no diff to read and no brief that
   * asked for it — and neither has a row for something that never ran.
   */
  const shortcuts: readonly ShortcutTab[] = entry.place
    ? []
    : faces.filter((tab): tab is ShortcutTab => tab.face !== 'agents');
  return (
    /*
     * A DIV that behaves as a button, not a `<button>`.
     *
     * The row holds its own shortcut buttons now, and a button inside a button
     * is invalid markup that browsers resolve by dropping the inner one — so
     * the icons would render and never fire. The row keeps every affordance it
     * had: it takes focus, it answers Enter and Space, and it says what it is.
     */
    <div
      role="button"
      tabIndex={0}
      className="sh-take__row"
      data-testid="takeover-row"
      data-entry={entry.id}
      data-dim={group === 'shipped' ? 'true' : undefined}
      onClick={() => onOpen(entry)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onOpen(entry);
      }}
    >
      {/*
        A place holds the thing it IS in the column a state would occupy. A
        loose terminal has no lifecycle, so a mark there would be a state it
        does not have and an empty slot would be one it is waiting for.
      */}
      {entry.place ? (
        <span className="sh-take__prompt" aria-hidden="true">
          ❯
        </span>
      ) : (
        <StateMark state={entry.mark} />
      )}
      <span className="sh-take__name">
        <b>{entry.label}</b>
        {sub === undefined ? null : <span className="sh-take__sub">{sub}</span>}
      </span>
      {/*
        One cell per column the REGION draws, in `TRAIL_ORDER`, each pinned to
        its own track by `data-cell` — so `age` is the last thing on every row
        that has one and a row missing a `diff` does not slide its repo chip
        into the diff's column. `columns.ts` holds the argument for which cells
        a region gets; the point here is only that the row does not choose.

        A cell the region asked for whose fact is absent draws EMPTY rather than
        being skipped. That is the difference between a column and a queue: the
        track stays, so the rows either side of it still line up.
      */}
      {cells.map((cell) => (
        <span className="sh-take__cell" data-cell={cell} key={cell}>
          <Cell cell={cell} entry={entry} grain={columns.grain} />
        </span>
      ))}
      {/*
        The shortcuts sit OVER the trailing cells — same tracks, revealed by
        `visibility` — because revealing them must not move the numbers. A row
        whose contents shift under the cursor is a row whose target moved
        mid-click.
      */}
      {shortcuts.length === 0 ? null : (
        <span className="sh-take__jump">
          {shortcuts.map((tab) => (
            <IconButton
              key={tab.face}
              label={`${tab.label} — ${entry.label}`}
              size="sm"
              icon={raiseIcon(FACE_GLYPH[tab.face])}
              onClick={(event) => {
                // The row underneath opens on Agents; this one opens on a face.
                event.stopPropagation();
                onOpenFace(entry, tab.face);
              }}
            />
          ))}
        </span>
      )}
    </div>
  );
}

/** A face a row can jump to. Agents is where a row lands anyway, so it is not one. */
type ShortcutTab = FaceTab & { readonly face: Exclude<Face, 'agents'> };

/** Which glyph stands for a face, in the row's hover shortcuts. */
const FACE_GLYPH: Record<Exclude<Face, 'agents'>, string> = {
  diff: 'branch',
  files: 'folder',
  intent: 'notes',
};

/**
 * What the second half of a row's name says, which depends on the region.
 *
 * `Later` is the case that decides the shape: a snoozed row must say WHEN it
 * comes back, in the extension's own words, because "not now" with no "then" is
 * indistinguishable from "gone" — and the promise the snooze verb makes is that
 * nothing is ever lost.
 */
function subtitleOf(entry: TriageEntry, group: TriageSection['group']): string | undefined {
  if (group === 'later' && entry.facts.snooze !== undefined) return `until ${entry.facts.snooze.label}`;
  return entry.facts.summary ?? entry.description;
}

/**
 * One trailing column's contents, or nothing.
 *
 * Nothing, and not `null` from the caller: the CELL is drawn either way, so a
 * row with no diff still holds the diff column open for the rows around it.
 * This decides only what goes in it.
 */
function Cell({
  cell,
  entry,
  grain,
}: {
  cell: TrailCell;
  entry: TriageEntry;
  grain: RegionColumns['grain'];
}): ReactElement | null {
  if (cell === 'repos') return <Repos repos={entry.facts.repos} />;
  if (cell === 'diff') return <Diff diff={entry.facts.diff} />;
  const age = ageFor(entry.facts.elapsed, grain);
  return age === undefined ? null : <>{age}</>;
}

function Repos({ repos }: { repos: readonly RowRepo[] | undefined }): ReactElement | null {
  if (repos === undefined) return null;
  return (
    <>
      {repos.map((repo) => (
        <span className="sh-take__chip" key={repo.name}>
          {/*
            A token NAME resolved here, never a colour off the wire. An extension
            that could send `#7FB6E8` would be a light-mode bug the first time
            anyone swapped themes.
          */}
          <i style={{ background: `var(--sh-${repo.mark})` }} />
          {repo.name}
        </span>
      ))}
    </>
  );
}

function Diff({ diff }: { diff: RowDiff | undefined }): ReactElement | null {
  if (diff === undefined) return null;
  return (
    <span>
      <span className="sh-take__add">+{diff.added}</span> <span className="sh-take__del">−{diff.removed}</span>{' '}
      <span className="sh-take__dot">·</span> {diff.files} files
    </span>
  );
}

/**
 * The one row in the app that opens into a card.
 *
 * It earns the size by carrying something a row cannot: a sentence you have to
 * READ, and the two verbs that answer it. Everything else on Home is scannable
 * at a glance and is therefore a row — a screen of cards is a screen with no
 * shape, which is what the rail's own history says about the same temptation.
 *
 * The buttons say their keys. On this surface the keyboard is the primary input
 * — `Y`, `N`, `S` answer the top card from anywhere on the screen — and a button
 * that does not print its key teaches nothing.
 */
function QuestionCard({
  entry,
  onOpen,
  onAnswer,
  onLater,
}: {
  entry: TriageEntry;
  onOpen: (entry: TriageEntry) => void;
  onAnswer: (entry: TriageEntry, answer: RowAnswer) => void;
  onLater: (entry: TriageEntry) => void;
}): ReactElement {
  const question = entry.facts.question;
  const why = [entry.facts.summary ?? entry.description, entry.facts.elapsed].filter(Boolean).join(' · ');
  return (
    <div
      className="sh-take__card"
      data-testid="takeover-card"
      data-entry={entry.id}
      role="button"
      tabIndex={0}
      onClick={(event) => {
        // A click on one of the verbs is not a click on the card. Without this,
        // answering also opens the task, which is the one thing answering from
        // Home exists to avoid.
        if ((event.target as HTMLElement).closest('button') !== null) return;
        onOpen(entry);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(entry);
        }
      }}
    >
      <div className="sh-take__cardtop">
        <StateMark state={entry.mark} />
        <span className="sh-take__cardname">{entry.label}</span>
        {why === '' ? null : <span className="sh-take__why">{why}</span>}
      </div>
      <div className="sh-take__q">{question?.text}</div>
      <div className="sh-take__acts">
        {question?.answers?.map((answer, at) => (
          <TakeButton
            key={answer.command + String(at)}
            kind={at === 0 ? 'primary' : 'secondary'}
            {...(answer.key === undefined ? {} : { hint: answer.key })}
            onClick={() => onAnswer(entry, answer)}
          >
            {answer.label}
          </TakeButton>
        ))}
        <TakeButton kind="ghost" hint="S" onClick={() => onLater(entry)}>
          Later
        </TakeButton>
      </div>
    </div>
  );
}

/**
 * The takeover's button, and NOT a re-roll of `Button`.
 *
 * One thing separates them and it is the reason this exists: this control prints
 * its KEY. The takeover is a keyboard surface — `Y`/`N` answer, `S` defers, `N`
 * composes — and a button that does not say its key leaves the whole vocabulary
 * to be discovered. `Button` has no slot for that and should not grow one for a
 * single surface, which is the rule about primitives pointed the other way: a
 * primitive earns a member when a second caller needs it.
 */
export function TakeButton({
  kind,
  hint,
  onClick,
  children,
  ...rest
}: {
  readonly kind: 'primary' | 'secondary' | 'ghost';
  readonly hint?: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
} & Omit<React.ComponentPropsWithoutRef<'button'>, 'onClick' | 'children'>): ReactElement {
  return (
    <button type="button" className="sh-take__bt" data-kind={kind} onClick={onClick} {...rest}>
      {children}
      {hint === undefined ? null : <span className="sh-take__k">{hint}</span>}
    </button>
  );
}
