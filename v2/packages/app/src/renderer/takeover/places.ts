import { fuzzyFilter } from '@shepherd/sdk';
import type { MarkState } from '@shepherd/ui';
import { TRIAGE_LABELS, triageOf, type TriageEntry } from './triage.ts';

/**
 * **Everywhere you can go, as one list.**
 *
 * The pull half of the router: Home raises what needs you, and this is how you
 * reach what does not. It opens on three PLACES before any task — Overview, New
 * task, Shells — because a switcher that lists only your work cannot take you to
 * the screen that lists your work, and the two most common jumps in a session
 * are "back to the flock" and "start something".
 *
 * The rows carry the same state marks and the same region words Home draws, and
 * that is the point: a task found by typing three letters should say exactly
 * what it said on the screen you left, or the switcher is a second, quieter
 * opinion about your morning.
 */

export type PlaceKind = 'home' | 'new' | 'shells' | 'task';

export interface PlaceItem {
  readonly id: string;
  readonly kind: PlaceKind;
  readonly name: string;
  /** The key that reaches it without the switcher, or the region it sits in. */
  readonly where: string;
  readonly mark?: MarkState;
  /** Present for a task: the entry it stands for. */
  readonly entry?: TriageEntry;
}

/**
 * The three standing places, then every row Home knows about.
 *
 * Shells is a place and never a task, so it appears once at the top rather than
 * as N rows at the bottom — the loose terminals are one destination with several
 * panes in it, which is what ADR 0047 made them.
 */
export function places(entries: readonly TriageEntry[]): readonly PlaceItem[] {
  const standing: readonly PlaceItem[] = [
    { id: 'place:home', kind: 'home', name: 'Overview', where: 'H' },
    { id: 'place:new', kind: 'new', name: 'New task', where: 'N' },
    /*
     * `⌘0`, not `0`. Both reach it, and the chord is the one that works while a
     * terminal has the keyboard — which on this screen it always does, since the
     * stage IS a shell. Advertising the bare key would be advertising the half
     * that dies the moment you are looking at what it took you to.
     */
    { id: 'place:shells', kind: 'shells', name: 'Shells', where: '⌘0' },
  ];
  const tasks = entries
    .filter((entry) => !entry.place)
    .map((entry) => ({
      id: entry.id,
      kind: 'task' as const,
      name: entry.label,
      where: TRIAGE_LABELS[triageOf(entry)].toLowerCase(),
      mark: entry.mark,
      entry,
    }));
  return [...standing, ...tasks];
}

/**
 * Type-to-filter, ranked the way the command palette ranks.
 *
 * `fuzzyFilter` rather than a `includes`, and it is the app's own — a view with
 * its own list to filter must rank it the way the palette does or the app has
 * two ideas about what a better match is. An empty query keeps the order above,
 * which puts the three places first: opening the switcher and pressing enter is
 * "go home", and that is the right default for a router.
 */
export function filterPlaces(items: readonly PlaceItem[], query: string): readonly PlaceItem[] {
  if (query.trim() === '') return items;
  return fuzzyFilter(query, items, (item) => item.name);
}
