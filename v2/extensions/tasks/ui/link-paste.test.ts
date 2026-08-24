// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  LINK_PILL_FALLBACK,
  claimsPaste,
  dressPill,
  linkPill,
  readLink,
  readPatterns,
} from './link-paste.ts';

const PATTERNS = [
  { hostSuffix: '.atlassian.net', pathPrefix: '/browse/' },
  { hostSuffix: '.slack.com', pathPrefix: '/archives/' },
];

const JIRA = 'https://x.atlassian.net/browse/SHEP-412';

describe('claimsPaste', () => {
  it('claims a lone url that matches a pattern', () => {
    expect(claimsPaste(JIRA, PATTERNS)).toBe(true);
  });

  /**
   * A LONE url only. Taking one out of the middle of a pasted sentence would
   * orphan the rest of it, and somebody pasting a sentence was pasting a
   * sentence.
   */
  it('leaves a url inside a sentence alone', () => {
    expect(claimsPaste(`see ${JIRA} please`, PATTERNS)).toBe(false);
    expect(claimsPaste(`${JIRA} ${JIRA}`, PATTERNS)).toBe(false);
  });

  it('tolerates the whitespace a copied url arrives wrapped in', () => {
    expect(claimsPaste(`  ${JIRA}\n`, PATTERNS)).toBe(true);
  });

  it('leaves an unmatched url, and anything that is not a url, alone', () => {
    expect(claimsPaste('https://example.com/browse/A-1', PATTERNS)).toBe(false);
    expect(claimsPaste('https://x.atlassian.net/wiki/spaces/ENG', PATTERNS)).toBe(false);
    expect(claimsPaste('C#', PATTERNS)).toBe(false);
    expect(claimsPaste('', PATTERNS)).toBe(false);
  });

  it('claims nothing at all before the patterns have arrived', () => {
    // The answer is a round trip away, and paste has to keep working meanwhile.
    expect(claimsPaste(JIRA, [])).toBe(false);
  });

  it('honours a pattern that requires a query parameter', () => {
    const patterns = [{ hostSuffix: '.atlassian.net', pathPrefix: '/jira/', query: 'selectedIssue' }];
    const board = 'https://x.atlassian.net/jira/software/projects/A/boards/1';
    expect(claimsPaste(`${board}?selectedIssue=A-1`, patterns)).toBe(true);
    expect(claimsPaste(board, patterns)).toBe(false);
  });

  it('refuses a scheme this composer should not be turning into anything', () => {
    expect(claimsPaste('javascript:alert(1)', PATTERNS)).toBe(false);
    expect(claimsPaste('file:///etc/passwd', PATTERNS)).toBe(false);
  });
});

describe('linkPill', () => {
  it('carries the url as its token and the fallback as its label', () => {
    const pill = linkPill(JIRA, 'l1');
    expect(pill.dataset['token']).toBe(JIRA);
    expect(pill.textContent).toBe(LINK_PILL_FALLBACK);
    expect(pill.dataset['linkId']).toBe('l1');
    expect(pill.contentEditable).toBe('false');
  });

  /**
   * The renderer does not know the grammars, so at insert time all it knows is
   * that SOMETHING claimed this URL. A pill that guessed a vendor from the
   * hostname would be the vendor knowledge this whole seam exists to keep out.
   */
  it('is unmarked and untinted until something says which vendor it is', () => {
    expect(linkPill(JIRA, 'l1').dataset['link']).toBeUndefined();
    expect(linkPill(JIRA, 'l1').querySelector('svg')).toBeNull();
  });
});

describe('dressPill', () => {
  it('swaps in the label and the mark, and leaves the token alone', () => {
    const pill = linkPill(JIRA, 'l1');
    dressPill(pill, { vendor: 'jira', label: 'SHEP-412 Retry loop', resolved: true });
    expect(pill.textContent).toBe('SHEP-412 Retry loop');
    expect(pill.dataset['link']).toBe('jira');
    expect(pill.querySelector('svg')).not.toBeNull();
    // The brief an agent reads did not change when the label did.
    expect(pill.dataset['token']).toBe(JIRA);
  });

  it('keeps the id, so a second answer can still find the same node', () => {
    const pill = linkPill(JIRA, 'l1');
    dressPill(pill, { vendor: 'slack', label: 'Slack thread', resolved: false });
    expect(pill.dataset['linkId']).toBe('l1');
  });

  it('marks its glyph decorative — the label is what is read out', () => {
    const pill = linkPill(JIRA, 'l1');
    dressPill(pill, { vendor: 'jira', label: 'A-1', resolved: false });
    expect(pill.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('readLink', () => {
  it('reads a well-formed answer', () => {
    expect(readLink({ vendor: 'jira', label: 'A-1', resolved: false })).toEqual({
      vendor: 'jira',
      label: 'A-1',
      resolved: false,
    });
  });

  /**
   * It crossed a port from an extension this code has never seen: `ok` says the
   * call succeeded, not that the value has a shape. An unknown vendor draws
   * NOTHING rather than an untinted box — the `CardFact` rule, that a malformed
   * contribution should be invisible.
   */
  it('is null for anything it could not draw', () => {
    expect(readLink({ vendor: 'linear', label: 'X', resolved: true })).toBeNull();
    expect(readLink({ vendor: 'jira', label: '', resolved: true })).toBeNull();
    expect(readLink({ vendor: 'jira', resolved: true })).toBeNull();
    expect(readLink({ label: 'X' })).toBeNull();
    expect(readLink(null)).toBeNull();
    expect(readLink('nope')).toBeNull();
    expect(readLink(undefined)).toBeNull();
  });

  it('treats a missing resolved flag as not resolved rather than refusing', () => {
    expect(readLink({ vendor: 'slack', label: 'Slack thread' })).toEqual({
      vendor: 'slack',
      label: 'Slack thread',
      resolved: false,
    });
  });
});

describe('readPatterns', () => {
  it('keeps the entries with both halves and drops the rest', () => {
    expect(
      readPatterns({
        patterns: [
          { hostSuffix: '.slack.com', pathPrefix: '/archives/' },
          { hostSuffix: '.x.com' },
          { pathPrefix: '/y/' },
          { hostSuffix: '', pathPrefix: '/z/' },
          'nope',
          null,
        ],
      }),
    ).toEqual([{ hostSuffix: '.slack.com', pathPrefix: '/archives/' }]);
  });

  it('keeps a query only when it is a usable one', () => {
    expect(
      readPatterns({
        patterns: [
          { hostSuffix: '.a.com', pathPrefix: '/p/', query: 'issue' },
          { hostSuffix: '.b.com', pathPrefix: '/p/', query: '' },
          { hostSuffix: '.c.com', pathPrefix: '/p/', query: 7 },
        ],
      }),
    ).toEqual([
      { hostSuffix: '.a.com', pathPrefix: '/p/', query: 'issue' },
      { hostSuffix: '.b.com', pathPrefix: '/p/' },
      { hostSuffix: '.c.com', pathPrefix: '/p/' },
    ]);
  });

  it('is empty for an answer of the wrong shape', () => {
    expect(readPatterns(null)).toEqual([]);
    expect(readPatterns({ patterns: 'no' })).toEqual([]);
    expect(readPatterns({})).toEqual([]);
  });
});
