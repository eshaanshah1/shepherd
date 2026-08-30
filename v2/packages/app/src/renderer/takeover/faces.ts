import type { ViewContributionDTO } from '../../shared/index.ts';
import { FACE_LABELS, FACES, type Face } from './nav.ts';

/**
 * **Which faces a task actually has.**
 *
 * `Agents` is always one, and it is the only one the shell owns: it is the
 * stage, which the takeover deliberately does not paint over. The other three
 * are CLAIMED — an extension declares `surface: 'face'` with a slot (ADR 0051)
 * and the tab exists because of that declaration, not because the shell knows
 * the name of a view that could fill it.
 *
 * The consequence is the reason it is built this way: a build without `github`
 * has no Diff tab. That is the honest failure. The alternative — the shell
 * resolving `diff` to `github.review` — is the shell having learned which
 * extension it hired, which is the same rule that keeps a vendor's name out of
 * `tasks` (D11) pointed at the other end of the app.
 *
 * A slot claimed twice keeps the FIRST claim. Two extensions both saying they
 * are the diff is a conflict the shell cannot resolve on merit, and picking the
 * last one would make the answer depend on activation order — which is exactly
 * the failure `head` was written to prevent one layer down.
 */

export interface FaceTab {
  readonly face: Face;
  readonly label: string;
  /**
   * The digit, `1`–`4`, in the order the tabs are drawn.
   *
   * The BINDING takes a modifier (`hint` below) and this does not, because two
   * things read it: the handler, which compares `event.key`, and the tab, which
   * prints `hint`.
   */
  readonly key: string;
  /**
   * What the tab PRINTS — `⌘1`, not `1`.
   *
   * A bare digit was the prototype's, and the prototype has no terminal in it.
   * Here the face where the work happens is `Agents`, an xterm has the keyboard
   * almost always, and a bare digit typed there belongs to the pty — so a tab
   * printing `1` was advertising a key that did nothing on the one face you are
   * usually looking at. It is the rule this app already enforces on every
   * contributed accelerator (`hasModifier`), applied to its own chrome.
   */
  readonly hint: string;
  /** The contributed view that fills it. Absent for `agents`, which is the stage. */
  readonly view?: ViewContributionDTO;
}

/** The slot a contribution claims, if it claims one. */
export function claimedSlot(view: ViewContributionDTO): Face | undefined {
  if (view.kind !== 'component' || view.surface !== 'face') return undefined;
  const slot = view.face?.slot;
  return FACES.find((candidate) => candidate === slot);
}

/** The nth tab's digit and the chord that is printed for it. */
const keyOf = (index: number): { key: string; hint: string } => ({
  key: String(index + 1),
  hint: `⌘${String(index + 1)}`,
});

export function faceTabs(views: readonly ViewContributionDTO[]): readonly FaceTab[] {
  const claims = new Map<Face, ViewContributionDTO>();
  for (const view of views) {
    const slot = claimedSlot(view);
    // First claim wins — see the note above on why not the last.
    if (slot !== undefined && !claims.has(slot)) claims.set(slot, view);
  }
  const tabs: FaceTab[] = [];
  for (const face of FACES) {
    if (face === 'agents') {
      tabs.push({ face, label: FACE_LABELS[face], ...keyOf(tabs.length) });
      continue;
    }
    const view = claims.get(face);
    if (view === undefined) continue;
    tabs.push({ face, label: view.title ?? FACE_LABELS[face], ...keyOf(tabs.length), view });
  }
  return tabs;
}

/**
 * The face a key press means, for the tabs actually on screen.
 *
 * The number is a POSITION, not a face: with no Diff tab, `⌘2` is Intent. A key
 * bound to a face that is not drawn would be a keystroke that appears to do
 * nothing, which is worse than one that moves you one tab along.
 *
 * Takes the bare digit, because that is what `event.key` carries whatever
 * modifier is held — the caller checks the modifier.
 */
export function faceForKey(tabs: readonly FaceTab[], key: string): Face | undefined {
  return tabs.find((tab) => tab.key === key)?.face;
}

/** The face to land on, when the one you asked for is not there. */
export function nearestFace(tabs: readonly FaceTab[], wanted: Face): Face {
  return tabs.some((tab) => tab.face === wanted) ? wanted : 'agents';
}
