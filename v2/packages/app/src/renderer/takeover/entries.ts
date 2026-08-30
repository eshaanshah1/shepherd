import { useEffect, useMemo, useState } from 'react';
import type { TreeItem } from '@shepherd/sdk';
import { HOME_ROOT_ID, type ViewContributionDTO, type ViewsApi } from '../../shared/index.ts';
import { markState } from '../view-dock.tsx';
import { readRowFacts } from './row-facts.ts';
import type { TriageEntry } from './triage.ts';

/**
 * Every contributed tree's rows, flattened into what the triage screen draws.
 *
 * The takeover reads the SAME source the dock does — `views.children` over every
 * `kind: 'tree'` contribution — rather than asking `tasks` for its list. That is
 * not politeness: the shell has no business naming an extension, and reading the
 * view mechanism is what makes `Shells` and `Needs you` two regions of one
 * screen rather than two hardcoded lists. Any tree that arrives later lands in
 * the triage automatically, which is the promise ADR 0031 makes.
 *
 * Two kinds of row are dropped on the way through, and both for the same reason
 * — they are the DOCK's furniture and this surface supplies its own:
 *
 *   - a `section` heading, because the takeover's regions are the takeover's;
 *   - a `quiet` control (`… +28`), because Home has no truncation to expand.
 */
export function useTriageEntries(options: {
  readonly bridge: ViewsApi | null;
  /** The layout's own answer for which group a root is a tab of. */
  readonly groupOfRoot: (root: string) => string;
}): readonly TriageEntry[] {
  const { bridge, groupOfRoot } = options;
  const [views, setViews] = useState<readonly ViewContributionDTO[]>([]);
  const [rows, setRows] = useState<Readonly<Record<string, readonly TreeItem[]>>>({});

  useEffect(() => {
    if (bridge === null) return;
    let live = true;
    const read = async (): Promise<void> => {
      const listed = await bridge.list();
      if (!listed.ok || !live) return;
      setViews(listed.value);
      for (const view of listed.value) {
        if (view.kind !== 'tree') continue;
        const children = await bridge.children(view.type);
        if (!children.ok || !live) continue;
        setRows((current) => ({ ...current, [view.type]: children.value }));
      }
    };
    void read();
    /*
     * A nudge, then a whole re-read — never a push of data. The LIST is re-read
     * too, because an extension activates after the window loads and the list
     * taken on mount predates every contribution it makes.
     */
    const off = bridge.onChanged(() => void read());
    return () => {
      live = false;
      off();
    };
  }, [bridge]);

  return useMemo(() => {
    const out: TriageEntry[] = [];
    for (const view of views) {
      if (view.kind !== 'tree') continue;
      for (const row of rows[view.type] ?? []) {
        if (row.section === true || row.quiet === true) continue;
        const facts = readRowFacts(row.data);
        out.push({
          id: `${view.type}:${row.id}`,
          rowId: row.id,
          label: row.label,
          ...(row.description === undefined ? {} : { description: row.description }),
          /*
           * The row's own `mark` beats the tint it was drawn with.
           *
           * `tint` is a word from the extension's vocabulary that the shell maps
           * (`markState`); a `mark` in the facts is the extension saying the
           * shape outright. A card that has both means them to agree, and where
           * they do not the more specific one is the one that was chosen.
           */
          mark: facts.mark ?? markState(row.tint),
          /*
           * A PLACE, decided structurally rather than believed.
           *
           * A loose terminal is a root in the home group (ADR 0047), and that is
           * a fact about the LAYOUT — which is the shell's own. Reading a flag
           * off the row would let any extension put itself in `Shells`, and
           * reading the mark would put a shell with an agent in it into
           * `Needs you`.
           */
          place: row.root !== undefined && groupOfRoot(row.root) === HOME_ROOT_ID,
          ...(row.root === undefined ? {} : { root: row.root }),
          facts,
          viewType: view.type,
          ...(row.command === undefined ? {} : { command: row.command }),
          ...(row.primaryAction === undefined
            ? {}
            : {
                primaryAction: {
                  id: row.primaryAction.id,
                  label: row.primaryAction.label,
                  args: row.primaryAction.args,
                },
              }),
        });
      }
    }
    return out;
  }, [views, rows, groupOfRoot]);
}
