import { describe, expect, it } from 'vitest';
import { readSessionRows } from './index.ts';

describe('readSessionRows', () => {
  it('ignores keys it does not know, so a newer kernel does not break it', () => {
    // THE case. `sessions.list` answers with pid, cwd, command, args, cols, rows,
    // paneId and foregroundProcess as well — a strict reader would reject every
    // row and the extension would quietly track nothing.
    const rows = readSessionRows([
      {
        id: 's1',
        pid: 42,
        cwd: '/tmp',
        command: '/bin/zsh',
        args: ['-l'],
        cols: 80,
        rows: 24,
        paneId: 'p1',
        foregroundProcess: 'claude',
        hasForegroundProcess: true,
        viewing: false,
        somethingAddedNextYear: { nested: true },
      },
    ]);
    expect(rows).toEqual([{ id: 's1', hasForegroundProcess: true, viewing: false }]);
  });

  it('reads null as "not known", and never as false', () => {
    const [row] = readSessionRows([{ id: 's1', hasForegroundProcess: null, viewing: null }]);
    expect(row?.hasForegroundProcess).toBeNull();
    expect(row?.viewing).toBeNull();
  });

  it('treats an absent or non-boolean field as not known', () => {
    const [row] = readSessionRows([{ id: 's1', hasForegroundProcess: 'yes' }]);
    expect(row?.hasForegroundProcess).toBeNull();
    expect(row?.viewing).toBeNull();
  });

  it('skips an unreadable row without costing the others', () => {
    const rows = readSessionRows([{ id: 's1' }, null, 7, { nope: true }, { id: 's2' }]);
    expect(rows.map((r) => r.id)).toEqual(['s1', 's2']);
  });

  it('answers nothing for anything that is not a list', () => {
    for (const junk of [undefined, null, {}, 'rows', 3]) expect(readSessionRows(junk)).toEqual([]);
  });
});
