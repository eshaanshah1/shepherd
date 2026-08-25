import { describe, expect, it } from 'vitest';
import { lastAssistantText, lastSaid, summaryOf, MAX_SUMMARY } from './last-said.ts';

const assistant = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const user = (text: string): string =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } });

describe('finding the last assistant text', () => {
  it('takes the LAST assistant message, walking backwards', () => {
    const chunk = [assistant('first'), user('a question'), assistant('second')].join('\n');
    expect(lastAssistantText(chunk)).toBe('second');
  });

  it('skips a fragment at the head of the window', () => {
    /*
     * A tail read starts at a byte offset, not a line boundary, so the first
     * line is usually half a record. It must be skipped rather than ending the
     * walk — and the same tolerance is what makes this safe against a record
     * being written while we read.
     */
    const chunk = ['ype":"assistant","mess', assistant('the real one')].join('\n');
    expect(lastAssistantText(chunk)).toBe('the real one');
  });

  it('ignores thinking and tool blocks — they are the machinery, not speech', () => {
    const record = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'let me consider' },
          { type: 'text', text: 'Done.' },
          { type: 'tool_use', name: 'Bash', input: {} },
        ],
      },
    });
    expect(lastAssistantText(record)).toBe('Done.');
  });

  it('answers null when the window holds no assistant message at all', () => {
    expect(lastAssistantText([user('hello'), 'garbage'].join('\n'))).toBeNull();
    expect(lastAssistantText('')).toBeNull();
  });
});

describe('the summary gate', () => {
  /*
   * The gate exists because the INSTRUCTION CAN LAPSE. It is written into the
   * task root's CLAUDE.md and read into the system prompt once at session start,
   * so on a long session an agent will sometimes end a turn the way it would
   * have anyway. The rail must then say nothing rather than show the bottom of
   * whatever it found.
   */
  it('takes the last line of a multi-line answer', () => {
    expect(summaryOf('Here is a long explanation.\n\nTests pass. Ready for review.')).toBe(
      'Tests pass. Ready for review.',
    );
  });

  it('refuses structure — a list, a heading, a table, a fence', () => {
    for (const ending of ['- one more thing', '1. first', '## Next', '| a | b |', '```', '> quoted', '---']) {
      expect(summaryOf(`Some prose.\n${ending}`), ending).toBeNull();
    }
  });

  it('refuses a line that introduces something rather than concluding', () => {
    // A trailing colon means the point is in whatever follows, and there is
    // nothing following.
    expect(summaryOf('Here is what I found:')).toBeNull();
  });

  it('refuses a question, which the WAITING mark already says', () => {
    // A question is the agent needing you, and the card opens with its own
    // question block for exactly that. Answering it here would say it twice.
    expect(summaryOf('Should I commit this?')).toBeNull();
  });

  it('refuses a paragraph, which is not a summary at all', () => {
    expect(summaryOf('x'.repeat(MAX_SUMMARY + 1))).toBeNull();
    expect(summaryOf('x'.repeat(MAX_SUMMARY))).not.toBeNull();
  });

  it('strips emphasis and backticks, which the row would otherwise draw', () => {
    expect(summaryOf('**Done** — see `task-card.tsx`.')).toBe('Done — see task-card.tsx.');
    // A line that was only markers is not a sentence.
    expect(summaryOf('***')).toBeNull();
  });

  it('answers null for nothing, rather than an empty line', () => {
    expect(summaryOf(null)).toBeNull();
    expect(summaryOf('   \n  ')).toBeNull();
  });
});

describe('the whole read', () => {
  it('goes from a transcript tail to what the row draws', () => {
    const chunk = [
      user('run a test session'),
      assistant('I looked at three things.\n\n- one\n- two\n\nAll three pass; nothing to change.'),
    ].join('\n');
    expect(lastSaid(chunk)).toBe('All three pass; nothing to change.');
  });

  it('draws nothing when the agent ended on a list, which is the lapse case', () => {
    const chunk = assistant('Here is what I did:\n\n- edited the card\n- ran the tests');
    expect(lastSaid(chunk)).toBeNull();
  });
});
