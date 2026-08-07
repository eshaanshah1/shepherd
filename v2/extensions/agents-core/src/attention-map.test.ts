import { describe, expect, it } from 'vitest';
import { attentionFor } from './attention-map.ts';
import { AGENT_STATES, wantsAttention } from './state.ts';

describe('attentionFor', () => {
  it('maps a finished turn to `attention`, which is the level core clears on a glance', () => {
    // That pairing is load-bearing: core clears exactly `attention` when the pane
    // is viewed, which is v1's "need-to-check -> idle on focus" surviving with no
    // second implementation anywhere.
    expect(attentionFor('needsCheck', undefined).level).toBe('attention');
  });

  it('maps blocked and error to `urgent`, which core does NOT clear on a glance', () => {
    // Looking at a permission prompt is not answering it.
    expect(attentionFor('blocked', undefined).level).toBe('urgent');
    expect(attentionFor('error', undefined).level).toBe('urgent');
  });

  it('raises nothing for states that are not about the user', () => {
    for (const state of ['shell', 'idle', 'working'] as const) {
      expect(attentionFor(state, undefined).level, state).toBe('none');
    }
  });

  it('agrees exactly with the agent-state predicate', () => {
    // A drift here would mean a dot the badge disagrees with. The two are
    // different domains and must still name the same sessions.
    for (const state of AGENT_STATES) {
      expect(attentionFor(state, undefined).level !== 'none', state).toBe(wantsAttention(state));
    }
  });

  it('always carries a human reason, and prefers the one it was given', () => {
    expect(attentionFor('blocked', 'approve Bash').reason).toBe('approve Bash');
    // Never empty: the reason is what the user reads on the dot.
    for (const state of AGENT_STATES) {
      expect(attentionFor(state, undefined).reason, state).toBeTruthy();
      expect(attentionFor(state, '').reason, state).toBeTruthy();
    }
  });
});
