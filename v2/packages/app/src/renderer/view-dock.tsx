import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import { IconArchive, IconEye, IconTrash } from '@tabler/icons-react';
import type { IconProps as TablerIconProps } from '@tabler/icons-react';
import type { TreeItem, TreeItemAction, TreeItemSeparator } from '@shepherd/sdk';
import { Menu, Row, SectionLabel, StatusDot, type MenuEntry, type StatusRole } from '@shepherd/ui';
import type { ViewContributionDTO, ViewsApi } from '../shared/index.ts';
import { resolveExtensionUi } from './extension-ui.ts';

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

export function ViewDock({
  views: bridge,
  actions,
}: {
  views: ViewsApi | null;
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
  const [selected, setSelected] = useState<string | null>(null);

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

  return (
    <nav className="sh-side" data-testid="view-dock">
      {actions === undefined ? null : <div className="sh-side-head">{actions}</div>}
      <div className="sh-side-scroll">
        {docked.map((view) =>
          view.kind === 'component' ? (
            <ComponentView key={view.type} view={view} bridge={bridge} />
          ) : (
            <TreeView
              key={view.type}
              view={view}
              rows={rows[view.type] ?? []}
              bridge={bridge}
              selected={selected}
              onSelect={setSelected}
            />
          ),
        )}
      </div>
    </nav>
  );
}

/** A contributed tree — P6's kind, drawn by the sidebar itself. */
function TreeView({
  view,
  rows,
  bridge,
  selected,
  onSelect,
}: {
  view: ViewContributionDTO;
  rows: readonly TreeItem[];
  bridge: ViewsApi | null;
  selected: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  /*
   * A heading earns its line only when it separates something FROM something.
   * One group is the whole list, and "WORKING · 1" over a single row is a
   * label for a distinction that does not exist yet — it appears as soon as a
   * second group does, which is when the list actually needs reading.
   */
  const groups = rows.filter((row) => row.section === true).length;
  const shown = groups > 1 ? rows : rows.filter((row) => row.section !== true);

  return (
    <section className="sh-side-view" data-view-type={view.type}>
      {shown.length === 0 ? null : <ul className="sh-rows">
        {shown.map((row) => {
          if (row.section === true) {
            // A heading, not a row: `SectionLabel` draws the uppercase
            // micro-label, the `·` before the count and the rule to the edge.
            // Deliberately not a button — a group that looked clickable and did
            // nothing is the affordance lie this field exists to avoid.
            return (
              <li key={row.id}>
                <SectionLabel data-testid="view-group" {...(row.description === undefined ? {} : { count: row.description })}>
                  {row.label}
                </SectionLabel>
              </li>
            );
          }

          const activate = (): void => {
            onSelect(row.id);
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
            void bridge?.activate(view.type, {
              id: chosen.id,
              ...(chosen.args === undefined ? {} : { args: chosen.args }),
            });
          };

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
                selected={selected === row.id}
                data-testid="view-row"
                data-row-id={row.id}
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
                leading={
                  /*
                    The dot IS the status, and it takes a ROLE — never a colour
                    and never the extension's own tint spelling. A coloured dot
                    beside the word RUNNING says one thing twice and gives the row
                    a third column to align; v1 signalled state with the dot's
                    colour alone, deliberately. The description stays as the row's
                    tooltip, so the word is a hover away rather than gone — and
                    `StatusDot` also carries it for a screen reader, which the
                    bare `aria-hidden` span never did.
                  */
                  <StatusDot role={statusRole(row.tint)} />
                }
              >
                {row.label}
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
            <li key={row.id}>
              {declared.length === 0 ? (
                rowElement
              ) : (
                <Menu items={declared.map(toMenuEntry)} onSelect={runAction}>
                  {rowElement}
                </Menu>
              )}
            </li>
          );
        })}
      </ul>}
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
 * `statusRole` below: an extension writes a NAME and the shell resolves it
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
  eye: IconEye,
  archive: IconArchive,
  trash: IconTrash,
};

/**
 * A contribution's tint word → one of `StatusDot`'s five roles.
 *
 * The translation lives HERE, at the boundary, and that is the point of it. An
 * extension writes whatever vocabulary its own model uses (`tasks` says
 * `needs-you`, an agent says `blocked`, a future PR view will say `review`), and
 * the shipped `.sh-dot` accepted all of those as separate CSS selectors — four
 * spellings of one colour, which is how a rename became impossible. Reducing
 * them to a role once, in a function, means the primitive never learns any of
 * these words and a new spelling costs one line here.
 *
 * Anything unrecognised is `idle` rather than an invented sixth state: a tint the
 * shell does not know is not an emergency, and rule 3 says a saturated colour
 * always means something specific.
 */
const TINT_ROLES: Readonly<Record<string, StatusRole>> = {
  working: 'working',
  running: 'working',
  cobalt: 'working',
  accent: 'working',
  'needs-you': 'attention',
  blocked: 'attention',
  review: 'attention',
  hay: 'attention',
  done: 'success',
  'needs-check': 'success',
  pasture: 'success',
  error: 'danger',
  ember: 'danger',
};

export function statusRole(tint: string | undefined): StatusRole {
  return (tint === undefined ? undefined : TINT_ROLES[tint]) ?? 'idle';
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
