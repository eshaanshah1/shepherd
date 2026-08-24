// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  LINK_PILL_FALLBACK,
  claimedVendor,
  dressPill,
  linkPill,
  readLink,
  readPatterns,
} from './link-paste.ts';

const PATTERNS = [
  { hostSuffix: '.atlassian.net', pathPrefix: '/browse/', vendor: 'jira' as const },
  { hostSuffix: '.slack.com', pathPrefix: '/archives/', vendor: 'slack' as const },
];

const JIRA = 'https://x.atlassian.net/browse/SHEP-412';

describe('claimedVendor', () => {
  /**
   * The vendor, not a boolean — and it is what lets the pill be Jira's from the
   * frame it lands in rather than from whenever a subprocess answers.
   */
  it('names whose a lone matching url is', () => {
    expect(claimedVendor(JIRA, PATTERNS)).toBe('jira');
    expect(claimedVendor('https://x.slack.com/archives/C1/p1724500000123456', PATTERNS)).toBe(
      'slack',
    );
  });

  /**
   * A LONE url only. Taking one out of the middle of a pasted sentence would
   * orphan the rest of it, and somebody pasting a sentence was pasting a
   * sentence.
   */
  it('leaves a url inside a sentence alone', () => {
    expect(claimedVendor(`see ${JIRA} please`, PATTERNS)).toBeNull();
    expect(claimedVendor(`${JIRA} ${JIRA}`, PATTERNS)).toBeNull();
  });

  it('tolerates the whitespace a copied url arrives wrapped in', () => {
    expect(claimedVendor(`  ${JIRA}\n`, PATTERNS)).toBe('jira');
  });

  it('leaves an unmatched url, and anything that is not a url, alone', () => {
    expect(claimedVendor('https://example.com/browse/A-1', PATTERNS)).toBeNull();
    expect(claimedVendor('https://x.atlassian.net/wiki/spaces/ENG', PATTERNS)).toBeNull();
    expect(claimedVendor('C#', PATTERNS)).toBeNull();
    expect(claimedVendor('', PATTERNS)).toBeNull();
  });

  it('claims nothing at all before the patterns have arrived', () => {
    // The answer is a round trip away, and paste has to keep working meanwhile.
    expect(claimedVendor(JIRA, [])).toBeNull();
  });

  it('honours a pattern that requires a query parameter', () => {
    const patterns = [
      {
        hostSuffix: '.atlassian.net',
        pathPrefix: '/jira/',
        query: 'selectedIssue',
        vendor: 'jira' as const,
      },
    ];
    const board = 'https://x.atlassian.net/jira/software/projects/A/boards/1';
    expect(claimedVendor(`${board}?selectedIssue=A-1`, patterns)).toBe('jira');
    expect(claimedVendor(board, patterns)).toBeNull();
  });

  it('refuses a scheme this composer should not be turning into anything', () => {
    expect(claimedVendor('javascript:alert(1)', PATTERNS)).toBeNull();
    expect(claimedVendor('file:///etc/passwd', PATTERNS)).toBeNull();
  });
});

