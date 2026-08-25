import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@shepherd/sdk';
import { EDITOR_COMMANDS, editorManifest } from './manifest.ts';

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

describe('the editor manifest', () => {
  it('matches the shepherd key of its own package.json, field for field', () => {
    expect(pkg.shepherd).toEqual(editorManifest);
  });

  it('declares the same version as the package', () => {
    expect(editorManifest.version).toBe(pkg.version);
  });

  it('declares only permissions the SDK knows', () => {
    for (const permission of editorManifest.permissions) {
      expect(PERMISSIONS).toContain(permission);
    }
  });

  it('contributes exactly the commands it registers', () => {
    expect(editorManifest.contributes?.commands?.map((command) => command.id)).toEqual([
      EDITOR_COMMANDS.open,
      EDITOR_COMMANDS.tree,
      EDITOR_COMMANDS.read,
      EDITOR_COMMANDS.write,
      EDITOR_COMMANDS.changes,
      EDITOR_COMMANDS.diff,
    ]);
  });

  /*
   * One of the six is a verb a person runs; the rest are the pane talking to its
   * own service half. A title is what puts a command in ⌘K, so an untitled one is
   * a deliberate absence rather than an oversight.
   */
  it('titles only the command a person would look for', () => {
    const titled = editorManifest.contributes?.commands?.filter(
      (command) => command.title !== undefined,
    );
    expect(titled?.map((command) => command.id)).toEqual([EDITOR_COMMANDS.open]);
  });

  /*
   * Both are soft in behaviour and declared anyway: a cross-extension command
   * resolves only against ids a manifest names, so an undeclared dependency is
   * a `Notes` root that is silently always empty and nothing that says why.
   */
  it('declares tasks and scratch, the two extensions it asks things of', () => {
    expect(editorManifest.dependencies).toEqual(['shepherd.tasks', 'shepherd.scratch']);
  });

  it('asks for layout, because opening the editor opens a tab', () => {
    expect(editorManifest.permissions).toContain('layout');
  });

  /*
   * For git and only git. Reading and writing the files themselves is `node:fs`,
   * which is stdlib and needs no grant — `scratch/src/install.ts` says why.
   */
  it('asks for process.exec, because the tree and its diffs come from git', () => {
    expect(editorManifest.permissions).toContain('process.exec');
  });
});
