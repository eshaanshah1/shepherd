import { describe, expect, it } from 'vitest';
import { SUMMARY_MAX, jiraLabel, slackLabel } from './label.ts';

describe('jiraLabel', () => {
  it('is the key and the summary when a lookup answered', () => {
    expect(jiraLabel('SHEP-412', 'Retry loop drops the last event')).toBe(
      'SHEP-412 Retry loop drops the last event',
    );
  });

  /**
   * The key came free in the URL, so the fallback is never generic. A pill
   * reading `Jira task` would throw away the one useful thing the paste already
   * told us.
   */
  it('is the bare key when nothing answered', () => {
    expect(jiraLabel('SHEP-412')).toBe('SHEP-412');
    expect(jiraLabel('SHEP-412', '')).toBe('SHEP-412');
    expect(jiraLabel('SHEP-412', '   ')).toBe('SHEP-412');
  });

  it('truncates a summary long enough to take the sentence over', () => {
    const label = jiraLabel('SHEP-412', 'a'.repeat(120));
    expect(label.startsWith('SHEP-412 ')).toBe(true);
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBeLessThanOrEqual('SHEP-412 '.length + SUMMARY_MAX);
  });

  it('leaves a summary exactly at the limit alone', () => {
    const summary = 'a'.repeat(SUMMARY_MAX);
    expect(jiraLabel('A-1', summary)).toBe(`A-1 ${summary}`);
  });

  it('collapses the newlines a summary can legitimately contain', () => {
    // A pill is one line. A raw newline would break the line box it sits in.
    expect(jiraLabel('A-1', 'first line\nsecond line')).toBe('A-1 first line second line');
  });
});

describe('slackLabel', () => {
  /**
   * A constant, deliberately. The permalink carries a timestamp and an earlier
   * version drew its date — which read as though something had been looked up
   * when nothing had, while saying nothing about which message or whose.
   */
  it('says what it knows, which is that this is a slack thread', () => {
    expect(slackLabel()).toBe('Slack thread');
  });
});
