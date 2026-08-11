import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { IconArchive, IconCheck, IconEye, IconPlus, IconSettings, IconTrash } from '@tabler/icons-react';
import type { IconProps as TablerIconProps } from '@tabler/icons-react';
import type { TreeItem, TreeItemAction, TreeItemSeparator } from '@shepherd/sdk';
import {
  IconButton,
  Menu,
  Row,
  SectionLabel,
  StateMark,
  rowEnterMs,
  type MenuEntry,
  type MarkState,
} from '@shepherd/ui';
import type { ViewContributionDTO, ViewsApi } from '../shared/index.ts';
import { resolveExtensionRowUi, resolveExtensionUi } from './extension-ui.ts';
import { mergeRows } from './merge-rows.ts';
import { unqualify } from '../shared/index.ts';

/**
 * The left sidebar — the first place an extension's own UI appears on screen.
 *
 * It knows **no extension**. It asks main which views exist, asks for each
 * one's rows, and draws them; a task list, a Slack channel list and a GitHub PR
 * list are the same code path here. That is the whole point of M3's view
 * mechanism, and the test of it is that adding `tasks` needs no change to this
 * file (sketch §2b: if a task view needs a special case in the core, the model
 * is wrong).
 *
 * What it *does* own is the **discipline**, which is the Flock language's and
 * v1's before it: one fixed row height whatever a row says, an uppercase
 * micro-label for a section, inverse video for selection (never a tinted wash),
 * the state's meaning carried by a coloured dot, and the status word in the
 * text ramp at the end of the row. An extension supplies data and a token name;
 * it cannot make its row taller, louder or a different colour than the palette.
 *
 * Two things it deliberately does not do. It does not subscribe to a bus topic —
 * it cannot name one, which is what the agent relay's allow-list was protecting.
 * And it does not decide who a row's command runs as: it reports "this row was
 * clicked" and main attributes it to the contributing extension (D14).
 */

/**
 * Whose machine these rows are on — drawn only when it is not this one.
 *
 * A remote row is otherwise indistinguishable from a local one: same label, same
 * verbs, same state dot. That is the point of the design and also its one
 * hazard, because archiving a task on the wrong Mac looks exactly like
 * archiving it on this one and says nothing while it happens. So the section
 * says where it lives, in the same uppercase micro-label the shell already uses
 * for a group — no new colour, no badge, no second visual language.
 */
function RemoteLabel({ view }: { view: ViewContributionDTO }): React.JSX.Element | null {
  if (view.remote === undefined) return null;
  return (
    <SectionLabel data-testid="view-remote" data-member={view.remote.memberId}>
      {view.remote.name}
    </SectionLabel>
  );
}

/**
 * A root nobody grouped is a group of one — the same default the kernel applies
 * at the mint, spelled here so a dock rendered without the map behaves exactly
 * as it did before groups existed.
 */
const identityGroup = (root: string): string => root;