describe('linkPill', () => {
  it('carries the url as its token and the fallback as its label', () => {
    const pill = linkPill(JIRA, 'l1', 'jira');
    expect(pill.dataset['token']).toBe(JIRA);
    expect(pill.textContent).toBe(LINK_PILL_FALLBACK);
    expect(pill.dataset['linkId']).toBe('l1');
    expect(pill.contentEditable).toBe('false');
  });

  /**
   * A STATE, not a noun. `Link` said what the thing was at the one moment
   * nobody was asking that — and a pill that never resolved then looked exactly
   * like one still in flight.
   */
  it('says it is loading rather than naming the thing it holds', () => {
    expect(LINK_PILL_FALLBACK).toBe('Loading…');
  });

  /**
   * Already the vendor's, both halves, because the pattern that claimed the
   * paste said whose it was. The pill it becomes is the same box with a
   * different word in it — no tint arriving late, no mark appearing beside a
   * label that had already settled.
   */
  it('wears the vendor’s tint and mark from the frame it lands in', () => {
    const pill = linkPill(JIRA, 'l1', 'jira');
    expect(pill.dataset['link']).toBe('jira');
    expect(pill.querySelector('svg')).not.toBeNull();
  });

  it('draws the other vendor when that is the one that claimed it', () => {
    expect(linkPill('https://x.slack.com/archives/C1/p1', 'l1', 'slack').dataset['link']).toBe(
      'slack',
    );
  });

  it('marks its glyph decorative — the label is what is read out', () => {
    const pill = linkPill(JIRA, 'l1', 'jira');
    expect(pill.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('dressPill', () => {
  it('swaps in the label and the mark, and leaves the token alone', () => {
    const pill = linkPill(JIRA, 'l1', 'jira');
    dressPill(pill, { vendor: 'jira', label: 'SHEP-412 Retry loop', resolved: true });
    expect(pill.textContent).toBe('SHEP-412 Retry loop');
    expect(pill.dataset['link']).toBe('jira');
    expect(pill.querySelector('svg')).not.toBeNull();
    // The brief an agent reads did not change when the label did.
    expect(pill.dataset['token']).toBe(JIRA);
  });

  it('keeps the id, so a second answer can still find the same node', () => {
    const pill = linkPill(JIRA, 'l1', 'jira');
    dressPill(pill, { vendor: 'slack', label: 'Slack thread', resolved: false });
    expect(pill.dataset['linkId']).toBe('l1');
  });

  /**
   * The provider that ANSWERED is the one that read the URL, so its vendor wins
   * over the pattern's — the two can legitimately differ when one extension
   * claims a host another resolves.
   */
  it('re-tints when the answer names a different vendor than the pattern did', () => {
    const pill = linkPill(JIRA, 'l1', 'jira');
    dressPill(pill, { vendor: 'slack', label: 'Slack thread', resolved: true });
    expect(pill.dataset['link']).toBe('slack');
  });

  it('marks its glyph decorative — the label is what is read out', () => {
    const pill = linkPill(JIRA, 'l1', 'jira');
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
  it('keeps the entries with every half and drops the rest', () => {
    expect(
      readPatterns({
        patterns: [
          { hostSuffix: '.slack.com', pathPrefix: '/archives/', vendor: 'slack' },
          { hostSuffix: '.x.com', vendor: 'jira' },
          { pathPrefix: '/y/', vendor: 'jira' },
          { hostSuffix: '', pathPrefix: '/z/', vendor: 'jira' },
          'nope',
          null,
        ],
      }),
    ).toEqual([{ hostSuffix: '.slack.com', pathPrefix: '/archives/', vendor: 'slack' }]);
  });

  /**
   * `readLink`'s rule, one door along: a pattern this side cannot draw is one it
   * should never have matched, because there is no untinted link pill to fall
   * back to any more.
   */
  it('drops a pattern naming a vendor it could not draw', () => {
    expect(
      readPatterns({
        patterns: [
          { hostSuffix: '.linear.app', pathPrefix: '/issue/', vendor: 'linear' },
          { hostSuffix: '.a.com', pathPrefix: '/p/' },
          { hostSuffix: '.b.com', pathPrefix: '/p/', vendor: 7 },
        ],
      }),
    ).toEqual([]);
  });

  it('keeps a query only when it is a usable one', () => {
    expect(
      readPatterns({
        patterns: [
          { hostSuffix: '.a.com', pathPrefix: '/p/', query: 'issue', vendor: 'jira' },
          { hostSuffix: '.b.com', pathPrefix: '/p/', query: '', vendor: 'jira' },
          { hostSuffix: '.c.com', pathPrefix: '/p/', query: 7, vendor: 'jira' },
        ],
      }),
    ).toEqual([
      { hostSuffix: '.a.com', pathPrefix: '/p/', query: 'issue', vendor: 'jira' },
      { hostSuffix: '.b.com', pathPrefix: '/p/', vendor: 'jira' },
      { hostSuffix: '.c.com', pathPrefix: '/p/', vendor: 'jira' },
    ]);
  });

  it('is empty for an answer of the wrong shape', () => {
    expect(readPatterns(null)).toEqual([]);
    expect(readPatterns({ patterns: 'no' })).toEqual([]);
    expect(readPatterns({})).toEqual([]);
  });
});
