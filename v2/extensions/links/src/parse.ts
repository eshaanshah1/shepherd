import type { PastedLinkPattern } from '@shepherd/ext-tasks/manifest';

/**
 * The two grammars, and the patterns that have to agree with them.
 *
 * Pure and here rather than beside the resolver, because the patterns and the
 * parser are one claim made twice — once as data the renderer matches against,
 * once as the code that reads what matched. `parse.test.ts` asserts the two
 * agree; keeping them in one file is what makes that assertion cheap to keep
 * true.
 */

/** A project code, a hyphen, a number. Anchored: `notakey` must fail outright. */
const JIRA_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/**
 * `p`, ten digits of epoch seconds, then exactly six of microseconds.
 *
 * Both lengths are fixed. Ten seconds-digits covers 2001 to 2286, and leaving
 * that end open let a segment with a stray digit match and yield a date three
 * millennia out — which is exactly the plausible-but-wrong answer this function
 * exists to refuse.
 */
const SLACK_STAMP = /^p(\d{10})(\d{6})$/;

const JIRA_HOST = '.atlassian.net';
const SLACK_HOST = '.slack.com';

export const JIRA_PATTERNS: readonly PastedLinkPattern[] = [
  { hostSuffix: JIRA_HOST, pathPrefix: '/browse/', vendor: 'jira' },
  // The board form keeps the issue in a query parameter, so the path alone would
  // claim every board anybody has open.
  { hostSuffix: JIRA_HOST, pathPrefix: '/jira/', query: 'selectedIssue', vendor: 'jira' },
];

export const SLACK_PATTERNS: readonly PastedLinkPattern[] = [
  { hostSuffix: SLACK_HOST, pathPrefix: '/archives/', vendor: 'slack' },
];

export const LINK_PATTERNS: readonly PastedLinkPattern[] = [...JIRA_PATTERNS, ...SLACK_PATTERNS];

export type ParsedLink =
  | { readonly vendor: 'jira'; readonly key: string; readonly site: string }
  | { readonly vendor: 'slack'; readonly channelId: string; readonly atMs: number };

/**
 * `p1724500000123456` to epoch milliseconds.
 *
 * The shape check is the whole function. A segment of the wrong length still
 * parses as some number, and a plausible timestamp that names no message is
 * worse than refusing: nothing downstream can tell the two apart, so the label
 * would be confidently wrong about a date.
 */
export function slackStampMs(segment: string): number | null {
  const found = SLACK_STAMP.exec(segment);
  if (found === null) return null;
  const seconds = Number(found[1]);
  const micros = Number(found[2]);
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(micros)) return null;
  return seconds * 1000 + Math.floor(micros / 1000);
}

/**
 * `http(s)` only, and a real `URL` or nothing.
 *
 * The scheme check is not ceremony: this text came off a clipboard and is about
 * to be turned into something the app draws and hands an agent, and `file:` and
 * `javascript:` are both things a `URL` will happily parse.
 */
function asUrl(text: string): URL | null {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function matches(url: URL, pattern: PastedLinkPattern): boolean {
  // A SUFFIX test, which is why every pattern's host begins with a dot:
  // `evilatlassian.net` ends in `atlassian.net` and must not read as Atlassian's.
  if (!url.hostname.endsWith(pattern.hostSuffix)) return false;
  if (!url.pathname.startsWith(pattern.pathPrefix)) return false;
  return pattern.query === undefined || url.searchParams.has(pattern.query);
}

/** Does any pattern claim this text? The renderer asks exactly this, per paste. */
export function claims(text: string, patterns: readonly PastedLinkPattern[]): boolean {
  const url = asUrl(text);
  return url !== null && patterns.some((pattern) => matches(url, pattern));
}

function parseJira(url: URL): ParsedLink | null {
  const key = url.pathname.startsWith('/browse/')
    ? (url.pathname.slice('/browse/'.length).split('/')[0] ?? '')
    : (url.searchParams.get('selectedIssue') ?? '');
  return JIRA_KEY.test(key) ? { vendor: 'jira', key, site: url.hostname } : null;
}

function parseSlack(url: URL): ParsedLink | null {
  const [, archives, channelId, stamp] = url.pathname.split('/');
  if (archives !== 'archives') return null;
  if (channelId === undefined || channelId === '') return null;
  const atMs = stamp === undefined ? null : slackStampMs(stamp);
  return atMs === null ? null : { vendor: 'slack', channelId, atMs };
}

export function parseLink(text: string): ParsedLink | null {
  const url = asUrl(text);
  if (url === null) return null;
  if (url.hostname.endsWith(JIRA_HOST)) return parseJira(url);
  if (url.hostname.endsWith(SLACK_HOST)) return parseSlack(url);
  return null;
}
