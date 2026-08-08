import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TreeItem } from '@shepherd/sdk';
import type { ViewContributionDTO, ViewsApi } from '../shared/index.ts';
import { resolveExtensionUi } from './extension-ui.ts';

/**
 * The left dock — the first place an extension's own UI appears on screen.
 *
 * It knows **no extension**. It asks main which views exist, asks for each one's
 * rows, and draws them; a task tree, a Slack channel list and a GitHub PR list
 * are the same code path here. That is the whole point of M3's view mechanism,
 * and the test of it is that adding `tasks` to this app needs no change to this
 * file (sketch §2b: if a task view needs a special case in the core, the model
 * is wrong).
 *
 * Two things it deliberately does not do. It does not subscribe to a bus topic —
 * it cannot name one, which is what the agent relay's allow-list was protecting.
 * And it does not decide who a row's command runs as: it reports "this row was
 * clicked" and main attributes it to the contributing extension (D14).
 */

export function ViewDock({ views: bridge }: { views: ViewsApi | null }): React.JSX.Element | null {
  const [views, setViews] = useState<readonly ViewContributionDTO[]>([]);
  const [rows, setRows] = useState<Readonly<Record<string, readonly TreeItem[]>>>({});

  // Handed in, never read off the global: `main.tsx` is the ONE file that knows
  // the bridge is a global, and every other component takes what it needs as a
  // prop. `null` is a state (no bridge), not a crash — the same shape the rest
  // of the shell already uses.

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
    void (async () => {
      const listed = await bridge.list();
      if (!listed.ok) return;
      setViews(listed.value);
      // Only a tree has rows to ask for. A component owns what it shows.
      for (const view of listed.value) if (view.kind === 'tree') await refresh(view.type);
    })();
    // A NUDGE arrives, and the renderer re-reads. The data is never pushed, so a
    // chatty extension cannot flood this and nothing draws a snapshot main did
    // not ask for.
    // Re-read the LIST too, not just the rows. An extension activates after the
    // window has loaded, so the list this component saw on mount is a snapshot
    // from before any contribution existed; refreshing only known types is how
    // a registered view stays invisible forever.
    return bridge.onChanged(() => {
      void (async () => {
        const listed = await bridge.list();
        if (!listed.ok) return;
        setViews(listed.value);
        // Only a tree has rows to ask for. A component owns what it shows.
        for (const view of listed.value) if (view.kind === 'tree') await refresh(view.type);
      })();
    });
  }, [bridge, refresh]);

  if (views.length === 0) return null;

  return (
    <aside className="sh-dock" data-testid="view-dock">
      {views.map((view) =>
        view.kind === 'component' ? (
          <ComponentView key={view.type} view={view} bridge={bridge} />
        ) : (
          <TreeView key={view.type} view={view} rows={rows[view.type] ?? []} bridge={bridge} />
        ),
      )}
    </aside>
  );
}

/** A contributed tree — P6's kind, drawn by the dock itself. */
function TreeView({
  view,
  rows,
  bridge,
}: {
  view: ViewContributionDTO;
  rows: readonly TreeItem[];
  bridge: ViewsApi | null;
}): React.JSX.Element {
  return (
    <section className="sh-dock-view" data-view-type={view.type}>
      <h2 className="sh-dock-title">{view.type}</h2>
      <ul className="sh-dock-rows">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className="sh-dock-row"
              data-testid="view-row"
              data-row-id={row.id}
              // A token name, resolved here. An extension never sends a raw
              // colour, so a contribution cannot break the theme.
              data-tint={row.tint ?? 'none'}
              disabled={row.command === undefined}
              onClick={() => {
                if (row.command !== undefined) void bridge?.activate(view.type, row.command);
              }}
            >
              <span className="sh-dock-label">{row.label}</span>
              {row.description !== undefined && <span className="sh-dock-desc">{row.description}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A contributed component — §7b's in-proc React, drawn by the extension itself.
 *
 * The dock's job shrinks to three things here, and each is a refusal: it
 * resolves the declared NAME against a static table (so a page never runs code
 * the build did not see), it hands the component an `invoke` bound to *this
 * view type* (so the component cannot name a caller, and main attributes the
 * call to the contributing extension — D14), and it draws an honest empty slot
 * when the name resolves to nothing, rather than pretending the view is there.
 */
function ComponentView({
  view,
  bridge,
}: {
  view: ViewContributionDTO;
  bridge: ViewsApi | null;
}): React.JSX.Element {
  const Component = resolveExtensionUi(view.component);
  // Memoized so a contributed component's props are stable across the dock's
  // own re-renders — a form that remounts on every parent render loses what the
  // user has typed, which is v1's `_ConditionalContent` lesson in a page.
  const props = useMemo(
    () => ({
      invoke: async (command: string, args?: unknown) => {
        if (bridge === null) return { ok: false as const, error: { code: 'unavailable', message: 'no bridge' } };
        const result = await bridge.invoke(view.type, command, args);
        return result.ok ? { ok: true as const, value: result.value } : { ok: false as const, error: result.error };
      },
    }),
    [bridge, view.type],
  );

  return (
    <section className="sh-dock-view" data-view-type={view.type} data-view-kind="component">
      {Component === undefined ? (
        <p className="sh-dock-missing" data-testid="view-missing">
          {view.extension} contributed “{view.component ?? 'nothing'}”, which this build has no UI for
        </p>
      ) : (
        <Component {...props} />
      )}
    </section>
  );
}
