import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@shepherd/sdk';
import { DIAGNOSTICS_COMMANDS, diagnosticsManifest } from './manifest.ts';

/**
 * The typed manifest and the `shepherd` key of `package.json` must not drift.
 *
 * `package.json` is the shape an extension is *discovered* by; `manifest.ts` is
 * the shape this build *loads*. Two copies of the same declaration is a
 * deliberate trade (see `manifest.ts` for why), and this is the half that makes
 * the trade safe. Without it a built-in could ship a package.json promising
 * permissions its code never asks for, which is exactly the reviewability the
 * permission model rests on.
 */

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
  shepherd: unknown;
  version: string;
};

describe('the diagnostics manifest', () => {
  it('matches the shepherd key of its own package.json, field for field', () => {
    expect(pkg.shepherd).toEqual(diagnosticsManifest);
  });

  it('declares the same version as the package', () => {
    expect(diagnosticsManifest.version).toBe(pkg.version);
  });

  it('declares only permissions the SDK knows', () => {
    for (const permission of diagnosticsManifest.permissions) {
      expect(PERMISSIONS).toContain(permission);
    }
  });

  it('does NOT declare attention — probeDenied is meaningless if it does', () => {
    // The negative control for the whole permission proof. The moment this
    // extension is granted `attention`, `diagnostics.probeDenied` starts
    // returning a success and stops proving anything, silently.
    expect(diagnosticsManifest.permissions).not.toContain('attention');
  });

  it('contributes exactly the commands it registers', () => {
    expect(diagnosticsManifest.contributes?.commands?.map((command) => command.id)).toEqual([
      DIAGNOSTICS_COMMANDS.ping,
      DIAGNOSTICS_COMMANDS.probeDenied,
    ]);
  });
});
