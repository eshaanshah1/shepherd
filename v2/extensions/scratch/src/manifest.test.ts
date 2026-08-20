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
    ]);
  });

  it('asks for layout, because creating a scratch opens a tab', () => {
    expect(scratchManifest.permissions).toContain('layout');
  });

  it('asks for process.exec, because a link opens a browser', () => {
    expect(scratchManifest.permissions).toContain('process.exec');
  });
});
