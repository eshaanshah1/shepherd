import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENTS_CORE_ID, claudeCodeManifest } from './manifest.ts';

const packaged = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { shepherd: unknown };

describe('the manifest', () => {
  it('matches package.json exactly', () => {
    expect(packaged.shepherd).toEqual(claudeCodeManifest);
  });

  it('declares agents-core as a dependency, which is also its activation order', () => {
    // Declared, not discovered (§7c) — and `ExtensionRegistry` activates a
    // manifest's dependencies before it, so this line is what guarantees the
    // kind can be registered at all.
    expect(claudeCodeManifest.dependencies).toEqual([AGENTS_CORE_ID]);
  });

  it('does NOT declare attention, and that is enforcement', () => {
    // agents-core is the only writer of attention for agent sessions. Because
    // this manifest omits it, the one authorizer in the dispatcher refuses any
    // attempt from here — the invariant holds by construction rather than by a
    // reviewer noticing. A second writer would corrupt the ordering guard.
    expect(claudeCodeManifest.permissions).not.toContain('attention');
  });
});
