import type { Manifest } from '@shepherd/sdk';

export const TRANSCRIPTS_ID = 'shepherd.transcripts';
export const TASKS_ID = 'shepherd.tasks';

/**
 * `tasks.transcriptSearch`, spelled out rather than imported.
 *
 * One extension may TYPE-import another and may not VALUE-import it
 * (`tooling/eslint/boundaries.js`), so the id has to be a local constant. The
 * shape registered with it is type-imported and therefore cannot drift; only this
 * string can, and `manifest.test.ts` pins it at compile time against the literal
 * `tasks` declares.
 */
export const TRANSCRIPT_SEARCH_POINT_ID = 'tasks.transcriptSearch';

export const transcriptsManifest: Manifest = {
  id: TRANSCRIPTS_ID,
  name: 'Transcripts',
  version: '0.1.0',
  api: '^1.0.0',
  activation: ['onStartup'],
  /**
   * `storage` and nothing else.
   *
   * The index is a CACHE and lives in `ctx.dataDir` as a file, not in KV:
   * `ctx.storage` is a write-through mirror shipped across the port at
   * activation, and 14.8 MB of transcript text is exactly what `tasks/store.ts`
   * forbids putting there ("no transcripts, no diffs, no file contents, ever").
   *
   * No `process.exec`: this reads files. No `views`: it draws nothing — the rail
   * row and the overlay are `tasks`' surfaces.
   */
  permissions: ['storage'],
  /**
   * Declared, not discovered (§7c). The point this extension registers into
   * belongs to `tasks`, and naming it here is what lets the host activate them in
   * the right order — and refuse to activate this one at all if `tasks` is not
   * there.
   */
  dependencies: [TASKS_ID],
  contributes: {},
};
