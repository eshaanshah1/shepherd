import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@shepherd/sdk';
import { SHELL_COMMANDS, SHELL_GROUP, shellManifest } from './manifest.ts';

/**
 * The typed manifest and the `shepherd` key of `package.json` must not drift.
 *
 * `package.json` is the shape an extension is discovered by; `manifest.ts` is the
 * shape this build loads. Two copies of one declaration is a deliberate trade,
 * and this is the half that makes it safe.
 */

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
  shepherd: unknown;
  version: string;
};

describe('the shell manifest', () => {
  it('matches the shepherd key of its own package.json, field for field', () => {
    expect(pkg.shepherd).toEqual(shellManifest);
  });

  it('declares the same version as the package', () => {
    expect(shellManifest.version).toBe(pkg.version);
  });

  it('declares only permissions the SDK knows', () => {
    for (const permission of shellManifest.permissions) {
      expect(PERMISSIONS).toContain(permission);
    }
  });

  it('asks for layout, because revealing a shell switches or opens a root', () => {
    expect(shellManifest.permissions).toContain('layout');
  });

  it('asks for no storage: everything it draws it reads back from the layout', () => {
    expect(shellManifest.permissions).not.toContain('storage');
  });

  it('contributes exactly the commands it registers', () => {
    expect(shellManifest.contributes?.commands?.map((command) => command.id)).toEqual([
      SHELL_COMMANDS.reveal,
      SHELL_COMMANDS.expand,
      SHELL_COMMANDS.promote,
    ]);
  });

  it('puts only the navigation verb in the palette', () => {
    const titled = shellManifest.contributes?.commands?.filter((command) => command.title !== undefined);
    expect(titled?.map((command) => command.id)).toEqual([SHELL_COMMANDS.reveal]);
  });

  it('lives in the home group, which is the decision the feature rests on', () => {
    expect(SHELL_GROUP).toBe('window-1');
  });
});
