import type { PullRequest } from './model/pr.ts';

/**
 * A task's pull requests, invented — for a DEV BUILD, so this surface can be
 * looked at.
 *
 * It exists because everything here is unreachable without a real repository, a
 * real remote and a real open PR, and looking at the app is the check that
 * catches what no unit test can: a row that wraps at 900px, a tone that
 * disappears in light mode, a menu that opens off the bottom of the window.
 *
 * The shape is chosen to exercise the cases that are otherwise rare, all at
 * once — which is the whole reason to write a fixture rather than open a PR:
 *
 *   - **two repos**, so the row's repo-first ordering and the identity marks
 *     have something to distinguish;
 *   - **a stack**, so `1 of 2` / `2 of 2 · on #301` render;
 *   - **a failing check WITH output**, so the failure card has a subject;
 *   - **a draft**, whose state word beats its checks and whose review line is
 *     absent rather than "no review yet";
 *   - **an approval and a requested change**, which are the two review verdicts;
 *   - **an unresolved thread and a resolved one**, so both marks appear;
 *   - **three kinds of byline**: an author with a real picture, one whose only
 *     picture is the identicon GitHub drew, and one with no avatar at all — the
 *     three cases `AVATAR_PX` distinguishes and the only ones a load can produce;
 *   - **a merged PR**, so the `Merged` section and the shipped-row fact exist.
 *
 * Nothing here is persisted and the only thing that reaches GitHub is the two
 * avatar images, which is the point of carrying them: a byline that draws a face
 * cannot be looked at without one. `github.seed` refuses outside a dev build.
 */

/**
 * A body an AGENT wrote, which is the shape this pane exists to draw.
 *
 * Headings, inline code, a link, a disclosure, and enough of it to trip the
 * clamp — every markdown case the renderer has a rule for, in one field. A
 * two-line body was what stood here, and it exercised none of them: the section
 * heading, the measure, the chip height and the disclosure marker are all
 * invisible against prose that fits on one line.
 */
const RICH_BODY = [
  "Closes the ask in [Tirth's thread](https://example.com): remove `Code PR Review` and",
  '`Automation PR review`, and let PR review be the Internal / External Review status on the',
  'dev sub-task instead.',
  '',
  'Nine pilot sub-tasks become seven. PR review is now the **Development** sub-task\'s own',
  'Internal / External Review, on the sub-task of the module whose PR it is.',
  '',
  "## Why this isn't just a deletion",
  '',
  'Bolting "`final-gate` *flips Development*" onto the existing flow is a **silent no-op**.',
  '`module done` flipped each module to Internal Review as its agent returned, and',
  '`gate resume implement` closed it — so by Stage 9 every Development sub-task was Closed,',
  '`harness_owned()` returned false, and the flip logged and skipped. On every run. Under',
  '`--auto` it was worse: `flip_target()` returns Closed, so the sub-task went straight there',
  'at Stage 6.',
  '',
  "So Development's window now spans `implement` + `final-gate`, and `gate resume` learns the",
  'second half of it.',
  '',
  '<details><summary>Run configuration and what it changes</summary>',
  '',
  'You can disable the whole path with `STACK_DEV_PR_REVIEW=0`, which restores the',
  'nine-sub-task pilot.',
  '',
  '</details>',
  '',
  '```sh',
  'pnpm -r typecheck && pnpm -r test',
  '```',
  '',
  'The remaining work is in `jira.sh` and `SKILL.md`, and both are covered by `jira_test.sh`.',
].join('\n');

