import type { ActivateFn } from '@shepherd/sdk';
import type { PastedLink, PastedLinkProvider } from '@shepherd/ext-tasks/manifest';
import { PASTED_LINK_POINT_ID } from './manifest.ts';
import { LINK_PATTERNS, parseLink } from './parse.ts';
import { jiraLabel, slackLabel } from './label.ts';
import { resolveJira } from './jira.ts';

/**
 * One provider, registered into a seam `tasks` owns.
 *
 * The whole extension is this shape: `tasks` asks what a pasted URL is, and this
 * is the half that knows about Jira and Slack — which is why the vendor names
 * appear here and nowhere near the composer.
 */
export const activate: ActivateFn = (ctx, api) => {
  const { points, process: process_ } = api.proposed;

  const point = points.get<PastedLinkProvider>(PASTED_LINK_POINT_ID);
  if (point === undefined) {
    // The one branch here that ends in "and then nothing happens", so it says
    // why. Pasting a link keeps working — it stays plain text — which is a
    // reasonable outcome and an unreasonable thing to be silent about (D15).
    ctx.log.warn(`nothing defines ${PASTED_LINK_POINT_ID} — pasted links will stay as text`);
    return;
  }

  const resolve = async (url: string, signal: AbortSignal): Promise<PastedLink | null> => {
    const parsed = parseLink(url);
    // Not ours, or ours and unreadable. Either way the composer puts the text
    // back rather than drawing something it cannot label.
    if (parsed === null) return null;

    if (parsed.vendor === 'slack') {
      // No call, and none possible: reading a message needs a workspace app. The
      // label is a constant, and `resolved` is false, because nothing about this
      // pill was looked up.
      return { vendor: 'slack', label: slackLabel(), resolved: false };
    }

    const summary = await resolveJira(
      parsed.key,
      {
        process: process_,
        secrets: ctx.secrets,
        fetch: globalThis.fetch,
        homeDir: ctx.homeDir,
        userName: ctx.userName,
        // The site the URL named, so a second Atlassian site costs no second
        // configuration.
        site: parsed.site,
      },
      signal,
    );

    return {
      vendor: 'jira',
      label: jiraLabel(parsed.key, summary ?? undefined),
      resolved: summary !== null,
    };
  };

  ctx.subscriptions.push(point.register({ patterns: LINK_PATTERNS, resolve }));
};
