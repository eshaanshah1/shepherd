import { describe, expect, it } from 'vitest';
import { assistantText, awaySummaryText, parseIsoTs, recordType, userText } from './record.ts';

describe('userText', () => {
  it('returns a typed user message', () => {
    expect(userText({ type: 'user', message: { role: 'user', content: 'fix the width' } })).toBe(
      'fix the width',
    );
  });

  it('rejects a tool_result record, whose content is a list', () => {
    const rec = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
    };
    expect(userText(rec)).toBeNull();
  });

  it('rejects a record that is only a system reminder', () => {
    const rec = {
      type: 'user',
      message: { role: 'user', content: '<system-reminder>be good</system-reminder>' },
    };
    expect(userText(rec)).toBeNull();
  });

  it('keeps real text that merely CONTAINS a reminder', () => {
    const rec = {
      type: 'user',
      message: { role: 'user', content: 'do it <system-reminder>x</system-reminder>' },
    };
    expect(userText(rec)).toBe('do it <system-reminder>x</system-reminder>');
  });

  it('rejects local command stdout', () => {
    const rec = {
      type: 'user',
      message: { role: 'user', content: '<local-command-stdout>hi</local-command-stdout>' },
    };
    expect(userText(rec)).toBeNull();
  });

  it('rejects whitespace-only text', () => {
    expect(userText({ type: 'user', message: { role: 'user', content: '   ' } })).toBeNull();
  });

  it('rejects a non-user record', () => {
    expect(userText({ type: 'assistant', message: { role: 'assistant', content: [] } })).toBeNull();
  });

  it('rejects a record that is not an object at all', () => {
    expect(userText('nope')).toBeNull();
    expect(userText(null)).toBeNull();
  });
});

describe('assistantText', () => {
  it('joins every text block with a blank line', () => {
    const rec = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'first' },
          { type: 'tool_use', name: 'Bash', input: {} },
          { type: 'text', text: 'second' },
        ],
      },
    };
    expect(assistantText(rec)).toBe('first\n\nsecond');
  });

  it('returns null when there is no text block', () => {
    const rec = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] },
    };
    expect(assistantText(rec)).toBeNull();
  });

  it('ignores thinking blocks', () => {
    const rec = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } };
    expect(assistantText(rec)).toBeNull();
  });
});

describe('awaySummaryText', () => {
  it('strips the recap trailer', () => {
    const rec = {
      type: 'system',
      subtype: 'away_summary',
      content: 'shipped it (disable recaps in /config)',
    };
    expect(awaySummaryText(rec)).toBe('shipped it');
  });

  it('ignores a system record of another subtype', () => {
    expect(awaySummaryText({ type: 'system', subtype: 'other', content: 'x' })).toBeNull();
  });
});

describe('parseIsoTs', () => {
  it('parses a Z-suffixed stamp to epoch ms', () => {
    expect(parseIsoTs('2026-08-13T14:02:03.000Z')).toBe(Date.parse('2026-08-13T14:02:03.000Z'));
  });

  it('returns null for junk and for absent', () => {
    expect(parseIsoTs('not a date')).toBeNull();
    expect(parseIsoTs(undefined)).toBeNull();
  });
});

describe('recordType', () => {
  it('reads the type of an object and nothing else', () => {
    expect(recordType({ type: 'ai-title' })).toBe('ai-title');
    expect(recordType(null)).toBeNull();
    expect(recordType('nope')).toBeNull();
  });
});
