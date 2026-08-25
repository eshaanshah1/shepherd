import { EDITOR_VIEWS } from './manifest.ts';

/**
 * What `layout.listRoots` answered, read rather than cast.
 *
 * `ok` says a call succeeded, never that a value has a shape, and this crossed
 * an IPC port. A row with no root is DROPPED rather than defaulted: a root is
 * an identifier, and an invented one would open a tab somewhere the user never
 * asked for.
 */
export interface ListedRoot {
  readonly root: string;
  /** The pane group it lives in — `task:<id>` for a task's tabs. */
  readonly group: string | undefined;
  /** The user is looking at this one. */
  readonly active: boolean;
  readonly focusedPane: string | undefined;
  readonly panes: readonly { readonly pane: string; readonly cwd: string | undefined }[];
  /** The directories this root's editor panes are open on, if any. */
  readonly editorRoots: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function readRoots(value: unknown): readonly ListedRoot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ListedRoot[] => {
    if (!isRecord(entry)) return [];
    const root = str(entry['root']);
    if (root === undefined) return [];
    const panes = Array.isArray(entry['panes'])
      ? entry['panes'].flatMap((leaf): { pane: string; cwd: string | undefined }[] => {
          if (!isRecord(leaf)) return [];
          const pane = str(leaf['pane']);
          return pane === undefined ? [] : [{ pane, cwd: str(leaf['cwd']) }];
        })
      : [];
    return [
      {
        root,
        group: str(entry['group']),
        active: entry['active'] === true,
        focusedPane: str(entry['focusedPane']),
        panes,
        editorRoots: editorRootsIn(entry['tree']),
      },
    ];
  });
}

/**
 * Which directories this root's editor panes are open on.
 *
 * The tree is `serializeNode`'s own format — the one the layout rebuilds from —
 * so walking it is reading the authority rather than a second description of
 * it. `github` does the same to answer "does this task already have a review
 * tab"; this one needs the `state` as well as the type, because two editor tabs
 * differ only by the directory they are rooted at.
 */
function editorRootsIn(node: unknown): readonly string[] {
  if (!isRecord(node)) return [];
  if (node['kind'] === 'leaf') {
    const pane = node['pane'];
    if (!isRecord(pane)) return [];
    const view = pane['view'];
    if (!isRecord(view) || view['type'] !== EDITOR_VIEWS.workspace) return [];
    const state = view['state'];
    if (!isRecord(state)) return [];
    const root = str(state['root']);
    return root === undefined ? [] : [root];
  }
  if (node['kind'] === 'split') {
    return [...editorRootsIn(node['first']), ...editorRootsIn(node['second'])];
  }
  return [];
}

/**
 * Where the user is, as a directory.
 *
 * The focused pane of the active root, and its cwd. `undefined` is a real
 * answer rather than a failure: a view pane has no cwd, so a tab holding only
 * contributed views genuinely cannot say where it is — and guessing would open
 * the tree on a directory nobody named.
 */
export function activeCwd(roots: readonly ListedRoot[]): string | undefined {
  const here = roots.find((root) => root.active);
  if (here === undefined) return undefined;
  return here.panes.find((pane) => pane.pane === here.focusedPane)?.cwd;
}

/** The pane group the user is in — `task:<id>` for a task's tab. */
export function activeGroup(roots: readonly ListedRoot[]): string | undefined {
  return roots.find((root) => root.active)?.group;
}

/** The root of the tab already open on this directory, if there is one. */
export function openEditorRoot(
  roots: readonly ListedRoot[],
  on: string,
): string | undefined {
  return roots.find((root) => root.editorRoots.includes(on))?.root;
}
