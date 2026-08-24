import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@shepherd/sdk';
import type * as TasksManifest from '@shepherd/ext-tasks/manifest';
import { JIRA_TOKEN_SECRET_KEY, PASTED_LINK_POINT_ID, linksManifest } from './manifest.ts';

/**
 * The id `tasks` declares, as a TYPE.
 *
 * `PASTED_LINK_POINT` is a `const` of a literal type, so `typeof` recovers the
 * exact string without importing the value — which is what keeps this inside the
 * one-extension-may-only-type-import-another rule.
 */
type TasksPointId = typeof TasksManifest.PASTED_LINK_POINT;

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
  shepherd: unknown;
  version: string;
};

describe('the links manifest', () => {
  it('matches the shepherd key of its own package.json, field for field', () => {
    expect(pkg.shepherd).toEqual(linksManifest);
  });

  it('declares the same version as the package', () => {
    expect(linksManifest.version).toBe(pkg.version);
  });

  it('declares only permissions the SDK knows', () => {
    for (const permission of linksManifest.permissions) {
      expect(PERMISSIONS).toContain(permission);
    }
  });

  /**
   * Three grants, and the list is the argument for this being its own extension
   * rather than two more permissions on `tasks`. If it ever needs a fourth, the
   * question to ask first is whether the fourth belongs to a different feature.
   */
  it('asks for exactly the three things resolving a link needs', () => {
    expect([...linksManifest.permissions].sort()).toEqual(['network', 'process.exec', 'secrets']);
  });

  it('declares tasks as a dependency — the point it registers into is theirs', () => {
    expect(linksManifest.dependencies).toEqual(['shepherd.tasks']);
  });

  it('spells the point id exactly as tasks defines it', () => {
    // The id is a local CONSTANT rather than an import, because one extension may
    // not value-import another (boundaries.js). This is the compensation, and it
    // bites at COMPILE time: the assignment below is only legal while the two
    // literals are identical. Rename the point in `tasks` and this stops
    // building, rather than registering into a seam nobody defines and going
    // quiet.
    const declaredByTasks: TasksPointId = PASTED_LINK_POINT_ID;
    expect(declaredByTasks).toBe('tasks.pastedLink');
  });

  /**
   * A secrets screen that names a credential without saying where it comes from
   * is a form you cannot fill in — and this one has a second problem the GitHub
   * token does not: its value is a PAIR, which nobody would guess.
   */
  it('says where the token comes from and what shape it has to be in', () => {
    const [secret] = linksManifest.contributes?.secrets ?? [];
    expect(secret?.key).toBe(JIRA_TOKEN_SECRET_KEY);
    expect(secret?.link).toMatch(/^https:/);
    expect(secret?.description).toContain('acli');
    expect(secret?.description).toContain('email.com:token');
  });
});
