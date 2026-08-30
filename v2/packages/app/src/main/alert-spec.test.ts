import { describe, expect, it } from 'vitest';
import { resolveAlert } from './alert-spec.ts';

/**
 * The fallbacks matter more than the happy path: every one of them is a banner
 * the user would otherwise not get, for a reason that is nobody's fault (an
 * extension disabled, a session on no task, a describer that threw).
 */
describe('resolveAlert', () => {
  it('reads a described spec', () => {
    expect(
      resolveAlert({ title: 'Revamp', subtitle: 'Turn finished', body: '3 files' }, { state: 'needsCheck' }),
    ).toEqual({ title: 'Revamp', subtitle: 'Turn finished', body: '3 files' });
  });

  it('answers the old wording when nothing described it', () => {
    expect(resolveAlert(null, { state: 'blocked', reason: 'approve Bash' })).toEqual({
      title: 'Waiting on you',
      body: 'approve Bash',
    });
  });

  it('answers the old wording for a spec with no title', () => {
    expect(resolveAlert({ body: 'x' }, { state: 'error' })).toEqual({ title: 'Turn failed', body: 'error' });
  });

  it('falls back to the state word when there is no reason to give', () => {
    expect(resolveAlert(undefined, { state: 'needsCheck' })).toEqual({
      title: 'Turn finished',
      body: 'needsCheck',
    });
  });

  it('drops an action it cannot read rather than the whole spec', () => {
    const spec = resolveAlert(
      { title: 'Revamp', body: 'x', actions: [{ label: 'Diff', goto: { task: 't1' } }, { label: 'broken' }] },
      { state: 'needsCheck' },
    );
    expect(spec.actions).toEqual([{ label: 'Diff', goto: { task: 't1' } }]);
  });

  it('keeps a verb action whole, arguments and all', () => {
    const spec = resolveAlert(
      {
        title: 'Revamp',
        body: 'x',
        actions: [{ label: 'Later today', command: 'tasks.snooze', args: { task: 't1', until: 'today' } }],
      },
      { state: 'blocked' },
    );
    expect(spec.actions).toEqual([
      { label: 'Later today', command: 'tasks.snooze', args: { task: 't1', until: 'today' } },
    ]);
  });

  it('keeps at most two actions', () => {
    const spec = resolveAlert(
      {
        title: 'Revamp',
        body: 'x',
        actions: [
          { label: 'One', goto: { task: 't1' } },
          { label: 'Two', goto: { task: 't1' } },
          { label: 'Three', goto: { task: 't1' } },
        ],
      },
      { state: 'needsCheck' },
    );
    expect(spec.actions).toHaveLength(2);
  });

  it('drops a click that names no task', () => {
    expect(resolveAlert({ title: 'Revamp', body: 'x', click: {} }, { state: 'needsCheck' }).click).toBeUndefined();
  });
});