/** Times are relative to `now` so the pane's ages read sensibly whenever it runs. */
export function fixturePrs(now: number): readonly PullRequest[] {
  const minutes = (count: number): number => now - count * 60_000;

  return [
    {
      repo: 'shepherd/sdk',
      repoKey: 'sdk',
      author: 'claude',
      number: 44,
      title: 'Tab rows in the sdk',
      body: RICH_BODY,
      state: 'open',
      baseRef: 'main',
      headRef: 'tasks/add-multiple-task-tabs',
      headOid: '4f2b91c0d7a3e58146bb0c29fd7e4a1b6c0d3e82',
      url: 'https://github.com/shepherd/sdk/pull/44',
      added: 41,
      removed: 2,
      changedFiles: 3,
      checks: [
        { name: 'lint', state: 'passed', durationMs: 12_000 },
        {
          name: 'typecheck',
          state: 'failed',
          durationMs: 38_000,
          summary: "tab-rows.ts:41:12 — Type 'string' is not assignable to type 'TabMark'.",
          log: [
            '$ pnpm -r typecheck',
            'packages/sdk: tsc -b',
            "src/tab-rows.ts(41,12): error TS2322: Type 'string' is not assignable to type 'TabMark'.",
            'src/tab-rows.ts(58,3): error TS2554: Expected 2 arguments, but got 1.',
            '2 errors · exited 2 after 38s',
          ].join('\n'),
          url: 'https://github.com/shepherd/sdk/actions/runs/1',
        },
        {
          /*
           * A required check that has NOT reported, which is the other reason a
           * merge is blocked and the one with no failure to hand anybody. It
           * carries a log so the row opens — the point being that what opens has
           * no `Hand to agent` in it.
           */
          name: 'AI Harness / Audit Stack',
          state: 'queued',
          log: 'Audit required (see PR comment)',
          url: 'https://github.com/shepherd/sdk/actions/runs/2',
        },
        { name: 'test', state: 'skipped' },
      ],
      approvals: [],
      changesRequested: [],
      reviewDecision: 'none',
      threads: [
        {
          id: 'T-1',
          author: 'sam',
          // An account with no picture of its own, so the byline has to read the
          // width back and keep the square. See `AVATAR_PX`.
          avatar: 'https://avatars.githubusercontent.com/u/196956451?s=64&v=4',
          at: minutes(40),
          path: 'src/tree.ts',
          line: 61,
          side: 'right',
          resolved: false,
          body: 'use the token, not the literal',
        },
        { id: 'T-2', author: 'sam', at: minutes(20), path: 'src/tree.ts', line: 12, side: 'right', resolved: true, resolvedByYou: true, body: 'ok' },
      ],
      // A gate reporting itself, which is the comment this pane most has to
      // draw: it is the only thing on the PR saying why a required check is
      // pending, and it is written in markdown because it carries a command.
      comments: [
        {
          id: 'C-1',
          author: 'bsautomation',
          at: minutes(45),
          body: 'This PR needs a stack audit before it can merge.\n\n```\n/stack:audit-stack --pr 44\n```',
        },
        {
          id: 'C-2',
          author: 'coderabbitai',
          avatar: 'https://avatars.githubusercontent.com/u/132028505?s=64&v=4',
          at: minutes(30),
          body: '**Review skipped**\n\nAuto reviews are disabled on this repository.',
        },
      ],
      files: [
        {
          path: 'src/tree.ts',
          added: 22,
          removed: 1,
          patch: [
            '@@ -58,4 +58,11 @@',
            ' export interface TreeItem {',
            '   readonly id: string;',
            '+  readonly mark?: TabMark;',
            '+  readonly pr?: TreePr;',
            '-  readonly tint?: string;',
            ' }',
          ].join('\n'),
        },
        { path: 'src/tab-rows.ts', added: 17, removed: 1 },
        { path: 'src/index.ts', added: 2, removed: 0 },
      ],
      commits: [
        { sha: 'e91c2a4', subject: 'Widen TabMark rather than the app’s union', author: 'claude', at: minutes(8), added: 0, removed: 0 },
        { sha: '77b0d13', subject: 'Tab rows in the sdk', author: 'claude', at: minutes(60), added: 0, removed: 0 },
        { sha: '2f4e881', subject: 'Start on the row shape', author: 'claude', at: minutes(100), added: 0, removed: 0 },
        { sha: 'ac0d5b2', subject: 'Sketch TreePr', author: 'claude', at: minutes(118), added: 0, removed: 0 },
      ],
      reviewers: [{ login: 'sam', verdict: 'commented', comments: 2 }],
      openedAt: minutes(120),
      updatedAt: minutes(6),
      mergeState: 'blocked',
      dependsOn: [],
    },
    {
      repo: 'shepherd/v2',
      repoKey: 'v2',
      author: 'claude',
      number: 301,
      title: 'Add multiple task tabs',
      body: 'A task owns a pane group, so its tabs are roots of that group.',
      state: 'open',
      baseRef: 'main',
      headRef: 'tasks/add-multiple-task-tabs',
      headOid: 'a71c4e9b28d5f0631ac8e7b4920df15c6e83a047',
      url: 'https://github.com/shepherd/v2/pull/301',
      added: 214,
      removed: 38,
      changedFiles: 12,
      checks: Array.from({ length: 12 }, (_, index) => ({
        name: ['lint', 'typecheck', 'test', 'smoke'][index % 4] + (index > 3 ? ` ${Math.floor(index / 4)}` : ''),
        state: 'passed' as const,
        durationMs: 14_000 + index * 3_000,
      })),
      approvals: ['jane'],
      changesRequested: [],
      reviewDecision: 'none',
      comments: [],
      threads: [
        {
          id: 'T-3',
          author: 'sam',
          at: minutes(90),
          path: 'ui/src/tab-strip.css',
          line: 88,
          side: 'right',
          resolved: false,
          body: 'this hard-codes a height the token layer already has',
        },
      ],
      files: [
        { path: 'app/src/renderer/app.tsx', added: 96, removed: 12 },
        { path: 'ui/src/tab-strip.tsx', added: 61, removed: 4 },
        { path: 'ui/src/tab-strip.css', added: 42, removed: 6 },
      ],
      commits: [
        { sha: 'bb31f09', subject: 'Tab strip keyboard order', author: 'claude', at: minutes(22), added: 0, removed: 0 },
        { sha: '5c7a114', subject: 'Add multiple task tabs', author: 'claude', at: minutes(90), added: 0, removed: 0 },
      ],
      reviewers: [
        { login: 'jane', verdict: 'approved', comments: 0 },
        { login: 'sam', verdict: 'commented', comments: 1 },
      ],
      openedAt: minutes(140),
      updatedAt: minutes(20),
      mergeState: 'clean',
      // Across repos, git knows nothing, so the only source is the convention.
      dependsOn: ['shepherd/sdk#44'],
    },
    {
      repo: 'shepherd/v2',
      repoKey: 'v2',
      author: 'claude',
      number: 305,
      title: 'Tab overflow & keyboard order',
      body: '',
      state: 'draft',
      // Based on #301's head — which is what makes this a stack, and is the only
      // thing that does.
      baseRef: 'tasks/add-multiple-task-tabs',
      headRef: 'tasks/tab-overflow',
      headOid: 'c93a0f7e14b62d85097fca3b1e6d420875af9c31',
      url: 'https://github.com/shepherd/v2/pull/305',
      added: 58,
      removed: 4,
      changedFiles: 5,
      checks: [],
      approvals: [],
      changesRequested: [],
      reviewDecision: 'none',
      threads: [],
      comments: [],
      files: [{ path: 'ui/src/tab-strip.tsx', added: 58, removed: 4 }],
      commits: [{ sha: 'd41a7c8', subject: 'Overflow the strip at eight', author: 'claude', at: minutes(9), added: 0, removed: 0 }],
      reviewers: [],
      openedAt: minutes(40),
      updatedAt: minutes(8),
      mergeState: 'unknown',
      dependsOn: [],
    },
    {
      repo: 'shepherd/v2',
      repoKey: 'v2',
      author: 'claude',
      number: 288,
      title: 'Tab strip primitive',
      body: '',
      state: 'merged',
      baseRef: 'main',
      headRef: 'tasks/tab-strip-primitive',
      headOid: '2d68b5f0913ce7a4820db6135f9e074ac2b81d6f',
      url: 'https://github.com/shepherd/v2/pull/288',
      added: 180,
      removed: 22,
      changedFiles: 9,
      checks: [],
      approvals: ['jane'],
      changesRequested: [],
      reviewDecision: 'none',
      threads: [],
      comments: [],
      files: [],
      commits: [{ sha: '9a20e17', subject: 'Tab strip primitive', author: 'claude', at: minutes(130), added: 0, removed: 0 }],
      reviewers: [{ login: 'jane', verdict: 'approved', comments: 0 }],
      openedAt: minutes(600),
      updatedAt: minutes(120),
      mergeState: 'clean',
      dependsOn: [],
    },
  ];
}
