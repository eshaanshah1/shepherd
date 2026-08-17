import type { TaskSubject } from './sync.ts';
import { readAgents, type TaskAgent } from './model/agent-pick.ts';

/**
 * What `tasks.list` answers, read rather than cast.
 *
 * `ok` says a call succeeded, never that a value has a shape — and this one
 * crossed an IPC port from an extension this code has never seen. The rule is
 * the codebase's (`CLAUDE.md`: "answers from a command are `unknown`, and a cast
 * is not a check"); what it buys here is that a `tasks` that grows a field, or
 * one record that fails to read on the far side, costs this extension nothing.
 *
 * A task with no id or no root is DROPPED rather than defaulted. Both are
 * identifiers — the root is where the worktrees whose branches are queried live
 * — and an invented one would send a query about somebody else's branch.
 */
export interface ListedTask extends TaskSubject {
  readonly title: string;
  /**
   * The PANE GROUP the task's tabs live in.
   *
   * Reported by `tasks` rather than derived here, and that is the point: the
   * `task:<id>` form is that extension's convention, derived in one place on
   * purpose, and a second writer of it is a tab that opens in a group of its
   * own instead of in the task. Deliberately NOT `tasks.list`'s `root`, which is
   * a DIRECTORY on disk under a confusingly similar name.
   */
  readonly group: string | null;
  /**
   * The agents this task is running — who a hand-off can go to.
   *
   * A CLAIM, not a fact: a task's record outlives the ptys it names (ADR 0036),
   * so liveness is checked against `sessions.list` rather than believed from
   * here. `pickAgent` takes both for exactly that reason.
   */
  readonly agents: readonly TaskAgent[];
}

export function readTasks(value: unknown): readonly ListedTask[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ListedTask[] => {
    if (!isRecord(entry)) return [];
    const id = str(entry['id']);
    const slug = str(entry['slug']);
    const root = str(entry['root']);
    if (id === undefined || slug === undefined || root === undefined) return [];
    return [
      {
        id,
        // The DIRECTORY the worktrees sit under, not the pane group (`group`
        // below) — `tasks.list` reports both under confusingly similar names.
        root,
        title: str(entry['title']) ?? slug,
        shipped: entry['lifecycle'] === 'archived',
        repos: readRepos(entry['repos']),
        group: str(entry['group']) ?? null,
        agents: readAgents(entry['sessions']),
      },
    ];
  });
}

/**
 * A repo needs both halves or it is useless: the path is where `git remote` is
 * asked, and the name is how a PR is joined back to the checkout it came from.
 */
function readRepos(value: unknown): readonly { readonly path: string; readonly name: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const path = str(entry['path']);
    const name = str(entry['name']);
    return path === undefined || name === undefined ? [] : [{ path, name }];
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

// ------------------------------------------------------------- layout answers

/** One root, as `layout.listRoots` reports it — the part this extension reads. */
export interface ListedRoot {
  readonly root: string;
  readonly group: string;
  /** Every view type mounted in it, from the serialized tree. */
  readonly viewTypes: readonly string[];
}

export function readRoots(value: unknown): readonly ListedRoot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ListedRoot[] => {
    if (!isRecord(entry)) return [];
    const root = str(entry['root']);
    if (root === undefined) return [];
    return [{ root, group: str(entry['group']) ?? root, viewTypes: viewTypesIn(entry['tree']) }];
  });
}

/**
 * Which contributed views a persisted tree holds.
 *
 * This is how "does this task already have a review tab" is answered without
 * this extension keeping its own record of the panes it opened — a record that
 * would be wrong the moment a user closed one, and wrong across a relaunch. The
 * layout is the authority on what is open; ask it.
 */
function viewTypesIn(node: unknown): readonly string[] {
  if (!isRecord(node)) return [];
  if (node['kind'] === 'leaf') {
    const pane = node['pane'];
    if (!isRecord(pane)) return [];
    const view = pane['view'];
    if (!isRecord(view)) return [];
    const type = str(view['type']);
    return type === undefined ? [] : [type];
  }
  if (node['kind'] === 'split') return [...viewTypesIn(node['first']), ...viewTypesIn(node['second'])];
  return [];
}

/**
 * Each live session's pane title, from `layout.listRoots`.
 *
 * A pane's name is a LAYOUT fact — the user typed it, or the program set it by
 * OSC — so it is read from the layout rather than reconstructed. It is what
 * makes an agent picker readable: two agents in one repo have the same repo and
 * the same branch, and their pane titles are the only thing that differs.
 *
 * Yielded as pairs rather than a map so the caller decides what to do with a
 * duplicate — which cannot happen (a session is on one pane) but would be a
 * silent overwrite if it did.
 */
export function readPaneTitles(value: unknown): readonly (readonly [string, string])[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((root): (readonly [string, string])[] => {
    if (!isRecord(root)) return [];
    const panes = root['panes'];
    if (!Array.isArray(panes)) return [];
    return panes.flatMap((pane): (readonly [string, string])[] => {
      if (!isRecord(pane)) return [];
      const session = str(pane['session']);
      const title = str(pane['userTitle']);
      return session === undefined || title === undefined ? [] : [[session, title] as const];
    });
  });
}
