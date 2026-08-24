import { glyphElement } from '@shepherd/ui';
import type { PastedLink, PastedLinkPattern } from '../src/manifest.ts';

/**
 * The renderer's half of a pasted link: whether to swallow one, and the node it
 * becomes.
 *
 * Here rather than in `composer.tsx` because none of it needs the component —
 * the two decisions are a string test and a `createElement`, and both are worth
 * being able to assert without mounting a form.
 *
 * **Nothing in this file knows what Jira or Slack are.** It matches patterns it
 * was handed and draws a vendor it was told, which is what keeps the grammars in
 * the extension that owns them.
 */

/**
 * What a link pill says before anything has answered.
 *
 * Deliberately vendor-free. At insert time all this side knows is that some
 * provider claimed the URL; which vendor arrives with the label. A pill that
 * guessed from the hostname would be the vendor knowledge the seam exists to
 * keep out, and it would guess wrong for every vendor added later.
 */
export const LINK_PILL_FALLBACK = 'Link';

/** A single unbroken token, or nothing. Whitespace around it is a copy artefact. */
function lone(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' || /\s/.test(trimmed) ? null : trimmed;
}

function asUrl(text: string): URL | null {
  try {
    const url = new URL(text);
    // This string came off a clipboard and is about to become something the app
    // draws and hands an agent. `file:` and `javascript:` both parse fine.
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Should this paste be swallowed?
 *
 * A LONE url only: taking one out of the middle of a pasted sentence would
 * orphan the rest of it, and somebody pasting a sentence was pasting a sentence.
 *
 * Narrow beyond that too. `PromptField` notes that letting a text paste through
 * the browser is what keeps undo intact, so the set of pastes that give that up
 * should be the smallest the feature needs.
 */
export function claimsPaste(text: string, patterns: readonly PastedLinkPattern[]): boolean {
  const single = lone(text);
  if (single === null) return false;
  const url = asUrl(single);
  if (url === null) return false;
  return patterns.some(
    (pattern) =>
      // A SUFFIX test, which is why a pattern's host carries its leading dot.
      url.hostname.endsWith(pattern.hostSuffix) &&
      url.pathname.startsWith(pattern.pathPrefix) &&
      (pattern.query === undefined || url.searchParams.has(pattern.query)),
  );
}

/**
 * The pill, built as a DOM node for the reason `repoPill` and `imagePill` are:
 * React does not own the editor's subtree.
 *
 * `data-token` is the URL and is never rewritten. A resolved title substituted
 * here would put text written in another system into the prompt an agent reads,
 * and would make the same paste submit differently depending on whether a
 * subprocess answered in time.
 */
export function linkPill(url: string, id: string): HTMLElement {
  const pill = document.createElement('span');
  pill.className = 'sh-ui-pill sh-composer-link-pill';
  pill.contentEditable = 'false';
  pill.dataset['token'] = url;
  // How a late answer finds this node again. Keyed to the NODE rather than to a
  // position, because the caret keeps moving while the answer is in flight.
  pill.dataset['linkId'] = id;
  pill.title = url;
  pill.append(LINK_PILL_FALLBACK);
  return pill;
}

/**
 * Which named glyph each vendor wears.
 *
 * A NAME resolved by `@shepherd/ui`, not artwork: an extension may not reach the
 * icon package (`boundaries.js`), and the allow-list is what that rule exists to
 * point at — "growing it is one line, and that is the point". So Tabler's own
 * brand marks arrive at the kit's one stroke weight and one size ramp, which a
 * hand-drawn `<svg>` here could not promise and an earlier version of this file
 * did not deliver.
 */
const VENDOR_GLYPHS: Readonly<Record<PastedLink['vendor'], string>> = {
  jira: 'brand-jira',
  // Not Slack's own mark: it is four interlocking lozenges whose counters close
  // at 13px, and a pill is 16px tall so it cannot have the room it needs. The
  // hash is what Slack calls a channel, and it survives the size.
  slack: 'hash',
};

/**
 * Fill in what a pill IS, once something has said.
 *
 * The label and the mark, never the token. `contentEditable=false` makes the node
 * atomic, so replacing its children cannot disturb a selection inside it — there
 * is no inside.
 */
export function dressPill(pill: HTMLElement, link: PastedLink): void {
  pill.dataset['link'] = link.vendor;
  pill.replaceChildren();
  const glyph = glyphElement(VENDOR_GLYPHS[link.vendor]);
  // A missing glyph is a missing MARK, not a missing pill: the label is the part
  // that has to be there.
  if (glyph !== null) pill.append(glyph);
  pill.append(link.label);
}

/**
 * The answer to `tasks.linkPatterns`, read rather than cast.
 *
 * A pattern missing either half would match everything or nothing, and both are
 * worse than dropping it.
 */
export function readPatterns(value: unknown): readonly PastedLinkPattern[] {
  const rows = (value as { patterns?: unknown } | null)?.patterns;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((entry: unknown): PastedLinkPattern[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { hostSuffix, pathPrefix, query } = entry as {
      hostSuffix?: unknown;
      pathPrefix?: unknown;
      query?: unknown;
    };
    if (typeof hostSuffix !== 'string' || hostSuffix === '') return [];
    if (typeof pathPrefix !== 'string' || pathPrefix === '') return [];
    return [
      typeof query === 'string' && query !== ''
        ? { hostSuffix, pathPrefix, query }
        : { hostSuffix, pathPrefix },
    ];
  });
}

/**
 * The answer to `tasks.resolveLink`, read rather than cast.
 *
 * `null` means draw nothing — the pill keeps the label it already has. An
 * unknown vendor in particular must be invisible rather than an untinted box,
 * which is the rule `CardFact` states for a malformed contribution.
 */
export function readLink(value: unknown): PastedLink | null {
  if (typeof value !== 'object' || value === null) return null;
  const { vendor, label, resolved } = value as {
    vendor?: unknown;
    label?: unknown;
    resolved?: unknown;
  };
  if (vendor !== 'jira' && vendor !== 'slack') return null;
  if (typeof label !== 'string' || label === '') return null;
  return { vendor, label, resolved: resolved === true };
}