export function ViewDock({
  views: bridge,
  actions,
  activeRoot = null,
  groupOfRoot = identityGroup,
}: {
  views: ViewsApi | null;
  /**
   * The root the window is showing — the SAME value the stage draws from.
   *
   * A row that names that root (`TreeItem.root`) is drawn selected. Reading it
   * from the layout snapshot rather than keeping a selection here is what stops
   * the highlight and the visible pane from being two facts: they are one value
   * read twice, so a switch nobody clicked moves both or neither.
   */
  activeRoot?: string | null;
  /**
   * Which pane GROUP a root belongs to — read off the same snapshot.
   *
   * A root is a tab of a group, and a task's row names the group's anchor root.
   * Comparing root ids alone would blank the highlight the moment you switched
   * to that task's second tab, when you are plainly still looking at the task.
   *
   * A FUNCTION rather than a group id, so the comparison stays symmetric: both
   * sides go through it, and a row naming a tab (not an anchor) is selected on
   * the same terms. The default is the identity, which is exactly the behaviour
   * before groups existed — a root is its own group.
   *
   * Still no new state. The map it closes over arrives in the envelope the
   * stage is drawn from, so the highlight and the visible panes remain one
   * value read twice (ADR 0035).
   */
  groupOfRoot?: (root: string) => string;
  /**
   * Buttons in the sidebar's header — the shell's, not an extension's.
   *
   * At the TOP, because that is where a list's "add" lives in every app that
   * has one. It was a keycap parked at the bottom saying "⌘T NEW TASK", which
   * is a legend: it told you a shortcut existed rather than being the control.
   */
  actions?: React.ReactNode;
}): React.JSX.Element | null {
  const [views, setViews] = useState<readonly ViewContributionDTO[]>([]);
  const [rows, setRows] = useState<Readonly<Record<string, readonly TreeItem[]>>>({});

  /*
   * There is deliberately no selection state here.
   *
   * It used to be a `useState` set by the row's own click, which is a second
   * copy of "what is the user on" — a fact the dock does not own — and it
   * disagreed with the first the moment anything but a click changed it: a task
   * created through the composer switches the window to its own root, and the
   * highlight stayed on whatever was clicked last while a different task's
   * panes filled the screen. `activeRoot` above is the one answer.
   */

  // Handed in, never read off the global: `main.tsx` is the ONE file that knows
  // the bridge is a global, and every other component takes what it needs as a
  // prop. `null` is a state (no bridge), not a crash.

  const refresh = useCallback(
    async (type: string) => {
      if (bridge === null) return;
      const children = await bridge.children(type);
      if (children.ok) setRows((current) => ({ ...current, [type]: children.value }));
    },
    [bridge],
  );

  useEffect(() => {
    if (bridge === null) return;
    const read = async (): Promise<void> => {
      const listed = await bridge.list();
      if (!listed.ok) return;
      setViews(listed.value);
      // Only a tree has rows to ask for. A component owns what it shows, and an
      // overlay is not in this list's business at all.
      for (const view of listed.value) if (view.kind === 'tree') await refresh(view.type);
    };
    void read();
    // A NUDGE arrives and the renderer re-reads: data is never pushed, so a
    // chatty extension cannot flood this. The LIST is re-read too, not just the
    // rows — an extension activates after the window loads, so the list this
    // component saw on mount predates every contribution.
    return bridge.onChanged(() => void read());
  }, [bridge, refresh]);

  const docked = views.filter((view) => view.kind === 'tree' || (view.surface ?? 'dock') === 'dock');
  if (docked.length === 0 && actions === undefined) return null;

  /**
   * One list per KIND of list, not one per machine.
   *
   * Every member's `tasks.tree` is the same list seen from a different place, so
   * they are drawn together and each row says where it lives. A section per
   * member would make the reader do the merging — and would put a task that
   * finished over there in a second DONE list underneath this one's.
   */
  const groups = new Map<string, ViewContributionDTO[]>();
  for (const view of docked) {
    if (view.kind !== 'tree') continue;
    const base = unqualify(view.type);
    groups.set(base, [...(groups.get(base) ?? []), view]);
  }
  const components = docked.filter((view) => view.kind === 'component');

  return (
    <nav className="sh-side" data-testid="view-dock">
      {actions === undefined ? null : <div className="sh-side-head">{actions}</div>}
      <div className="sh-side-scroll">
        {[...groups].map(([base, contributions]) => (
          <TreeView
            key={base}
            base={base}
            views={contributions}
            rowsByType={rows}
            bridge={bridge}
            activeRoot={activeRoot}
            groupOfRoot={groupOfRoot}
          />
        ))}
        {components.map((view) => (
          <ComponentView key={view.type} view={view} bridge={bridge} />
        ))}
      </div>
    </nav>
  );
}

/**
 * A contributed tree — P6's kind, drawn by the sidebar itself, and drawn ONCE
 * however many members contribute it.
 */
