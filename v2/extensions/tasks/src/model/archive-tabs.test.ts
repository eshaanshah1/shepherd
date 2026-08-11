import { describe, expect, it } from 'vitest';
import { archiveTabsFrom, historyPath, type RootReading } from './archive-tabs.ts';

const root = (id: string, panes: RootReading['panes']): RootReading => ({
  root: id,
  tree: { kind: 'leaf', pane: { id: panes[0]?.pane ?? 'p1' } },
  focusedPane: panes[0]?.pane ?? null,
  panes,
});

const pane = (id: string, cwd: string | null = '/wt') => ({ pane: id, cwd, userTitle: null });

describe('archiveTabsFrom', () => {
  it('keeps one entry per root, in order, with its splits and cwds', () => {
    const tabs = archiveTabsFrom({
      roots: [root('task:t1', [pane('a')]), root('task:t1/tab-2', [pane('b', '/wt/api')])],
      sessions: [],
    });
    expect(tabs.map((tab) => tab.root)).toEqual(['task:t1', 'task:t1/tab-2']);
    expect(tabs[1]?.panes[0]?.cwd).toBe('/wt/api');
    expect(tabs[0]?.tree).toBeDefined();
  });

  it('carries a pane’s session identity UNREAD', () => {
    // D11: these come from the agent kind that captured them and go back
    // through the same seam. This function only has to keep them attached to
    // the right pane.
    const tabs = archiveTabsFrom({
      roots: [root('task:t1', [pane('a')])],
      sessions: [{ pane: 'a', sessionId: 's-1', kindId: 'some-vendor', resumeTarget: 'opaque-blob' }],
    });
    expect(tabs[0]?.panes[0]).toMatchObject({
      sessionId: 's-1',
      kindId: 'some-vendor',
      resumeTarget: 'opaque-blob',
    });
  });

  it('joins by PANE, so a session still carrying a pending id lands correctly', () => {
    // A task's record holds `pending-<clock>` for the first seconds of a spawn,
    // and only the pane is true in that window.
    const tabs = archiveTabsFrom({
      roots: [root('task:t1', [pane('a'), pane('b')])],
      sessions: [{ pane: 'b', sessionId: 'pending-123' }],
    });
    expect(tabs[0]?.panes[0]?.sessionId).toBeUndefined();
    expect(tabs[0]?.panes[1]?.sessionId).toBe('pending-123');
  });

  it('leaves a pane with no session unmarked rather than inventing one', () => {
    const tabs = archiveTabsFrom({ roots: [root('task:t1', [pane('a', null)])], sessions: [] });
    expect(tabs[0]?.panes[0]?.sessionId).toBeUndefined();
    expect(tabs[0]?.panes[0]?.history).toBeUndefined();
  });

  it('records where a captured screen went, for the panes that had one', () => {
    const tabs = archiveTabsFrom({
      roots: [root('task:t1', [pane('a'), pane('b')])],
      sessions: [{ pane: 'a', sessionId: 's-1' }],
      history: { a: 't1/task_t1/a.term' },
    });
    expect(tabs[0]?.panes[0]?.history).toBe('t1/task_t1/a.term');
    expect(tabs[0]?.panes[1]?.history).toBeUndefined();
  });

  it('has no tabs for a task whose group held nothing', () => {
    expect(archiveTabsFrom({ roots: [], sessions: [] })).toEqual([]);
  });
});

describe('historyPath', () => {
  it('is one file per pane, under the task', () => {
    expect(historyPath('t1', 'task:t1/tab-2', 'p9')).toBe('t1/task_t1_tab-2/p9.term');
  });

  it('never lets a segment escape the archive directory', () => {
    // Root ids contain `:` and `/` by construction, so a path built by
    // concatenation would write somewhere else entirely.
    const path = historyPath('../../etc', '../..', 'p1');
    expect(path).not.toContain('..');
    expect(path).not.toContain('/etc');
  });
});
