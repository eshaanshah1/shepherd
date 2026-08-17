import { describe, expect, it } from 'vitest';
import { toMessage, usageOf } from './message.ts';

describe('toMessage', () => {
  it('reads a user turn', () => {
    const m = toMessage(
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        timestamp: '2026-08-01T10:00:00.000Z',
        message: { role: 'user', content: 'fix the width' },
      },
      0,
    );
    expect(m?.role).toBe('user');
    expect(m?.uuid).toBe('u1');
    expect(m?.ts).toBe(Date.parse('2026-08-01T10:00:00.000Z'));
    expect(m?.blocks).toEqual([{ type: 'text', text: 'fix the width' }]);
    expect(m?.isHarnessNoise).toBe(false);
  });

  it('carries the parent, so a thread can be rebuilt', () => {
    expect(
      toMessage({ type: 'user', uuid: 'u2', parentUuid: 'u1', message: { role: 'user', content: 'x' } }, 1)
        ?.parentUuid,
    ).toBe('u1');
  });

  it('calls a user record of only tool results a tool turn', () => {
    const m = toMessage(
      {
        type: 'user',
        uuid: 'u2',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] },
      },
      1,
    );
    expect(m?.role).toBe('tool');
  });

  it('keeps only the tool results of an injected meta turn', () => {
    const m = toMessage(
      {
        type: 'user',
        uuid: 'u3',
        isMeta: true,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'machinery' },
            { type: 'tool_result', tool_use_id: 't1', content: 'real' },
          ],
        },
      },
      2,
    );
    expect(m?.blocks).toEqual([
      { type: 'tool-result', toolUseId: 't1', output: 'real', isError: false },
    ]);
    expect(m?.isMeta).toBe(true);
  });

  it('drops a meta turn that was only prose', () => {
    expect(
      toMessage(
        { type: 'user', uuid: 'u3', isMeta: true, message: { role: 'user', content: 'machinery' } },
        2,
      ),
    ).toBeNull();
  });

  it('marks harness noise without dropping it', () => {
    const m = toMessage(
      { type: 'user', uuid: 'u4', message: { role: 'user', content: '<system-reminder>x</system-reminder>' } },
      3,
    );
    expect(m?.isHarnessNoise).toBe(true);
    expect(m?.role).toBe('user');
  });

  it('does not mark an ordinary markup paste as noise', () => {
    expect(
      toMessage({ type: 'user', uuid: 'u5', message: { role: 'user', content: '<code>port: 8080</code>' } }, 4)
        ?.isHarnessNoise,
    ).toBe(false);
  });

  it('reads an assistant turn with its model, ids and usage', () => {
    const m = toMessage(
      {
        type: 'assistant',
        uuid: 'a1',
        requestId: 'r1',
        message: {
          id: 'm1',
          model: 'claude-opus-5',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1,
          },
          content: [{ type: 'text', text: 'done' }],
        },
      },
      5,
    );
    expect(m?.role).toBe('assistant');
    expect(m?.model).toBe('claude-opus-5');
    expect(m?.messageId).toBe('m1');
    expect(m?.requestId).toBe('r1');
    expect(m?.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 });
  });

  it('reads the sidechain flag a subagent file carries', () => {
    expect(
      toMessage({ type: 'user', uuid: 'u6', isSidechain: true, message: { role: 'user', content: 'x' } }, 6)
        ?.isSidechain,
    ).toBe(true);
  });

  it('falls back to the sequence when a record has no uuid', () => {
    expect(toMessage({ type: 'user', message: { role: 'user', content: 'x' } }, 9)?.uuid).toBe('#9');
  });

  it('refuses a record that is not a turn', () => {
    expect(toMessage({ type: 'ai-title', aiTitle: 'x' }, 0)).toBeNull();
    expect(toMessage({ type: 'file-history-snapshot' }, 0)).toBeNull();
    expect(toMessage(null, 0)).toBeNull();
    expect(toMessage('nope', 0)).toBeNull();
    expect(toMessage({ type: 'user', uuid: 'u', message: { role: 'user', content: [] } }, 0)).toBeNull();
  });
});

describe('usageOf', () => {
  it('answers null when every field is absent or zero', () => {
    expect(usageOf({ usage: {} })).toBeNull();
    expect(usageOf({})).toBeNull();
    expect(usageOf(null)).toBeNull();
  });

  it('treats a missing field as zero rather than failing', () => {
    expect(usageOf({ usage: { output_tokens: 5 } })).toEqual({
      input: 0,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});
