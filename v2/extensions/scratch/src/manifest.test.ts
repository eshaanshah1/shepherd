import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@shepherd/sdk';
import { SCRATCH_COMMANDS, scratchManifest } from './manifest.ts';

/**
 * The typed manifest and the `shepherd` key of `package.json` must not drift.
 *
 * `package.json` is the shape an extension is discovered by; `manifest.ts` is
 * the shape this build loads. Two copies of one declaration is a deliberate
 * trade, and this is the half that makes it safe.
 */

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
  shepherd: unknown;
  version: string;
};

describe('the scratch manifest', () => {
  it('matches the shepherd key of its own package.json, field for field', () => {
    expect(pkg.shepherd).toEqual(scratchManifest);
  });

  it('declares the same version as the package', () => {
    expect(scratchManifest.version).toBe(pkg.version);
  });

  it('declares only permissions the SDK knows', () => {
    for (const permission of scratchManifest.permissions) {
      expect(PERMISSIONS).toContain(permission);
    }
  });

  it('contributes exactly the commands it registers', () => {
    expect(scratchManifest.contributes?.commands?.map((command) => command.id)).toEqual([
      SCRATCH_COMMANDS.create,
      SCRATCH_COMMANDS.read,
      SCRATCH_COMMANDS.write,
      SCRATCH_COMMANDS.close,
      SCRATCH_COMMANDS.open,
      SCRATCH_COMMANDS.skillTargets,
      SCRATCH_COMMANDS.installSkill,
    ]);
  });

  /*
   * `extensions.get` resolves only ids a manifest names, so a dependency this
   * does not declare is a repo list that comes back empty at runtime and nowhere
   * else — the target picker would silently offer the user level alone.
   */
  it('declares tasks, because that is where the repos come from', () => {
    expect(scratchManifest.dependencies).toEqual(['shepherd.tasks']);
  });

  /*
   * Two of the seven are verbs a person runs; the rest are the pane talking to its
   * own service half. A title is what puts a command in ⌘K, so an untitled one is
   * a deliberate absence rather than an oversight.
   */
  it('titles only the commands a person would look for', () => {
    const titled = scratchManifest.contributes?.commands?.filter((command) => command.title !== undefined);
    expect(titled?.map((command) => command.id)).toEqual([SCRATCH_COMMANDS.create, SCRATCH_COMMANDS.installSkill]);
  });

  it('asks for layout, because creating a scratch opens a tab', () => {
    expect(scratchManifest.permissions).toContain('layout');
  });

  it('asks for process.exec, because a link opens a browser', () => {
    expect(scratchManifest.permissions).toContain('process.exec');
  });
});