function TreeView({
  base,
  views,
  rowsByType,
  bridge,
  activeRoot,
  groupOfRoot,
}: {
  base: string;
  /** Every member contributing this list, this Mac included. */
  views: readonly ViewContributionDTO[];
  rowsByType: Readonly<Record<string, readonly TreeItem[]>>;
  bridge: ViewsApi | null;
  activeRoot: string | null;
  groupOfRoot: (root: string) => string;
}): React.JSX.Element {
  const byType = new Map(views.map((view) => [view.type, view]));
  const merged = mergeRows(views.map((view) => ({ key: view.type, rows: rowsByType[view.type] ?? [] })));
  /*
   * Every heading a contribution sends is drawn, including one that is the
   * first row. "DONE" over an all-finished list still says what the list IS,
   * and dropping it made the sidebar change shape the moment the last live
   * task ended: the label vanished and the finished tasks jumped from the foot
   * to the top, because with no heading left there was nothing to pin against.
   *
   * The rule this replaces suppressed a heading with nothing above it, on the
   * theory that it divided nothing. It divides the list from the sidebar's
   * empty space, which is the only division left when the live work is gone.
   */
  const shown = merged;

  /**
   * Which rows are ARRIVING, so the list grows instead of being swapped.
   *
   * A contributed tree is re-read whole — that is the design (`views.children`
   * answers rows, the dock never patches them) — so a task appearing used to be
   * one paint with N rows and the next with N+1, which reads as the list
   * flickering rather than as something joining it. React keeps the surviving
   * rows' DOM because they are keyed, so all that is missing is a mark on the new
   * ones and a transition on that mark.
   *
   * Three things it deliberately does not do. It does not animate on the FIRST
   * list: everything is new then, and a sidebar that flies in on every launch is
   * a sidebar you wait for. It does not animate HEIGHT — rule 9 is that a row's
   * height never changes, and an entrance that grew one would reflow the whole
   * list under the cursor for the length of the animation. And it forgets a key
   * once the row is gone, so a task that comes back is arriving again.
   */
  const keys = shown.map((entry) => `${entry.key}:${entry.row.id}`);
  const fingerprint = keys.join('\u0000');
  const known = useRef<Set<string> | null>(null);
  const [arriving, setArriving] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    /*
     * Read back OUT of the fingerprint, so this effect depends on exactly one
     * value.
     *
     * Depending on the `keys` array instead would re-run it on every render (a
     * fresh array each time) — and re-running it also re-runs its CLEANUP, which
     * clears the timer that ends the animation. A repaint mid-entrance would then
     * leave the mark on for good, and the row would replay its arrival the next
     * time React had cause to recreate the element.
     */
    const keys = fingerprint === '' ? [] : fingerprint.split('\u0000');
    const current = new Set(keys);
    const first = known.current === null;
    const fresh = first ? [] : keys.filter((key) => !known.current?.has(key));
    known.current = current;
    if (fresh.length === 0) return undefined;
    setArriving(new Set(fresh));
    /*
     * Cleared after the transition rather than left on, because the class is what
     * makes the animation run: a row that kept it would replay its entrance the
     * next time React had cause to recreate the element. The timer's length is
     * the CSS's, named once in `@shepherd/ui` and imported rather than guessed at
     * — two numbers that must match are one number that will not.
     */
    const timer = setTimeout(() => setArriving(new Set()), rowEnterMs);
    return () => clearTimeout(timer);
  }, [fingerprint]);

  /**
   * Everything after the LAST heading is pinned to the bottom of the sidebar.
   *
   * Finished work belongs at the physical bottom, not merely last in the list —
   * with three tasks the difference is nothing, and it is the whole point when
   * the list is short and the sidebar is tall. The split is on the last section
   * rather than on a name, because the dock must not know what "done" means.
   */
  const lastSection = shown.map((entry) => entry.row.section === true).lastIndexOf(true);
  const top = lastSection === -1 ? shown : shown.slice(0, lastSection);
  const bottom = lastSection === -1 ? [] : shown.slice(lastSection);

  const renderRow = (entry: { key: string; row: TreeItem }): React.JSX.Element => {
    {
          const { row } = entry;
          const view = byType.get(entry.key);
          const key = `${entry.key}:${row.id}`;
          if (row.section === true) {
            // A heading, not a row: `SectionLabel` draws the uppercase
            // micro-label, the `·` before the count and the rule to the edge.
            // Deliberately not a button — a group that looked clickable and did
            // nothing is the affordance lie this field exists to avoid.
            return (
              <li key={key}>
                <SectionLabel data-testid="view-group" {...(row.description === undefined ? {} : { count: row.description })}>
                  {row.label}
                </SectionLabel>
              </li>
            );
          }

          /*
           * No local "and now this row is selected": the command below is what
           * moves the user, and the contribution reports where they ended up.
           *
           * **A row belonging to another member takes the other door.** Its
           * `command` is a gesture meant for the machine the row lives on — for a
           * task, one that opens a pane and switches THAT window — so running it
           * from here moves somebody else's screen and leaves this one blank.
           * `presents` answers what the row stands for instead, and main opens a
           * viewer of it locally. A remote row with no `presents` is not
           * clickable-with-nothing-happening: it goes through the same call, which
           * reports why.
           */
          const activate = (): void => {
            if (view === undefined) return;
            if (view.remote !== undefined) {
              if (row.presents === undefined) return;
              void bridge?.present(view.type, row.presents);
              return;
            }
            if (row.command !== undefined) void bridge?.activate(view.type, row.command);
          };

          /*
           * The row's context menu, and the ONE place its entries turn into a
           * command. `activate` above and `runAction` here go through the same
           * `bridge.activate`, so a menu entry is attributed exactly as a click
           * is — to the contributing extension, never to the user (D14). The
           * shell still names no caller.
           */
          const declared = row.actions ?? [];
          const runAction = (id: string): void => {
            const chosen = declared.find((entry) => !isSeparator(entry) && entry.id === id);
            if (chosen === undefined || isSeparator(chosen)) return;
            if (view === undefined) return;
            void bridge?.activate(view.type, {
              id: chosen.id,
              ...(chosen.args === undefined ? {} : { args: chosen.args }),
            });
          };

          const isSelected =
            row.root !== undefined && activeRoot !== null && groupOfRoot(row.root) === groupOfRoot(activeRoot);

          /*
           * A row that draws ITSELF, by name (ADR 0033's seam, one level down).
           *
           * Resolved here rather than in `Row`, because a component that
           * replaces the row replaces its keyboard semantics too — and a `Row`
           * that sometimes rendered somebody else's markup would have to
           * describe two contracts in one primitive.
           *
           * An unknown name falls through to the ordinary row. That is the
           * correct failure and it is gentler than a view's: the row still says
           * what it stands for and is still clickable, it is only missing its
           * richer form. A rail that dropped rows on a version skew would lose
           * the list the app exists to show.
           */
          const RowComponent = resolveExtensionRowUi(row.component);
          if (RowComponent !== undefined && view !== undefined) {
            const contributed = (
              <li key={key} className="sh-side-row-host" data-testid="view-row" data-row-id={row.id}>
                <RowComponent
                  item={row}
                  selected={isSelected}
                  invoke={async (command, args) =>
                    /*
                      No bridge is not an error the CARD should render — it is
                      the window still wiring itself up. Answering with a
                      `ViewInvokeError` keeps the component's contract total
                      without teaching it what a bridge is.
                    */
                    (await bridge?.activate(view.type, { id: command, args })) ?? {
                      ok: false,
                      error: { code: 'unavailable', message: 'the extension host is not connected' },
                    }
                  }
                />
              </li>
            );
            return contributed;
          }

          /*
           * `Row`'s root is a `<div>`, not the `<button>` this used to be, and
           * the keyboard semantics come back here rather than from the element.
           * That is the primitive's own trade (row.tsx states it): a row's
           * trailing area holds hover ACTIONS, and a control inside a button is
           * invalid HTML and unreachable by keyboard. So the row announces itself
           * as a button and activates like one, and a contributed row can grow an
           * action without the shell having to change what it is.
           */
          const rowElement = (
            <Row
                role="button"
                tabIndex={0}
                // Arriving, not merely present: see `arriving` above.
                entering={arriving.has(key)}
                // `row.root !== undefined` first, so a row that is about no
                // root is never lit by the shell also not knowing its own.
                selected={isSelected}
                data-testid="view-row"
                data-row-id={row.id}
                data-host={view?.remote?.memberId}
                // A token name, resolved here. An extension never sends a raw
                // colour, so a contribution cannot break the theme.
                data-tint={row.tint ?? 'none'}
                title={row.description ?? row.label}
                onClick={activate}
                onKeyDown={(event) => {
                  // What `<button>` gave for free. Space is `preventDefault`ed
                  // because its default on a focused div is to scroll the list
                  // out from under the row you just pressed.
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  activate();
                }}
                actions={
                  /*
                    The row's ONE hover verb, in the slot `Row` has always had
                    for it. `stopPropagation` because this control sits INSIDE a
                    row that is itself a button: without it, marking a task done
                    would also reveal it, and the window would move to a task on
                    its way to the DONE section.
                  */
                  row.primaryAction === undefined ? undefined : (
                    <IconButton
                      icon={raiseIcon(row.primaryAction.icon)}
                      size="sm"
                      label={row.primaryAction.label}
                      title={row.primaryAction.label}
                      data-testid="row-primary-action"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (view === undefined || row.primaryAction === undefined) return;
                        void bridge?.activate(view.type, {
                          id: row.primaryAction.id,
                          ...(row.primaryAction.args === undefined ? {} : { args: row.primaryAction.args }),
                        });
                      }}
                    />
                  )
                }
                leading={
                  /*
                    The mark IS the state, and it takes a STATE — never a colour
                    and never the extension's own tint spelling. A coloured dot
                    beside the word RUNNING says one thing twice and gives the row
                    a third column to align.

                    `busy` is deliberately not passed on. It used to swap the dot
                    for a braille spinner, which was a second way of looking busy
                    beside the dot's own colour; §3 has exactly one — the working
                    meter — and a row that is busy is a row whose mark is
                    `working`. Rows that set `busy` without a working tint now
                    read as whatever they actually are, which is the honest
                    answer: a task being archived is resting, and the archiving is
                    not a state of the task.
                  */
                  <StateMark state={markState(row.tint)} />
                }
              >
                {row.label}
                {/*
                  Which machine this row is on, and ONLY when it is not this one.
                  A remote row is otherwise identical to a local one — same
                  label, same verbs, same dot — so acting on the wrong Mac is
                  silent without it. Drawn in the row's own text ramp rather than
                  as a badge: it is a fact about the row, not a decoration.
                */}
                {view?.remote === undefined ? null : (
                  <span className="sh-row-host" data-testid="view-row-host">
                    {view.remote.name}
                  </span>
                )}
              </Row>
          );

          /*
           * Wrapped only when there is something to show. A `Menu` with an empty
           * item list still opens on right-click, and an empty box appearing over
           * the sidebar is worse than nothing happening.
           *
           * The conditional wrap remounts the row when a contribution's actions
           * appear or disappear, and that is deliberately acceptable HERE and
           * would not be one layer down: a row is a div with a label, whereas the
           * same shape around a pane is v1's recorded defect — a `_ConditionalContent`
           * tears down its subtree, and for a pane that means a new surface and a
           * dead shell.
           */
          return (
            <li key={key}>
              {declared.length === 0 ? (
                rowElement
              ) : (
                <Menu items={declared.map(toMenuEntry)} onSelect={runAction}>
                  {rowElement}
                </Menu>
              )}
            </li>
          );
    }
  };

  return (
    <section className="sh-side-view" data-view-type={base}>
      {top.length === 0 ? null : <ul className="sh-rows">{top.map(renderRow)}</ul>}
      {/*
        The finished tasks, pinned to the FOOT of the sidebar rather than merely
        placed after the live ones. With three tasks there is no difference; with
        three tasks and a tall window there is nothing but difference, and "at
        the bottom" is what was asked for.
      */}
      {bottom.length === 0 ? null : (
        <div className="sh-rows-foot">
          {/*
            The heading is OUTSIDE the scroller, and that is the point of the
            split: a "DONE" that scrolls away leaves a list of finished tasks
            with nothing saying what they are. Everything under it scrolls once
            there are more than seven — long enough to read as a list, short
            enough that finished work never crowds out the live work above it.
          */}
          <ul className="sh-rows">{renderRow(bottom[0] as { key: string; row: TreeItem })}</ul>
          <ul className="sh-rows sh-rows-foot-scroll">{bottom.slice(1).map(renderRow)}</ul>
        </div>
      )}
    </section>
  );
}

