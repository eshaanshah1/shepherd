import type { ActivateFn } from '@shepherd/sdk';
import { activate as diagnostics } from '@shepherd/ext-diagnostics';
import { DIAGNOSTICS_ID } from '@shepherd/ext-diagnostics/manifest';
import { activate as agentsCore } from '@shepherd/ext-agents-core';
import { AGENTS_CORE_ID } from '@shepherd/ext-agents-core/manifest';

/**
 * Which built-ins this build contains, by id.
 *
 * A **static** table, and statically imported: built-ins ship inside the app, so
 * they are bundled into this entry rather than discovered on disk. That is the
 * whole difference between a built-in and a `user` extension, and it is the
 * reason a built-in can be typechecked and lint-bounded like any other package
 * (`extensions/**` may import `@shepherd/sdk` and nothing else).
 *
 * The registry in main is the authority on *whether* an extension is installed;
 * this is only the authority on whether its code is here. When those two
 * disagree — a manifest registered with no module compiled in — the child
 * answers `unavailable` naming both facts, which is the one shape of that bug a
 * reader can act on.
 */
export const BUILTIN_MODULES: ReadonlyMap<string, ActivateFn> = new Map<string, ActivateFn>([
  [DIAGNOSTICS_ID, diagnostics],
  [AGENTS_CORE_ID, agentsCore],
]);
