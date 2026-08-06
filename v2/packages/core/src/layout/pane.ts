import type { PaneID } from '@shepherd/sdk';
import { newPaneId, type RandomId } from '../identity.ts';

/**
 * A leaf of the layout tree — one terminal view, one session.
 *
 * Deliberately narrow. v1's `Pane` accumulated agent state, a stowing kind, a
 * provisioning flag and a remote ref, and every one of them was a field the
 * persistence layer then had to remember NOT to write. Here the rule is
 * structural: **a pane carries what the layout needs and what survives a
 * relaunch, and nothing else.** Anything an extension owns (agent state,
 * attention, tasks) hangs off the pane id in that extension's own store — which
 * is the whole point of M1's registry and is why the field never comes back.
 *
 * Of the four fields, two persist (`userTitle`, `cwd`) and two do not:
 * `title` is whatever the running program set by OSC, and `initialCommand` is
 * typed into the pty once on mount. `serialize.ts` is where that is enforced.
 */
export interface Pane {
  readonly id: PaneID;
  /** The OSC title the running program set. Live only — never persisted. */
  readonly title: string;
  /** A name the user typed. Beats the OSC title. Persisted. */
  readonly userTitle: string | null;
  /** Last-known working directory. Persisted — a restored pane opens here. */
  readonly cwd: string | null;
  /** Typed into the pty once on mount. Transient; never persisted. */
  readonly initialCommand: string | null;
}

export interface PaneInit {
  id?: PaneID;
  title?: string;
  userTitle?: string | null;
  cwd?: string | null;
  initialCommand?: string | null;
}

export function makePane(init: PaneInit = {}, random?: RandomId): Pane {
  return {
    id: init.id ?? newPaneId(random),
    title: init.title ?? '',
    userTitle: init.userTitle ?? null,
    cwd: init.cwd ?? null,
    initialCommand: init.initialCommand ?? null,
  };
}

/**
 * What the sidebar and the tab strip show: the user's name, else the program's
 * own title, else a two-component tail of the cwd.
 *
 * `home` is a parameter, not `os.homedir()`. That single call was the only line
 * of v1's SplitTree.swift that touched the platform, and the reason the file
 * could not be tested without Foundation.
 */
export function displayTitle(pane: Pane, home: string): string {
  if (pane.userTitle !== null && pane.userTitle !== '') return pane.userTitle;
  if (pane.title !== '') return pane.title;
  return cwdName(pane.cwd, home) ?? 'Terminal';
}

function cwdName(cwd: string | null, home: string): string | null {
  if (cwd === null || cwd === '') return null;
  if (cwd === home) return '~';
  const last = basename(cwd);
  const parent = dirname(cwd);
  if (parent === home) return `~/${last}`;
  const parentName = basename(parent);
  return parentName === '' || parentName === '/' ? last : `${parentName}/${last}`;
}

// Path splitting by hand rather than through node:path — core is process- and
// platform-agnostic, and these are posix paths from a posix pty either way.
function basename(path: string): string {
  const trimmed = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf('/');
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

function dirname(path: string): string {
  const trimmed = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf('/');
  if (cut < 0) return '';
  return cut === 0 ? '/' : trimmed.slice(0, cut);
}
