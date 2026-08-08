import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TreeItem } from '@shepherd/sdk';
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
  footer,
}: {
  views: ViewsApi | null;
  /** The keycap strip at the bottom. The shell's, not an extension's. */
  footer?: React.ReactNode;
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
  if (docked.length === 0 && footer === undefined) return null;

  return (
    <nav className="sh-side" data-testid="view-dock">
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
      {footer === undefined ? null : <div className="sh-side-foot">{footer}</div>}
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
  return (
    <section className="sh-side-view" data-view-type={view.type}>
      {rows.length === 0 ? null : <ul className="sh-rows">
        {rows.map((row) =>
          row.section === true ? (
            // A heading, not a row: uppercase micro-label with its count, and
            // deliberately not a button — a group that looked clickable and did
            // nothing is the affordance lie this field exists to avoid.
            <li key={row.id} className="sh-group" data-testid="view-group">
              <span className="sh-group-label">{row.label}</span>
              {row.description !== undefined && <span className="sh-group-count">{row.description}</span>}
            </li>
          ) : (
            <li key={row.id}>
              <button
                type="button"
                className={`sh-row${selected === row.id ? ' is-sel' : ''}`}
                data-testid="view-row"
                data-row-id={row.id}
                // A token name, resolved here. An extension never sends a raw
                // colour, so a contribution cannot break the theme.
                data-tint={row.tint ?? 'none'}
                onClick={() => {
                  onSelect(row.id);
                  if (row.command !== undefined) void bridge?.activate(view.type, row.command);
                }}
              >
                <span className="sh-dot" data-tint={row.tint ?? 'none'} aria-hidden="true" />
                <span className="sh-row-label">{row.label}</span>
                {row.description !== undefined && <span className="sh-row-word">{row.description}</span>}
              </button>
            </li>
          ),
        )}
      </ul>}
    </section>
  );
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
      <h2 className="sh-group">
        <span className="sh-group-label">{view.title ?? view.type}</span>
      </h2>
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
