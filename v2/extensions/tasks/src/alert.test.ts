import { describe, expect, it } from 'vitest';
import { alertFor } from './alert.ts';

const task = { id: 't1', title: 'Notification revamp' };

/**
 * The banner, as a table. Everything here is what the rail already says in its
 * own second line — the point of the change is that the two now agree.
 */
describe('alertFor', () => {
  it('names the task and says why it is blocked', () => {
    expect(alertFor({ task, state: 'blocked', reason: 'approve Bash' })).toEqual({
      title: 'Notification revamp',
      subtitle: 'Waiting on you',
      body: 'approve Bash',
      click: { task: 't1', face: 'agents' },
      actions: [
        { label: 'Open', goto: { task: 't1', face: 'agents' } },
        { label: 'Later today', command: 'tasks.snooze', args: { task: 't1', until: 'today' } },
      ],
    });
  });

  it('says what a finished turn changed, and offers both faces', () => {
    const spec = alertFor({
      task,
      state: 'needsCheck',
      stat: { files: 3, added: 42, removed: 7 },
      lastSaid: 'Done.',
    });
    expect(spec.subtitle).toBe('Turn finished');
    expect(spec.body).toBe('3 files · +42 −7');
    expect(spec.click).toEqual({ task: 't1', face: 'diff' });
    expect(spec.actions).toEqual([
      { label: 'Diff', goto: { task: 't1', face: 'diff' } },
      { label: 'Agents', goto: { task: 't1', face: 'agents' } },
    ]);
  });

  it('says one file, singular', () => {
    expect(alertFor({ task, state: 'needsCheck', stat: { files: 1, added: 2, removed: 0 } }).body).toBe(
      '1 file · +2 −0',
    );
  });

  it('falls back to the last thing the agent said when nothing changed', () => {
    const spec = alertFor({
      task,
      state: 'needsCheck',
      stat: { files: 0, added: 0, removed: 0 },
      lastSaid: 'Nothing to do.',
    });
    expect(spec.body).toBe('Nothing to do.');
    expect(spec.click).toEqual({ task: 't1', face: 'agents' });
  });

  it('never repeats the task name as its own summary', () => {
    // Measured against real transcripts: a short session's last assistant record
    // is often the title Claude Code minted for it, and a banner that says the
    // same words twice has said nothing.
    expect(alertFor({ task, state: 'needsCheck', lastSaid: 'notification revamp' }).body).toBe('finished a turn');
  });

  it('trims a long last line to something a banner can hold', () => {
    const body = alertFor({ task, state: 'needsCheck', lastSaid: 'x'.repeat(300) }).body;
    expect(body.length).toBeLessThanOrEqual(160);
    expect(body.endsWith('…')).toBe(true);
  });

  it('collapses a multi-line last word onto one line', () => {
    expect(alertFor({ task, state: 'needsCheck', lastSaid: 'Fixed it.\n\nTests pass.' }).body).toBe(
      'Fixed it. Tests pass.',
    );
  });

  it('carries the error, and one way back in', () => {
    const spec = alertFor({ task, state: 'error', reason: 'API error' });
    expect(spec.subtitle).toBe('Turn failed');
    expect(spec.body).toBe('API error');
    expect(spec.actions).toEqual([{ label: 'Open', goto: { task: 't1', face: 'agents' } }]);
  });

  it('says something rather than nothing when it was told nothing at all', () => {
    expect(alertFor({ task, state: 'blocked' }).body).toBe('waiting on you');
  });
});
