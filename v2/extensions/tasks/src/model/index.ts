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

export { repoName } from './repo-name.ts';
export { expandHome, collapseHome } from './repo-path.ts';
export { displayMatch, segmentsOf } from './match-display.ts';
export { orderSuggestions, rankScored } from './pick-order.ts';
export type { Orderable, Scored } from './pick-order.ts';
export type { MatchDisplay, DisplaySegment } from './match-display.ts';
export { LIFECYCLE_STATES, displayState, isLifecycle } from './lifecycle.ts';
export type { TaskLifecycle, TaskDisplayState } from './lifecycle.ts';
export { synthTaskRoot } from './root-synth.ts';
export type { RepoContribution, SynthInput, LinkKind, LinkPlan, Conflict, TaskRoot } from './root-synth.ts';
export { resolveBranch } from './branch.ts';
export type { RepoRefs, BranchPlan } from './branch.ts';
export { planArchive, planRestore } from './archive.ts';
export type { WorktreeState, ArchiveRecord, ArchivePlan } from './archive.ts';
export { SHIPPED_CAP, activeOrder, capShipped, shippedOrder } from './order.ts';
export type { Ordered } from './order.ts';
export { collapseByTitle, dayLabel, formatClock, groupByDay, shippedAt } from './shipped-days.ts';
export type { Shippable, ShippedDay, ShippedRow } from './shipped-days.ts';