/** A wire entry that is a rule rather than a verb. */
const isSeparator = (
  entry: TreeItemAction | TreeItemSeparator,
): entry is TreeItemSeparator => (entry as TreeItemSeparator).separator === true;

/**
 * A contributed action → a `Menu` entry.
 *
 * The one translation this file performs, and it is the same shape as
 * `markState` below: an extension writes a NAME and the shell resolves it
 * against its own set. An unknown glyph name renders no glyph rather than a
 * placeholder — the label is the thing to read, and a "missing icon" box would
 * make an extension's typo louder than its verb.
 */
function toMenuEntry(entry: TreeItemAction | TreeItemSeparator): MenuEntry {
  if (isSeparator(entry)) return { separator: true };
  const glyph = entry.icon === undefined ? undefined : ACTION_ICONS[entry.icon];
  return {
    id: entry.id,
    label: entry.label,
    ...(glyph === undefined ? {} : { icon: glyph }),
    ...(entry.danger === undefined ? {} : { danger: entry.danger }),
    ...(entry.shortcut === undefined ? {} : { shortcut: entry.shortcut }),
    ...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
  };
}

/**
 * The glyph names a contribution may ask for.
 *
 * An ALLOW-LIST, and small on purpose. Tabler ships ~5,700 icons; letting a
 * contribution name any of them would mean bundling the set, which is exactly
 * what `Icon`'s "take a component, never a name" rule exists to prevent — and
 * the tree-shaken subset is what keeps the renderer's bundle honest. It grows one
 * line at a time, with the contribution that needs the glyph, which is the same
 * rule a thirteenth primitive follows.
 *
 * FINDING, reported with this wave: `TreeItem.icon` — the ROW's glyph, declared
 * in the SDK since M3 — is still consumed by nothing. It would resolve through
 * this same table; it is left alone because the row's leading slot is occupied by
 * its `StatusDot` and swapping one for the other is a design decision, not a
 * wiring one.
 */
