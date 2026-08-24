import type { Manifest } from '@shepherd/sdk';

export const LINKS_ID = 'shepherd.links';

/**
 * `tasks.pastedLink`, spelled out rather than imported.
 *
 * One extension may TYPE-import another and may not VALUE-import it
 * (`tooling/eslint/boundaries.js`), so the id has to be a local constant. The
 * shape registered with it is type-imported and therefore cannot drift; only
 * this string can, and `manifest.test.ts` pins it at compile time against the
 * literal `tasks` declares.
 */
export const PASTED_LINK_POINT_ID = 'tasks.pastedLink';

/**
 * The credential, and the honest thing said on the field itself: most people
 * never need it. `acli` is asked first, exactly as `github` asks `gh` first, so
 * the common case is a form nobody has to fill in.
 *
 * Its VALUE is a pair, `email:token`, which is unusual enough to be worth the
 * sentence it costs in the description. Atlassian Cloud authenticates an API
 * token as Basic auth over the account it belongs to, and nothing this app can
 * reach knows which account that is — `ctx` carries a `userName`, which is a
 * local account name and not an Atlassian one.
 */
export const JIRA_TOKEN_SECRET_KEY = 'jiraToken';

export const linksManifest: Manifest = {
  id: LINKS_ID,
  name: 'Links',
  version: '0.1.0',
  api: '^1.0.0',
  activation: ['onStartup'],
  permissions: ['process.exec', 'network', 'secrets'],
  dependencies: ['shepherd.tasks'],
  contributes: {
    secrets: [
      {
        key: JIRA_TOKEN_SECRET_KEY,
        title: 'Jira API token',
        description:
          'Only needed if `acli` cannot answer — this extension asks the Atlassian CLI first, ' +
          'and a machine where `acli jira auth status` reports Authenticated never needs this. ' +
          'Paste it as `your@email.com:token`: Atlassian Cloud authenticates an API token as a ' +
          'pair, and the account it belongs to is not something this app can know.',
        link: 'https://id.atlassian.com/manage-profile/security/api-tokens',
      },
    ],
  },
};
