/**
 * The pure layer, as one import — the vocabulary of a pull request plus every
 * decision about how it reads.
 *
 * A third subpath for the reason `tasks` has one: a consumer that wants the
 * types and the display rules should not have to pull in `activate`, an Octokit
 * and a sync loop to get them. The UI half imports from here and from nowhere
 * else in `src/`.
 */
export {
  blockedBy,
  canMerge,
  CHECK_STATES,
  checksSaid,
  countChecks,
  firstFailure,
  isLive,
  landOrder,
  mergeGate,
  prKey,
  reviewSaid,
  rollUp,
  rollUpSaid,
  REASONS,
  stackLabel,
  stackOf,
  stateWord,
  type ChangedFile,
  type Comment,
  type Commit,
  type Reviewer,
  type CheckCount,
  type CheckRun,
  type CheckState,
  type Gate,
  type PrState,
  type PullRequest,
  type ReviewThread,
  type Said,
  type TaskPrState,
  type Tone,
} from './pr.ts';
export { parseRemote, slugText, type RepoSlug } from './remote.ts';
export { hunksOf, isLineInDiff, unifiedPatch, type Hunk } from './patch.ts';
export { checkPrompt, reviewPrompt, threadPrompt } from './prompt.ts';
export { pickAgent, readAgents, readLive, type Pick, type TaskAgent } from './agent-pick.ts';
