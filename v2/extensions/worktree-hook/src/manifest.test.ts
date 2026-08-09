import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@shepherd/sdk';
import type * as TasksManifest from '@shepherd/ext-tasks/manifest';
import { REPO_PROVISIONED_POINT_ID, WORKTREE_HOOK_COMMANDS, worktreeHookManifest } from './manifest.ts';

/**
 * The id `tasks` declares, as a TYPE.
 *
 * `REPO_PROVISIONED_POINT` is a `const` of a literal type, so `typeof` recovers
 * the exact string without importing the value — which is what keeps this
 * inside the one-extension-may-only-type-import-another rule.
 */
type TasksPointId = typeof TasksManifest.REPO_PROVISIONED_POINT;

/**
 * The typed manifest and the `shepherd` key of `package.json` must not drift —
 * the same trade every extension here makes, and the same test that makes it
 * safe. `package.json` is the shape an extension is discovered by; `manifest.ts`
 * is the shape this build loads.
 */

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
  shepherd: unknown;
  version: string;
};

describe('the worktree-hook manifest', () => {
  it('matches the shepherd key of its own package.json, field for field', () => {
    expect(pkg.shepherd).toEqual(worktreeHookManifest);
  });

  it('declares the same version as the package', () => {
    expect(worktreeHookManifest.version).toBe(pkg.version);
  });

  it('declares only permissions the SDK knows', () => {
    for (const permission of worktreeHookManifest.permissions) {
      expect(PERMISSIONS).toContain(permission);
    }
  });

  it('declares process.exec, which is the whole feature', () => {
    // A hook is a script. An extension that cannot run one is an empty settings
    // panel, and this is the line that says so in a form a reviewer can read.
    expect(worktreeHookManifest.permissions).toContain('process.exec');
  });

  it('declares tasks as a dependency — the point it registers into is theirs', () => {
    expect(worktreeHookManifest.dependencies).toEqual(['shepherd.tasks']);
  });

  it('spells the point id exactly as tasks defines it', () => {
    // The id is a local CONSTANT rather than an import, because one extension may
    // not value-import another (boundaries.js). This is the compensation, and it
    // bites at COMPILE time: the assignment below is only legal while the two
    // literals are identical. Rename the point in `tasks` and this stops
    // building, rather than registering into a seam nobody defines and going
    // quiet — which is the failure this whole file exists to prevent.
    const declaredByTasks: TasksPointId = REPO_PROVISIONED_POINT_ID;
    expect(declaredByTasks).toBe('tasks.repoProvisioned');
  });

  it('contributes exactly the commands it registers', () => {
    expect(worktreeHookManifest.contributes?.commands?.map((command) => command.id)).toEqual([
      WORKTREE_HOOK_COMMANDS.get,
      WORKTREE_HOOK_COMMANDS.set,
      WORKTREE_HOOK_COMMANDS.clear,
      WORKTREE_HOOK_COMMANDS.testRun,
    ]);
  });

  it('contributes no command for opening the editor, because none could work', () => {
    // An overlay is raised by its accelerator or by a gesture in the page; the
    // SDK gives an extension's service half no way to raise its own view. A
    // `worktreeHook.edit` entry would be a palette row that does nothing, which
    // is worse than no row.
    const ids = worktreeHookManifest.contributes?.commands?.map((command) => command.id) ?? [];
    expect(ids.some((id) => id.endsWith('.edit'))).toBe(false);
  });
});
