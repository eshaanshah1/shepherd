import { describe, expect, it } from 'vitest';
import { readSessionRows } from './index.ts';

describe('readSessionRows', () => {
  it('ignores keys it does not know, so a newer kernel does not break it', () => {
    // THE case. `sessions.list` answers with pid, cwd, command, args, cols, rows
    // and foregroundProcess as well — a strict reader would reject every row and
    // the extension would quietly track nothing.
    const rows = readSessionRows([
      {
        id: 's1',
        pid: 42,
        cwd: '/tmp',
        command: '/bin/zsh',
        args: ['-l'],
        cols: 80,
        rows: 24,
        foregroundProcess: 'claude',
        hasForegroundProcess: true,
        viewing: false,
        somethingAddedNextYear: { nested: true },
      },
    ]);
    expect(rows).toEqual([{ id: 's1', hasForegroundProcess: true, viewing: false }]);
  });

  it('keeps the pane, which is what a consumer keys by', () => {
    // Not an unknown key any more. `tasks` can only key its mirror by pane — its
    // record holds a `pending-` session id for the first seconds after a spawn —
    // so this field is the difference between a task dot that works during a
    // spawn and one that does not.
    expect(readSessionRows([{ id: 's1', paneId: 'p1', hasForegroundProcess: false, viewing: true }])).toEqual([
      { id: 's1', paneId: 'p1', hasForegroundProcess: false, viewing: true },
    ]);
  });

  it('keeps a row with no pane rather than dropping it', () => {
    // A session not yet bound to a pane is a real state, briefly, and its agent
    // state is still worth tracking. Only the pane is missing.
    const [row] = readSessionRows([{ id: 's1' }]);
    expect(row).toEqual({ id: 's1', hasForegroundProcess: null, viewing: null });
  });

  it('ignores a non-string pane rather than trusting it', () => {
    const [row] = readSessionRows([{ id: 's1', paneId: 42 }]);
    expect(row?.paneId).toBeUndefined();
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
