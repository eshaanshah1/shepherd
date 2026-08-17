import { describe, expect, it } from 'vitest';
import { isSubagentFileName, subagentDirFor } from './subagents.ts';

describe('subagentDirFor', () => {
  it('names the sibling directory Claude writes beside a session', () => {
    expect(subagentDirFor('/p/-Users-me-repo/204c2bc8.jsonl')).toBe(
      '/p/-Users-me-repo/204c2bc8/subagents',
    );
  });

  it('is unbothered by a capitalised extension', () => {
    expect(subagentDirFor('/p/x/S1.JSONL')).toBe('/p/x/S1/subagents');
  });
});

describe('isSubagentFileName', () => {
  it('takes only agent-*.jsonl', () => {
    expect(isSubagentFileName('agent-a326799a725bb8d6b.jsonl')).toBe(true);
    expect(isSubagentFileName('agent-x.JSONL')).toBe(true);
  });

  it('rejects a meta sidecar and a stray transcript', () => {
    expect(isSubagentFileName('agent-x.meta.json')).toBe(false);
    expect(isSubagentFileName('something.jsonl')).toBe(false);
    expect(isSubagentFileName('agent-.jsonl')).toBe(false);
    expect(isSubagentFileName('agent-')).toBe(false);
    expect(isSubagentFileName('')).toBe(false);
  });
});
