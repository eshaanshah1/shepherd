import { describe, expect, it } from 'vitest';
import type { TranscriptHit } from '../manifest.ts';
import { hitsByTask, totalMatches } from './transcript-rollup.ts';

const hit = (dir: string, total: number): TranscriptHit => ({
  dir,
  sessionId: 'aaa',
  when: 0,
  total,
  matches: [{ source: 'user', text: 'x', at: [0, 1] }],
});

describe('totalMatches', () => {
  it('sums every session total, not the drawn matches', () => {
    expect(totalMatches([hit('/a', 4), hit('/b', 8)])).toBe(12);
  });

  it('is zero for no hits', () => {
    expect(totalMatches([])).toBe(0);
  });
});

describe('hitsByTask', () => {
  it('groups hits under the task whose dirs contain them', () => {
    const dirsOf = new Map([
      ['task-1', ['/w/one', '/w/one/api']],
      ['task-2', ['/w/two']],
    ]);
    const grouped = hitsByTask([hit('/w/one/api', 1), hit('/w/two', 2)], dirsOf);

    expect([...grouped.keys()]).toEqual(['task-1', 'task-2']);
    expect(grouped.get('task-1')).toHaveLength(1);
  });

  it('drops a hit no task claims rather than inventing a group', () => {
    const grouped = hitsByTask([hit('/w/gone', 1)], new Map([['task-1', ['/w/one']]]));
    expect(grouped.size).toBe(0);
  });

  it('gives one task every hit across its dirs', () => {
    const grouped = hitsByTask(
      [hit('/w/one', 1), hit('/w/one/api', 2)],
      new Map([['task-1', ['/w/one', '/w/one/api']]]),
    );
    expect(grouped.get('task-1')).toHaveLength(2);
  });

  it('gives a nested worktree to its own task, not the enclosing one', () => {
    const dirsOf = new Map([
      ['outer', ['/w']],
      ['inner', ['/w/one']],
    ]);
    const grouped = hitsByTask([hit('/w/one', 1)], dirsOf);

    expect(grouped.get('inner')).toHaveLength(1);
    expect(grouped.has('outer')).toBe(false);
  });

  it('does not claim a sibling that shares a name prefix', () => {
    const grouped = hitsByTask([hit('/w/one-2', 1)], new Map([['task-1', ['/w/one']]]));
    expect(grouped.size).toBe(0);
  });
});
