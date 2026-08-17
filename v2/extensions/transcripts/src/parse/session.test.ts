import { describe, expect, it } from 'vitest';
import { absorb, completeBytes, emptySession } from './session.ts';
import { readFixture } from '../fixtures.ts';

const fold = (name: string) => absorb(emptySession(name, `/x/${name}.jsonl`), readFixture(name));

describe('absorb', () => {
  it('reads a tool loop into messages, blocks and usage', () => {
    const s = fold('tool-loop');
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(s.cwd).toBe('/repo');
    expect(s.gitBranch).toBe('main');
    expect(s.usage.total).toEqual({ input: 30, output: 13, cacheRead: 100, cacheWrite: 0 });
    expect(s.lifecycle?.state).toBe('completed');
  });

  it('keeps the tool call and its output, which the digest will not', () => {
    const s = fold('tool-loop');
    expect(s.messages[1].blocks).toContainEqual({
      type: 'tool-call',
      id: 't1',
      name: 'Bash',
      input: { command: 'ls' },
    });
    expect(s.messages[2].blocks).toContainEqual({
      type: 'tool-result',
      toolUseId: 't1',
      output: 'a.ts\nb.ts',
      isError: false,
    });
  });

  it('counts a re-streamed row once, taking the fuller usage', () => {
    expect(fold('duplicate-usage').usage.total.output).toBe(40);
  });

  it('keeps a markup paste and marks only the real machinery', () => {
    const users = fold('markup-prompt').messages.filter((m) => m.role === 'user');
    expect(users).toHaveLength(2);
    expect(users[0].isHarnessNoise).toBe(false);
    expect(users[1].isHarnessNoise).toBe(true);
  });

  it('ends interrupted when the turn was interrupted', () => {
    expect(fold('interrupt').lifecycle?.state).toBe('interrupted');
  });

  it('reads titles and a recap without its UI trailer', () => {
    const s = fold('titles-and-recap');
    expect(s.aiTitle).toBe('Fixing the port conflict');
    expect(s.customTitle).toBe('port bug');
    expect(s.agentName).toBe('Explore');
    expect(s.recaps[0].text).toBe('You asked about a port conflict.');
  });

  it('records an unrecognised type rather than dropping it', () => {
    const s = absorb(emptySession('s', '/x'), '{"type":"pr-link","url":"https://x"}\n');
    expect(s.unknown).toEqual([{ seq: 0, type: 'pr-link' }]);
  });

  it('survives a malformed line', () => {
    const s = absorb(
      emptySession('s', '/x'),
      'not json\n{"type":"user","uuid":"u","message":{"role":"user","content":"hi"}}\n',
    );
    expect(s.messages).toHaveLength(1);
  });

  /**
   * The test that proves the chunk-boundary usage handling. A dedupe group split
   * across two chunks must be counted once, at its maximum — not twice, and not
   * at the partial value the first chunk saw.
   */
  it('is a fold: two halves equal one whole', () => {
    for (const name of ['tool-loop', 'duplicate-usage', 'titles-and-recap']) {
      const text = readFixture(name);
      const whole = absorb(emptySession(name, '/x'), text);
      for (let cut = 0; cut <= text.length; cut += 37) {
        const safe = completeBytes(text.slice(0, cut));
        const split = absorb(absorb(emptySession(name, '/x'), text.slice(0, safe)), text.slice(safe));
        expect(split, `${name} cut at ${String(cut)}`).toEqual(whole);
      }
    }
  });

  it('splits a duplicate-usage pair down the middle and still counts 40', () => {
    const text = readFixture('duplicate-usage');
    const cut = text.indexOf('\n') + 1;
    const first = absorb(emptySession('d', '/x'), text.slice(0, cut));
    // The open group is settled, so a reader between chunks sees a true number.
    expect(first.usage.total.output).toBe(15);
    expect(absorb(first, text.slice(cut)).usage.total.output).toBe(40);
  });

  it('drops a trailing partial line, and picks it up next time', () => {
    const text = readFixture('tool-loop');
    const mid = text.indexOf('\n') + 10;
    const partial = absorb(emptySession('t', '/x'), text.slice(0, mid));
    expect(partial.messages).toHaveLength(1);
    expect(absorb(partial, text.slice(completeBytes(text.slice(0, mid)))).messages).toHaveLength(4);
  });

  it('counts every record, so seq keeps file order', () => {
    const s = fold('titles-and-recap');
    expect(s.records).toBe(5);
    expect(s.messages[0].seq).toBe(3);
    expect(s.recaps[0].seq).toBe(4);
  });
});

describe('completeBytes', () => {
  it('stops at the last newline', () => {
    expect(completeBytes('a\nb\nc')).toBe(4);
    expect(completeBytes('no newline')).toBe(0);
    expect(completeBytes('')).toBe(0);
  });

  it('counts BYTES, not characters', () => {
    expect(completeBytes('é\n')).toBe(3);
  });
});
