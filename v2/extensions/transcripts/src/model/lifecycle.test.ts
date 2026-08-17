import { describe, expect, it } from 'vitest';
import { lifecycleOf } from './lifecycle.ts';

const assistant = (message: Record<string, unknown>): unknown => ({
  type: 'assistant',
  uuid: 'a1',
  timestamp: '2026-08-01T10:00:00.000Z',
  message,
});

const TEXT = [{ type: 'text', text: 'x' }];
const TOOL = { type: 'tool_use', id: 't', name: 'Bash', input: {} };

describe('lifecycleOf', () => {
  it('completes on a terminal stop reason', () => {
    for (const reason of ['end_turn', 'max_tokens', 'stop_sequence', 'refusal']) {
      expect(lifecycleOf(assistant({ stop_reason: reason, content: TEXT }), 0)?.state).toBe(
        'completed',
      );
    }
  });

  it('does not complete on tool_use', () => {
    expect(lifecycleOf(assistant({ stop_reason: 'tool_use', content: [TOOL] }), 0)).toBeNull();
  });

  it('completes a row with content and no stop reason', () => {
    expect(lifecycleOf(assistant({ content: TEXT }), 0)?.state).toBe('completed');
    expect(lifecycleOf(assistant({ stop_reason: null, content: TEXT }), 0)?.state).toBe('completed');
  });

  /** The clause that keeps the spinner honest: a tool is still to run. */
  it('does NOT complete a no-stop-reason row that calls a tool', () => {
    expect(lifecycleOf(assistant({ content: [...TEXT, TOOL] }), 0)).toBeNull();
  });

  it('does not complete an empty no-stop-reason row', () => {
    expect(lifecycleOf(assistant({ content: [] }), 0)).toBeNull();
  });

  it('counts thinking as renderable content', () => {
    expect(lifecycleOf(assistant({ content: [{ type: 'thinking', thinking: 'hmm' }] }), 0)?.state).toBe(
      'completed',
    );
  });

  it('starts working on a real user turn', () => {
    const l = lifecycleOf({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } }, 0);
    expect(l?.state).toBe('working');
    expect(l?.turnId).toBe('u1');
  });

  it('ignores a tool-result user row, which continues a turn', () => {
    expect(
      lifecycleOf(
        {
          type: 'user',
          uuid: 'u2',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'o' }] },
        },
        0,
      ),
    ).toBeNull();
  });

  it('ignores harness noise, which would re-stick the spinner', () => {
    expect(
      lifecycleOf(
        { type: 'user', uuid: 'u3', message: { role: 'user', content: '<system-reminder>x</system-reminder>' } },
        0,
      ),
    ).toBeNull();
  });

  it('reads an interrupt', () => {
    const l = lifecycleOf(
      { type: 'user', uuid: 'u4', message: { role: 'user', content: '[Request interrupted by user]' } },
      0,
    );
    expect(l?.state).toBe('interrupted');
    expect(l?.turnId).toBe('u4');
  });

  it('says nothing about a record that is not a turn', () => {
    expect(lifecycleOf({ type: 'ai-title', aiTitle: 'x' }, 0)).toBeNull();
    expect(lifecycleOf(null, 0)).toBeNull();
  });
});
