/**
 * **Where you are, and how you got here.**
 *
 * The takeover has no rail and no tab strip, so `esc` is the only way back and
 * it has to be a real answer rather than "go to Home". Pressing `esc` from a
 * task you reached from a toast should return you to what you were reading, not
 * to the triage screen — and the only structure that can say that is a stack.
 *
 * Four rules, and each one is a case below:
 *
 *   - **`esc` pops.** From the bottom it stays on Home, because there is nowhere
 *     under Home and a keystroke that empties the window is a keystroke people
 *     stop pressing.
 *   - **`H` clears.** Home is not "one more step back" — it is the top of the
 *     app, and arriving there with six frames still behind you makes the next
 *     `esc` teleport.
 *   - **Going where you already are does not stack.** Otherwise a toast for the
 *     task on screen buries the place you came from under a copy of itself.
 *   - **A face is not a place.** `1`–`4` swap what you are reading INSIDE a task;
 *     `esc` from Diff leaves the task, it does not go back to Agents. The tabs
 *     are one subject seen four ways, and a history of them would make `esc`
 *     mean two different things depending on how you got to the tab you are on.
 */

/** The four ways to read one task. */
export type Face = 'agents' | 'diff' | 'intent' | 'files';

export const FACES: readonly Face[] = ['agents', 'diff', 'intent', 'files'];

export const FACE_LABELS: Readonly<Record<Face, string>> = {
  agents: 'Agents',
  diff: 'Diff',
  intent: 'Intent',
  files: 'Files',
};

export type Place =
  | { readonly kind: 'home' }
  | { readonly kind: 'shells' }
  | { readonly kind: 'task'; readonly id: string; readonly root: string; readonly face: Face };

export interface Nav {
  readonly at: Place;
  /** Oldest first. `esc` takes the last one. */
  readonly stack: readonly Place[];
}

export const HOME: Nav = { at: { kind: 'home' }, stack: [] };

/**
 * Two places are the SAME place when they stand for the same subject.
 *
 * The face is excluded on purpose — a toast raising the task you are already
 * reading on Diff must not stack a second frame just because it would have
 * opened on Agents.
 */
export function samePlace(a: Place, b: Place): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'task' && b.kind === 'task') return a.id === b.id;
  return true;
}

export function go(nav: Nav, place: Place): Nav {
  if (samePlace(nav.at, place)) {
    // Already here. Adopt the incoming face (a done task raised from a toast
    // still wants to open on what it changed) without touching the history.
    return { at: place, stack: nav.stack };
  }
  return { at: place, stack: [...nav.stack, nav.at] };
}

export function pop(nav: Nav): Nav {
  const previous = nav.stack.at(-1);
  if (previous === undefined) return { at: { kind: 'home' }, stack: [] };
  return { at: previous, stack: nav.stack.slice(0, -1) };
}

export function home(): Nav {
  return HOME;
}

/** `1`–`4`. Replaces, never pushes — a face is not a place. */
export function withFace(nav: Nav, face: Face): Nav {
  if (nav.at.kind !== 'task') return nav;
  return { at: { ...nav.at, face }, stack: nav.stack };
}

/**
 * The face a task OPENS on.
 *
 * A task with nothing running and something changed is a ship decision, and the
 * thing you have to look at to make it is the diff — so it opens there rather
 * than on a terminal with no agent in it. Everything else opens on its agents,
 * which is where the work is.
 */
export function openingFace(options: { readonly running: boolean; readonly changed: boolean }): Face {
  return !options.running && options.changed ? 'diff' : 'agents';
}

/** The task on screen, if the thing on screen is a task. */
export function currentTask(nav: Nav): { readonly id: string; readonly root: string; readonly face: Face } | null {
  return nav.at.kind === 'task' ? nav.at : null;
}
