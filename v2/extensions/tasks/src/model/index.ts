/**
 * The pure layer — the task vocabulary, the task root's synthesis, and the git
 * decisions. No host, no filesystem, no clock.
 *
 * Its own subpath (`@shepherd/ext-tasks/model`) so reaching the vocabulary does
 * not pull in `activate`, the same split `agents-core/state` established for the
 * types `claude-code` type-imports.
 */

export { slugify, uniqueSlug } from './slug.ts';
export { taskRootId } from './root-id.ts';
export { ARCHIVE_TTL_MS, expired } from './expiry.ts';
export { repoName } from './repo-name.ts';
export { expandHome } from './repo-path.ts';
export { LIFECYCLE_STATES, displayState, isLifecycle } from './lifecycle.ts';
export type { TaskLifecycle, TaskDisplayState } from './lifecycle.ts';
export { synthTaskRoot } from './root-synth.ts';
export type { RepoContribution, SynthInput, LinkKind, LinkPlan, Conflict, TaskRoot } from './root-synth.ts';
export { resolveBranch } from './branch.ts';
export type { RepoRefs, BranchPlan } from './branch.ts';
export { planArchive, planRestore } from './archive.ts';
export type { WorktreeState, ArchiveRecord, ArchivePlan } from './archive.ts';
