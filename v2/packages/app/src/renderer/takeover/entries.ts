import { useEffect, useMemo, useState } from 'react';
import type { TreeItem } from '@shepherd/sdk';
import { HOME_ROOT_ID, type ViewContributionDTO, type ViewsApi } from '../../shared/index.ts';
import { markState } from '../view-dock.tsx';
import { readRowFacts } from './row-facts.ts';
import { triageOf, type TriageEntry, type TriageGroup } from './triage.ts';

/**
 * A region that is drawing a SUBSET, and the verb that finishes it.
 *
 * The tree's own `… +20 more` row, kept rather than drawn. Home has no button
 * here — it scrolls, so the control fires when the foot of the region reaches
 * the viewport and the rest of the record simply continues. That is the whole
 * repair: the cap decides how much loads before you ask, not how much exists.
 *
 * `group` is read from the row ABOVE it rather than from its id, because the id
 * is the extension's (`group:shipped:more`) and parsing one here would be the
 * shell learning an extension's vocabulary — the thing this file's own header
 * refuses. A truncation control belongs to the region it was drawn under, which
 * is a fact about position and therefore one the shell can see.
 */
export interface MoreControl {
  readonly id: string;
  readonly group: TriageGroup;
  readonly viewType: string;
  readonly command: { readonly id: string; readonly args?: unknown };
}

export interface TriageRead {
  readonly entries: readonly TriageEntry[];
  /** At most one per region; a region drawing everything contributes none. */
  readonly more: readonly MoreControl[];
}

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
 * A `section` heading is dropped on the way through — the takeover's regions are
 * the takeover's, and a tree's headings are the dock's furniture.
 *
 * A `quiet` control (`… +28`) is NOT. It used to be, on the reasoning that "Home
 * has no truncation to expand", and that was the bug: the truncation happens in
 * the extension, so Home inherited the cap and then threw away the only thing
 * that could lift it — eight shipped tasks and no way to reach the ninth, on the
 * one surface left after the rail. It comes back as a `MoreControl`, and the one
 * that `reveals` is the one Home can run for you.
 */
export function useTriageEntries(options: {
  readonly bridge: ViewsApi | null;
  /** The layout's own answer for which group a root is a tab of. */
  readonly groupOfRoot: (root: string) => string;
}): TriageRead {
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
    const more: MoreControl[] = [];
    for (const view of views) {
      if (view.kind !== 'tree') continue;
      /** The last row of this view, so a control can be attributed to its region. */
      let above: TriageEntry | undefined;
      for (const row of rows[view.type] ?? []) {
        if (row.section === true) continue;
        if (row.quiet === true) {
          if (row.reveals === true && row.command !== undefined && above !== undefined) {
            more.push({
              id: `${view.type}:${row.id}`,
              group: triageOf(above),
              viewType: view.type,
              command: { id: row.command.id, ...(row.command.args === undefined ? {} : { args: row.command.args }) },
            });
          }
          continue;
        }
        const facts = readRowFacts(row.data);
        const entry: TriageEntry = {
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
                  ...(row.primaryAction.leaves === undefined
                    ? {}
                    : { leaves: row.primaryAction.leaves }),
                },
              }),
        };
        out.push(entry);
        above = entry;
      }
    }
    return { entries: out, more };
  }, [views, rows, groupOfRoot]);
}
