import { describe, expect, it } from 'vitest';
import { LINK_PATTERNS, claims, parseLink, slackStampMs } from './parse.ts';

describe('slackStampMs', () => {
  it('reads epoch seconds and the six microsecond digits after them', () => {
    // 1724500000 is 2024-08-24T12:26:40Z; `123456` is microseconds.
    expect(slackStampMs('p1724500000123456')).toBe(1_724_500_000_123);
  });

  /**
   * The refusals are the point. A segment of the wrong length still parses as
   * SOME number, and a plausible timestamp naming no message is worse than
   * nothing — the label would be confidently wrong about a date.
   */
  it('refuses a segment of the wrong shape rather than guessing', () => {
    expect(slackStampMs('p172450000012345')).toBeNull();
    expect(slackStampMs('p17245000001234567')).toBeNull();
    expect(slackStampMs('1724500000123456')).toBeNull();
    expect(slackStampMs('pnotanumber12345')).toBeNull();
    expect(slackStampMs('p')).toBeNull();
    expect(slackStampMs('')).toBeNull();
  });
});

describe('parseLink', () => {
  it('reads a jira key out of a browse url', () => {
    expect(parseLink('https://browserstack.atlassian.net/browse/SHEP-412')).toEqual({
      vendor: 'jira',
      key: 'SHEP-412',
      site: 'browserstack.atlassian.net',
    });
  });

  it('reads a jira key out of a board url, where it is a query parameter', () => {
    expect(
      parseLink(
        'https://browserstack.atlassian.net/jira/software/projects/SHEP/boards/1?selectedIssue=SHEP-412',
      ),
    ).toEqual({ vendor: 'jira', key: 'SHEP-412', site: 'browserstack.atlassian.net' });
  });

  it('ignores what a browse url carries after the key', () => {
    expect(parseLink('https://x.atlassian.net/browse/AB-9?filter=42#comment-1')).toEqual({
      vendor: 'jira',
      key: 'AB-9',
      site: 'x.atlassian.net',
    });
  });

  it('reads a slack permalink', () => {
    expect(
      parseLink('https://browserstack.slack.com/archives/C08ABCDEF/p1724500000123456'),
    ).toEqual({ vendor: 'slack', channelId: 'C08ABCDEF', atMs: 1_724_500_000_123 });
  });

  it('is null for a claimed host whose path says nothing', () => {
    expect(parseLink('https://x.atlassian.net/browse/notakey')).toBeNull();
    expect(parseLink('https://x.atlassian.net/browse/')).toBeNull();
    expect(parseLink('https://x.slack.com/archives/C08ABCDEF/pnope')).toBeNull();
    expect(parseLink('https://x.slack.com/archives/')).toBeNull();
  });

  it('is null for anything else at all', () => {
    expect(parseLink('https://x.atlassian.net/wiki/spaces/ENG/pages/1')).toBeNull();
    expect(parseLink('https://example.com/browse/SHEP-412')).toBeNull();
    expect(parseLink('not a url at all')).toBeNull();
    expect(parseLink('C#')).toBeNull();
    // A scheme this app should not be turning into anything.
    expect(parseLink('file:///etc/passwd')).toBeNull();
    expect(parseLink('javascript:alert(1)')).toBeNull();
  });

  /**
   * `endsWith` on a hostname is a suffix test, not a domain test, so the
   * lookalike has to be refused explicitly or `evil-atlassian.net` reads as
   * Atlassian's.
   */
  it('is not fooled by a host that merely ends in the right letters', () => {
    expect(parseLink('https://evilatlassian.net/browse/A-1')).toBeNull();
    expect(parseLink('https://notslack.com/archives/C1/p1724500000123456')).toBeNull();
  });
});

describe('claims', () => {
  it('claims the urls the grammar can read', () => {
    expect(claims('https://x.atlassian.net/browse/A-1', LINK_PATTERNS)).toBe(true);
    expect(claims('https://x.slack.com/archives/C1/p1724500000123456', LINK_PATTERNS)).toBe(true);
  });

  it('leaves the wiki and the marketing site alone', () => {
    expect(claims('https://x.atlassian.net/wiki/spaces/ENG', LINK_PATTERNS)).toBe(false);
    expect(claims('https://www.atlassian.net/', LINK_PATTERNS)).toBe(false);
  });

  it('needs the query parameter a pattern asks for', () => {
    const board = 'https://x.atlassian.net/jira/software/projects/A/boards/1';
    expect(claims(`${board}?selectedIssue=A-1`, LINK_PATTERNS)).toBe(true);
    expect(claims(board, LINK_PATTERNS)).toBe(false);
  });

  it('claims nothing when it has been given no patterns', () => {
    // The answer may not have arrived yet. Paste has to keep working meanwhile.
    expect(claims('https://x.atlassian.net/browse/A-1', [])).toBe(false);
  });

  /**
   * The drift guard, and the reason the patterns are worth testing separately at
   * all. The composer matches patterns; the provider runs the grammar. If the two
   * disagree, a URL is either swallowed and undrawable or read and never offered
   * — and both fail silently.
   */
  it('claims every url the parser accepts', () => {
    const accepted = [
      'https://x.atlassian.net/browse/A-1',
      'https://x.atlassian.net/jira/software/projects/A/boards/1?selectedIssue=A-1',
      'https://x.slack.com/archives/C1/p1724500000123456',
    ];
    for (const url of accepted) {
      expect(parseLink(url), url).not.toBeNull();
      expect(claims(url, LINK_PATTERNS), url).toBe(true);
    }
  });
});
