import { describe, expect, it } from 'vitest';
import { absorb, emptySession } from './session.ts';
import { digestOf } from './digest.ts';
import { readFixture } from '../fixtures.ts';

const digest = (name: string) =>
  digestOf(absorb(emptySession(name, `/x/${name}.jsonl`), readFixture(name)));

describe('digestOf', () => {
  it('keeps user and assistant prose, in file order', () => {
    const d = digest('tool-loop');
    expect(d.turns.map((t) => t.source)).toEqual(['user', 'assistant', 'assistant']);
    expect(d.userTurns).toBe(1);
    expect(d.assistantTurns).toBe(2);
  });

  /**
   * The rule the index's size depends on.
   *
   * Asserted structurally rather than by substring: the assistant's own prose
   * here says "Two files: a.ts and b.ts", so searching the JSON for `a.ts` finds
   * a legitimate turn and proves nothing.
   */
  it('carries prose only — no tool call, no tool output', () => {
    const d = digest('tool-loop');
    expect(d.turns.map((t) => t.text)).toEqual([
      'list the files',
      'Looking now.',
      'Two files: a.ts and b.ts.',
    ]);

    const json = JSON.stringify(d);
    // Not `"input"`: that is the usage token field, and it belongs here.
    for (const marker of ['tool-result', 'tool-call', 'toolUseId', 'tool_use_id', 'blocks']) {
      expect(json, `digest leaked ${marker}`).not.toContain(marker);
    }
  });

  it('drops harness noise but keeps a markup paste', () => {
    const d = digest('markup-prompt');
    expect(d.userTurns).toBe(1);
    expect(d.turns[0]?.text).toBe('<code>port: 8080</code>');
  });

  it('interleaves a recap in file order', () => {
    const d = digest('titles-and-recap');
    expect(d.turns.map((t) => t.source)).toEqual(['user', 'recap']);
    expect(d.recap).toBe('You asked about a port conflict.');
    expect(d.recapTs).toBe(Date.parse('2026-08-06T10:00:05.000Z'));
  });

  it('carries the models and the deduped usage', () => {
    const d = digest('duplicate-usage');
    expect(d.models).toEqual(['claude-opus-5']);
    expect(d.usage.total.output).toBe(40);
  });

  it('names no model when none answered', () => {
    expect(digest('interrupt').models).toEqual([]);
  });

  it('keeps the side fields search matches on', () => {
    const d = digest('titles-and-recap');
    expect(d.aiTitle).toBe('Fixing the port conflict');
    expect(d.customTitle).toBe('port bug');
    expect(d.agentName).toBe('Explore');
    expect(d.cwd).toBe('/repo');
    expect(d.gitBranch).toBe('fix/port');
  });
});
