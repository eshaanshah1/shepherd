import { describe, expect, it } from 'vitest';
import { contentBlocks, toolResultOutput } from './blocks.ts';

describe('toolResultOutput', () => {
  it('takes a plain string', () => {
    expect(toolResultOutput('ok')).toBe('ok');
  });

  it('joins an array of blocks', () => {
    expect(toolResultOutput([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe(
      'a\nb',
    );
  });

  it('takes bare strings inside the array too', () => {
    expect(toolResultOutput(['a', { text: 'b' }])).toBe('a\nb');
  });

  it('reads an object with text or content', () => {
    expect(toolResultOutput({ text: 'a' })).toBe('a');
    expect(toolResultOutput({ content: 'b' })).toBe('b');
  });

  it('answers empty for nothing, not the string "undefined"', () => {
    expect(toolResultOutput(undefined)).toBe('');
    expect(toolResultOutput(null)).toBe('');
  });

  it('stringifies a shape it cannot read, rather than losing the evidence', () => {
    expect(toolResultOutput({ rows: 2 })).toBe('{"rows":2}');
  });
});

describe('contentBlocks', () => {
  it('wraps a bare string', () => {
    expect(contentBlocks('hi')).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('decodes each known block kind', () => {
    expect(
      contentBlocks([
        { type: 'text', text: 'a' },
        { type: 'thinking', thinking: 'hmm' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_result', tool_use_id: 't1', content: 'out', is_error: true },
        { type: 'image', source: { url: 'https://x/y.png' } },
      ]),
    ).toEqual([
      { type: 'text', text: 'a' },
      { type: 'thinking', text: 'hmm' },
      { type: 'tool-call', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool-result', toolUseId: 't1', output: 'out', isError: true },
      { type: 'image', path: null, url: 'https://x/y.png' },
    ]);
  });

  it('reads redacted thinking as thinking', () => {
    expect(contentBlocks([{ type: 'redacted_thinking', text: 'x' }])).toEqual([
      { type: 'thinking', text: 'x' },
    ]);
  });

  it('names an unnamed tool rather than dropping the call', () => {
    expect(contentBlocks([{ type: 'tool_use', id: 't1', input: {} }])).toEqual([
      { type: 'tool-call', id: 't1', name: 'tool', input: {} },
    ]);
  });

  it('skips an unknown block rather than failing the record', () => {
    expect(contentBlocks([{ type: 'wat' }, { type: 'text', text: 'a' }])).toEqual([
      { type: 'text', text: 'a' },
    ]);
  });

  it('drops empty text but keeps an empty tool result', () => {
    expect(contentBlocks([{ type: 'text', text: '  ' }])).toEqual([]);
    expect(contentBlocks([{ type: 'tool_result', tool_use_id: 't1', content: '' }])).toEqual([
      { type: 'tool-result', toolUseId: 't1', output: '', isError: false },
    ]);
  });

  it('drops an image that names neither a path nor a url', () => {
    expect(contentBlocks([{ type: 'image', source: {} }])).toEqual([]);
  });

  it('answers empty for a non-array, non-string', () => {
    expect(contentBlocks(null)).toEqual([]);
    expect(contentBlocks(7)).toEqual([]);
    expect(contentBlocks(undefined)).toEqual([]);
  });
});