const ACTION_ICONS: Readonly<Record<string, ComponentType<TablerIconProps>>> = {
  check: IconCheck,
  eye: IconEye,
  archive: IconArchive,
  trash: IconTrash,
  plus: IconPlus,
  settings: IconSettings,
};

/**
 * The glyph for the control that raises an overlay view.
 *
 * Same allow-list, resolved here rather than in `app.tsx` so a contributed glyph
 * has ONE table however it reaches the screen. `plus` is the fallback because
 * the first raisable overlay was a composer — but a `+` is a promise to CREATE
 * something, and every overlay drawing one is how a settings form ended up
 * indistinguishable from the new-task button beside it.
 */
export function raiseIcon(name: string | undefined): ComponentType<TablerIconProps> {
  return (name === undefined ? undefined : ACTION_ICONS[name]) ?? IconPlus;
}

/**
 * A contribution's tint word → one of `StateMark`'s five states.
 *
 * The translation lives HERE, at the boundary, and that is the point of it. An
 * extension writes whatever vocabulary its own model uses (`tasks` says
 * `needs-you`, an agent says `blocked`, a future PR view will say `review`), and
 * the shipped `.sh-dot` accepted all of those as separate CSS selectors — four
 * spellings of one colour, which is how a rename became impossible. Reducing
 * them to a state once, in a function, means the primitive never learns any of
 * these words and a new spelling costs one line here.
 *
 * The word `tint` is now a misnomer and stays anyway: it is the SDK's published
 * field name (`TreeItem.tint`), and renaming a public field to match an internal
 * mapping is a breaking change to every extension for a spelling nobody sees.
 * What changed underneath is that it no longer selects a colour at all — it
 * selects a SHAPE, and the colour follows from that.
 *
 * Anything unrecognised is `resting` rather than an invented sixth state: a tint
 * the shell does not know is not an emergency, and a hollow ring is the mark that
 * claims nothing.
 */
