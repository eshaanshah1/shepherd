import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tasksManifest } from './manifest.ts';

/**
 * A built-in is held to the same validation as anybody else, so its typed
 * manifest must not be able to drift from the `shepherd` key a third party would
 * be discovered by.
 */
const packaged = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { shepherd: unknown };

describe('the manifest', () => {
  it('matches package.json exactly', () => {
    expect(packaged.shepherd).toEqual(tasksManifest);
  });

  it('does NOT declare `attention`, which keeps agents-core the only writer', () => {
    // ADR 0026's invariant is enforced by the manifest, not by convention:
    // agents-core is the only extension in the repo declaring `attention`, so
    // the one authorizer refuses anybody else. A task's `needs-you` is DERIVED
    // from its sessions' attention at read time (D4), which needs no grant —
    // and asking for one here would break the invariant by manifest.
    expect(tasksManifest.permissions).not.toContain('attention');
  });

  it('declares `process.exec`, because a task IS worktrees', () => {
    expect(tasksManifest.permissions).toContain('process.exec');
  });

  it('activates on startup, because the task list is the authoritative inventory', () => {
    // Sketch §4: the task list — not any device's layout — is what is running.
    // An extension that woke on first view would make that true only of devices
    // that happened to be looking.
    expect(tasksManifest.activation).toEqual(['onStartup']);
  });
});
