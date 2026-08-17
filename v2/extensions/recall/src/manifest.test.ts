import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@shepherd/sdk';
import type * as TasksManifest from '@shepherd/ext-tasks/manifest';
import { recallManifest, TRANSCRIPT_SEARCH_POINT_ID } from './manifest.ts';

/**
 * The id `tasks` declares, as a TYPE.
 *
 * `TRANSCRIPT_SEARCH_POINT` is a `const` of a literal type, so `typeof` recovers
 * the exact string without importing the value — which is what keeps this inside
 * the one-extension-may-only-type-import-another rule.
 */
type TasksPointId = typeof TasksManifest.TRANSCRIPT_SEARCH_POINT;

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
  shepherd: unknown;
  version: string;
};

describe('the recall manifest', () => {
  it('matches the shepherd key of its own package.json, field for field', () => {
    expect(pkg.shepherd).toEqual(recallManifest);
  });

  it('declares the same version as the package', () => {
    expect(recallManifest.version).toBe(pkg.version);
  });

  it('declares only permissions the SDK knows', () => {
    for (const permission of recallManifest.permissions) {
      expect(PERMISSIONS).toContain(permission);
    }
  });

  it('asks for storage and nothing more', () => {
    // The index is a file under `ctx.dataDir`, not KV — `tasks/store.ts` forbids
    // transcripts in a namespace the host mirrors across the port. And this
    // extension runs no process and draws no view, so a grant for either would be
    // one nobody can justify at review.
    expect(recallManifest.permissions).toEqual(['storage']);
  });

  it('contributes no surface of its own', () => {
    // The rail row and the ⇧⌘F overlay belong to `tasks`. What crosses from here
    // is data, which is what lets a second agent vendor replace this wholesale.
    expect(recallManifest.contributes).toEqual({});
  });

  it('declares tasks as a dependency — the point it registers into is theirs', () => {
    expect(recallManifest.dependencies).toEqual(['shepherd.tasks']);
  });

  it('spells the point id exactly as tasks defines it', () => {
    // The id is a local CONSTANT rather than an import, because one extension may
    // not value-import another (boundaries.js). This is the compensation, and it
    // bites at COMPILE time: the assignment below is only legal while the two
    // literals are identical. Rename the point in `tasks` and this stops
    // building, rather than registering into a seam nobody defines and going
    // quiet.
    const declaredByTasks: TasksPointId = TRANSCRIPT_SEARCH_POINT_ID;
    expect(declaredByTasks).toBe('tasks.transcriptSearch');
  });
});