const TINT_STATES: Readonly<Record<string, MarkState>> = {
  working: 'working',
  running: 'working',
  cobalt: 'working',
  accent: 'working',
  sky: 'working',
  'needs-you': 'waiting',
  blocked: 'waiting',
  review: 'waiting',
  hay: 'waiting',
  wool: 'waiting',
  // `needs-check` is a finished turn nobody has looked at, so it is YOUR MOVE —
  // a square, not a tick. `done` is the task itself finishing, which is the one
  // state that leaves the list.
  'needs-check': 'waiting',
  done: 'shipped',
  pasture: 'shipped',
  grass: 'shipped',
  error: 'failed',
  ember: 'failed',
  red: 'failed',
};

export function markState(tint: string | undefined): MarkState {
  return (tint === undefined ? undefined : TINT_STATES[tint]) ?? 'resting';
}

/**
 * A contributed component in the sidebar — §7b's in-proc React (ADR 0033).
 *
 * The sidebar's job shrinks to three things, each a refusal: resolve the
 * declared NAME against a static table (so a page never runs code the build did
 * not see), hand the component an `invoke` bound to *this view type* (so it
 * cannot name a caller — main attributes it to the contributing extension), and
 * draw an honest empty slot when the name resolves to nothing.
 */
export function ComponentView({
  view,
  bridge,
  onDone,
}: {
  view: ViewContributionDTO;
  bridge: ViewsApi | null;
  /** Called when the component reports it is finished. Overlays close on it. */
  onDone?: () => void;
}): React.JSX.Element {
  const Component = resolveExtensionUi(view.component);
  // Memoized so a contributed component's props are stable across the parent's
  // re-renders — a form that remounts on every render loses what the user has
  // typed, which is v1's `_ConditionalContent` lesson inside a page.
  const props = useMemo(
    () => ({
      invoke: async (command: string, args?: unknown) => {
        if (bridge === null) return { ok: false as const, error: { code: 'unavailable', message: 'no bridge' } };
        const result = await bridge.invoke(view.type, command, args);
        return result.ok ? { ok: true as const, value: result.value } : { ok: false as const, error: result.error };
      },
      done: () => onDone?.(),
    }),
    [bridge, view.type, onDone],
  );

  return (
    <section className="sh-side-view" data-view-type={view.type} data-view-kind="component">
      {/*
        `SectionLabel` renders a `<div>`, so the heading semantics the `<h2>`
        carried come back as ARIA rather than as an element. A `headingLevel`
        prop was the alternative and it would be a prop that exists to satisfy
        one call site — `role`/`aria-level` are props the component already
        spreads, and they say exactly the same thing to the same readers.
      */}
      <RemoteLabel view={view} />
      <SectionLabel role="heading" aria-level={2}>
        {view.title ?? view.type}
      </SectionLabel>
      {Component === undefined ? (
        <p className="sh-side-missing" data-testid="view-missing">
          {view.extension} contributed “{view.component ?? 'nothing'}”, which this build has no UI for
        </p>
      ) : (
        <Component {...props} />
      )}
    </section>
  );
}
