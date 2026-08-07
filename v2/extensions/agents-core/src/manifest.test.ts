import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentsCoreManifest } from './manifest.ts';

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
    expect(packaged.shepherd).toEqual(agentsCoreManifest);
  });

  it('is the only place `attention` is declared', () => {
    // The invariant this permission list enforces: agents-core is the ONLY
    // writer of attention for agent sessions, so `claude-code` deliberately does
    // not declare it and the one authorizer in the dispatcher refuses it there.
    // A second writer would corrupt the ordering guard, which depends on nothing
    // else touching that state.
    expect(agentsCoreManifest.permissions).toContain('attention');
  });

  it('activates on startup, because a hook cannot wake it', () => {
    // A hook arrives because somebody typed `claude`, which is not an activation
    // event. Waking on demand would leave the first turn of every session
    // untracked.
    expect(agentsCoreManifest.activation).toEqual(['onStartup']);
  });
});
