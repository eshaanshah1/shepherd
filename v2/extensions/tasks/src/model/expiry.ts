/**
 * How long an archived task keeps its snapshot.
 *
 * **30 literal days**, not calendar months: a month is a variable length and a
 * user asking "does this still exist" is counting days. v1 used 90 for the same
 * mechanism and it was too long to be a real garbage collector — an archive
 * nobody can name is disk nobody can free.
 */
export const ARCHIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ExpiryCandidate {
  readonly id: string;
  readonly lifecycle: string;
  readonly archivedAt?: number;
}

/**
 * Which archived tasks have run out, at `now`.
 *
 * Pure, because the decision is the whole of the danger: this list is fed
 * straight into a delete that removes worktrees and a record. An archived task
 * with NO `archivedAt` is deliberately never expired — records written before
 * the field existed have no age, and guessing one (say, `createdAt`) would date
 * the shelving to when the work STARTED and delete the oldest tasks first,
 * which is exactly backwards from what the field means.
 */
export function expired(tasks: readonly ExpiryCandidate[], now: number): readonly string[] {
  return tasks
    .filter(
      (task) =>
        task.lifecycle === 'archived' &&
        task.archivedAt !== undefined &&
        now - task.archivedAt >= ARCHIVE_TTL_MS,
    )
    .map((task) => task.id);
}
