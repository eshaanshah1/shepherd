import { glyphElement } from '@shepherd/ui';
import type { PastedLink, PastedLinkPattern, PastedLinkVendor } from '../src/manifest.ts';

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
 * A STATE, not a noun. Naming the thing here answers the one question nobody is
 * asking at this moment, and it makes a pill that never resolves indistinguishable
 * from one still in flight — `Loading…` distinguishes them by disappearing.
 *
 * Vendor-free as a STRING on purpose: the tint and the mark beside it carry whose
 * link this is, and a pill has too few words to spend one on a name the glyph
 * already says.
 */
export const LINK_PILL_FALLBACK = 'Loading…';

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
 * Whose paste is this, or `null` for nobody's — which is also the answer to
 * "should this paste be swallowed?".
 *
 * One function rather than a boolean and a lookup beside it, because the vendor
 * is what the MATCH found and asking twice is how the two answers drift apart.
 *
 * A LONE url only: taking one out of the middle of a pasted sentence would
 * orphan the rest of it, and somebody pasting a sentence was pasting a sentence.
 *
 * Narrow beyond that too. `PromptField` notes that letting a text paste through
 * the browser is what keeps undo intact, so the set of pastes that give that up
 * should be the smallest the feature needs.
 */
export function claimedVendor(
  text: string,
  patterns: readonly PastedLinkPattern[],
): PastedLinkVendor | null {
  const single = lone(text);
  if (single === null) return null;
  const url = asUrl(single);
  if (url === null) return null;
  const claimed = patterns.find(
    (pattern) =>
      // A SUFFIX test, which is why a pattern's host carries its leading dot.
      url.hostname.endsWith(pattern.hostSuffix) &&
      url.pathname.startsWith(pattern.pathPrefix) &&
      (pattern.query === undefined || url.searchParams.has(pattern.query)),
  );
  // The FIRST match, and `linkPatterns` deduplicates by shape before this sees
  // them — so two providers claiming one shape is one pill, not a race.
  return claimed?.vendor ?? null;
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
export function linkPill(url: string, id: string, vendor: PastedLinkVendor): HTMLElement {
  const pill = document.createElement('span');
  pill.className = 'sh-ui-pill sh-composer-link-pill';
  pill.contentEditable = 'false';
  pill.dataset['token'] = url;
  // How a late answer finds this node again. Keyed to the NODE rather than to a
  // position, because the caret keeps moving while the answer is in flight.
  pill.dataset['linkId'] = id;
  pill.title = url;
  // The vendor's already, mark and hue both, because the pattern that claimed
  // the paste said whose it was. That leaves the answer only the WORD to change,
  // so a pill that resolves is a label swap and not a box becoming another box.
  dress(pill, vendor, LINK_PILL_FALLBACK);
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
const VENDOR_GLYPHS: Readonly<Record<PastedLinkVendor, string>> = {
  jira: 'brand-jira',
  // Not Slack's own mark: it is four interlocking lozenges whose counters close
  // at 13px, and a pill is 16px tall so it cannot have the room it needs. The
  // hash is what Slack calls a channel, and it survives the size.
  slack: 'hash',
};

/**
 * A vendor and a word, drawn.
 *
 * The one place a pill's contents are built, used by both the insert and the
 * answer — so `Loading…` and `SHEP-412 Retry loop` cannot end up as two
 * different drawings of the same box.
 *
 * `contentEditable=false` makes the node atomic, so replacing its children cannot
 * disturb a selection inside it — there is no inside.
 */
function dress(pill: HTMLElement, vendor: PastedLinkVendor, label: string): void {
  pill.dataset['link'] = vendor;
  pill.replaceChildren();
  const glyph = glyphElement(VENDOR_GLYPHS[vendor]);
  // A missing glyph is a missing MARK, not a missing pill: the label is the part
  // that has to be there.
  if (glyph !== null) pill.append(glyph);
  pill.append(label);
}

/**
 * Fill in what a pill SAYS, once something has said it.
 *
 * The label and the mark, never the token.
 *
 * It re-states the vendor rather than trusting the one the pattern gave, and the
 * two can legitimately differ: a host claimed by one provider may be resolved by
 * another, and the provider that answered is the one that actually read the URL.
 */
export function dressPill(pill: HTMLElement, link: PastedLink): void {
  dress(pill, link.vendor, link.label);
}

/**
 * The answer to `tasks.linkPatterns`, read rather than cast.
 *
 * A pattern missing either half would match everything or nothing, and both are
 * worse than dropping it. A pattern naming a vendor this side cannot draw goes the
 * same way, for `readLink`'s reason: a pill has to be drawn the moment the paste
 * is swallowed, so a vendor with no drawing is a URL that must stay text.
 */
export function readPatterns(value: unknown): readonly PastedLinkPattern[] {
  const rows = (value as { patterns?: unknown } | null)?.patterns;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((entry: unknown): PastedLinkPattern[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { hostSuffix, pathPrefix, query, vendor } = entry as {
      hostSuffix?: unknown;
      pathPrefix?: unknown;
      query?: unknown;
      vendor?: unknown;
    };
    if (typeof hostSuffix !== 'string' || hostSuffix === '') return [];
    if (typeof pathPrefix !== 'string' || pathPrefix === '') return [];
    if (vendor !== 'jira' && vendor !== 'slack') return [];
    return [
      typeof query === 'string' && query !== ''
        ? { hostSuffix, pathPrefix, query, vendor }
        : { hostSuffix, pathPrefix, vendor },
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
