import { describe, expect, it } from 'vitest';
import { ARCHIVE_TTL_MS, expired } from './expiry.ts';

const NOW = 1_800_000_000_000;
const archived = (id: string, ageMs: number): { id: string; lifecycle: string; archivedAt: number } => ({
  id,
  lifecycle: 'archived',
  archivedAt: NOW - ageMs,
});

describe('expired', () => {
  it('keeps an archive that is one tick short of thirty days', () => {
    expect(expired([archived('t1', ARCHIVE_TTL_MS - 1)], NOW)).toEqual([]);
  });

  it('takes one that has reached exactly thirty days', () => {
    expect(expired([archived('t1', ARCHIVE_TTL_MS)], NOW)).toEqual(['t1']);
  });

  it('never touches a task that is not archived, whatever its age', () => {
    // The only thing standing between a running task and a delete that removes
    // its worktrees is this predicate.
    expect(expired([{ id: 't1', lifecycle: 'running', archivedAt: 0 }], NOW)).toEqual([]);
  });

  it('never expires an archive with no date, rather than inventing one', () => {
    // Records written before `archivedAt` existed have no age. Falling back to
    // `createdAt` would date the shelving to when the WORK started and delete
    // the oldest tasks first — backwards from what the field means.
    expect(expired([{ id: 't1', lifecycle: 'archived' }], NOW)).toEqual([]);
  });

  it('is a WEEK, and the number is the thing to change', () => {
    // Pinned literally rather than through the constant it is testing: the TTL
    // moved from 30 days to 7 when an archive started carrying tabs and their
    // screens, and a test written in terms of the constant would have agreed
    // with any value at all.
    expect(ARCHIVE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
