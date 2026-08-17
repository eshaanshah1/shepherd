import { describe, expect, it } from 'vitest';
import { diagnosticsManifest } from '@shepherd/ext-diagnostics/manifest';
import { agentsCoreManifest } from '@shepherd/ext-agents-core/manifest';
import { claudeCodeManifest } from '@shepherd/ext-claude-code/manifest';
import { tasksManifest } from '@shepherd/ext-tasks/manifest';
import { worktreeHookManifest } from '@shepherd/ext-worktree-hook/manifest';
import { githubManifest } from '@shepherd/ext-github/manifest';
import { transcriptsManifest } from '@shepherd/ext-transcripts/manifest';
import { BUILTIN_MODULES } from './builtins.ts';

/**
 * Every built-in main registers must have its code compiled into this build.
 *
 * The two lists are maintained by hand in two files — `main/index.ts` names the
 * manifests, `builtins.ts` names the modules — and adding an extension to one
 * and not the other produces an app that boots, logs `activation failed: no
 * built-in module for …` among a hundred other lines, and is simply missing a
 * feature. That is what happened to `shepherd.worktree-hook`, and it took an
 * end-to-end smoke to notice. This is the cheap version of that smoke.
 *
 * The manifest list here is deliberately a literal rather than an import from
 * `main/index.ts`: the loops there are inline, so there is nothing to import,
 * and a test that derived both sides from one source would pass no matter what.
 */

const REGISTERED = [
  diagnosticsManifest,
  agentsCoreManifest,
  claudeCodeManifest,
  tasksManifest,
  worktreeHookManifest,
  githubManifest,
  transcriptsManifest,
];

describe('the built-in module table', () => {
  it.each(REGISTERED.map((manifest) => manifest.id))('has the code for %s', (id) => {
    expect(BUILTIN_MODULES.get(id)).toBeTypeOf('function');
  });

  it('contains nothing main does not register', () => {
    // The other direction: a module compiled in but never registered is dead
    // weight in the bundle and a feature nobody can reach.
    expect([...BUILTIN_MODULES.keys()].sort()).toEqual(REGISTERED.map((manifest) => manifest.id).sort());
  });
});
