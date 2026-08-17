import { describe, expect, it } from 'vitest';
import { CANDIDATE_TAGS, HARNESS_TAGS, isHarnessInjectedText } from './noise.ts';

describe('isHarnessInjectedText', () => {
  it('names an observed harness tag', () => {
    expect(isHarnessInjectedText('<system-reminder>be good</system-reminder>')).toBe(true);
    expect(isHarnessInjectedText('<task-notification>done</task-notification>')).toBe(true);
    expect(isHarnessInjectedText('<local-command-stdout>hi</local-command-stdout>')).toBe(true);
  });

  /**
   * The regression this file exists for. Measured against the filter it
   * replaces: every one of these was deleted from the index.
   */
  it('keeps a prompt that is entirely ordinary markup', () => {
    expect(isHarnessInjectedText('<code>port: 8080</code>')).toBe(false);
    expect(isHarnessInjectedText('<p>hello</p>')).toBe(false);
    expect(isHarnessInjectedText('<td>1</td><td>2</td>')).toBe(false);
    expect(isHarnessInjectedText('<name>svc</name>')).toBe(false);
    expect(isHarnessInjectedText('<details><summary>cfg</summary></details>')).toBe(false);
  });

  it('keeps an unknown kebab tag, which may be somebody real', () => {
    expect(isHarnessInjectedText('<my-element>hi</my-element>')).toBe(false);
    expect(isHarnessInjectedText('<user_query>hi</user_query>')).toBe(false);
  });

  it('keeps a real prompt that merely mentions a harness tag', () => {
    expect(isHarnessInjectedText('why does <system-reminder> keep appearing?')).toBe(false);
  });

  it('names the observed prefixes', () => {
    expect(isHarnessInjectedText('[Request interrupted by user]')).toBe(true);
    expect(
      isHarnessInjectedText('This session is being continued from a previous conversation'),
    ).toBe(true);
    expect(isHarnessInjectedText('<channel source="rss">x</channel>')).toBe(true);
  });

  it('does not treat a candidate tag as machinery yet', () => {
    for (const tag of CANDIDATE_TAGS) {
      expect(isHarnessInjectedText(`<${tag}>x</${tag}>`)).toBe(false);
    }
  });

  it('keeps a bare <channel>, which is a real feed paste', () => {
    expect(isHarnessInjectedText('<channel>news</channel>')).toBe(false);
  });

  it('is unbothered by leading whitespace and case', () => {
    expect(isHarnessInjectedText('  \n <SYSTEM-REMINDER>x</SYSTEM-REMINDER>')).toBe(true);
  });

  it('answers false for nothing at all', () => {
    expect(isHarnessInjectedText('')).toBe(false);
    expect(isHarnessInjectedText('   ')).toBe(false);
  });

  it('is cheap on a huge paste', () => {
    expect(isHarnessInjectedText(`<code>${'x'.repeat(200_000)}</code>`)).toBe(false);
  });

  it('shares no tag between the two lists', () => {
    for (const tag of HARNESS_TAGS) expect(CANDIDATE_TAGS.has(tag)).toBe(false);
  });
});
