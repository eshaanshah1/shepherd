import { describe, expect, it } from 'vitest';
import { synthTaskRoot, type RepoContribution } from './root-synth.ts';

/**
 * Every assertion here traces to a MEASUREMENT in probe 1
 * (`docs/superpowers/probes/2026-08-07-m3/probe-claude-evidence.txt`), not to a
 * guess about what Claude Code reads.
 */

const repo = (over: Partial<RepoContribution> & { name: string }): RepoContribution => ({
  path: `/tasks/fix-login/${over.name}`,
  skills: [],
  agents: [],
  hasSettings: false,
  ...over,
});

const synth = (repos: readonly RepoContribution[]) =>
  synthTaskRoot({ title: 'Fix login', brief: 'Make the login flow work.', branch: 'slate-merino', repos });

describe('the generated CLAUDE.md', () => {
  it('carries the brief', () => {
    expect(synth([repo({ name: 'api' })]).claudeMd).toContain('Make the login flow work.');
  });

  it('carries the repo map, because a nested CLAUDE.md is NOT loaded at startup', () => {
    // Measured: a nested repo's CLAUDE.md is injected only once the agent touches
    // that subtree. The root file is the only place the orchestrator can learn
    // what repos it has before going looking.
    const out = synth([repo({ name: 'api' }), repo({ name: 'web' })]);
    expect(out.claudeMd).toContain('api');
    expect(out.claudeMd).toContain('web');
  });

  it('names the task', () => {
    expect(synth([repo({ name: 'api' })]).claudeMd).toContain('Fix login');
  });

  it('is produced for a task with no repos at all', () => {
    expect(synth([]).claudeMd).toContain('Make the login flow work.');
  });
});

describe('the link plan', () => {
  it('links a repo skill per entry, not the directory', () => {
    // Measured: both forms work, so the tiebreaker is that only per-entry
    // aggregation can merge N repos into one namespace.
    const out = synth([repo({ name: 'api', skills: ['deploy'] })]);
    expect(out.links).toEqual([
      {
        kind: 'skill',
        repo: 'api',
        linkPath: '.claude/skills/deploy',
        target: '/tasks/fix-login/api/.claude/skills/deploy',
      },
    ]);
  });

  it('links agents too — they are NEVER seen from the task root otherwise', () => {
    // The measurement that makes synthesis required rather than convenient.
    const out = synth([repo({ name: 'api', agents: ['reviewer.md'] })]);
    expect(out.links).toEqual([
      {
        kind: 'agent',
        repo: 'api',
        linkPath: '.claude/agents/reviewer.md',
        target: '/tasks/fix-login/api/.claude/agents/reviewer.md',
      },
    ]);
  });

  it('merges several repos into one namespace when nothing collides', () => {
    const out = synth([
      repo({ name: 'api', skills: ['deploy'] }),
      repo({ name: 'web', skills: ['preview'] }),
    ]);
    expect(out.links.map((l) => l.linkPath)).toEqual([
      '.claude/skills/deploy',
      '.claude/skills/preview',
    ]);
    expect(out.conflicts).toEqual([]);
  });

  it('emits paths relative to the task root, so the plan is root-agnostic', () => {
    const out = synth([repo({ name: 'api', skills: ['deploy'] })]);
    expect(out.links.every((l) => !l.linkPath.startsWith('/'))).toBe(true);
  });
});

describe('collisions — measured to resolve in the FILESYSTEM, silently', () => {
  const colliding = () =>
    synth([
      repo({ name: 'api', skills: ['deploy'] }),
      repo({ name: 'web', skills: ['deploy'] }),
    ]);

  it('namespaces EVERY contributor, so no repo silently wins the bare name', () => {
    const paths = colliding().links.map((l) => l.linkPath);
    expect(paths).toEqual(['.claude/skills/api-deploy', '.claude/skills/web-deploy']);
    expect(paths).not.toContain('.claude/skills/deploy');
  });

  it('reports the collision — an agent running the wrong repo’s skill is the failure', () => {
    expect(colliding().conflicts).toEqual([
      { kind: 'skill', name: 'deploy', repos: ['api', 'web'], resolution: 'namespaced' },
    ]);
  });

  it('never emits two links at one path — the invariant the whole rule exists for', () => {
    const out = synth([
      repo({ name: 'api', skills: ['deploy', 'test'], agents: ['r.md'] }),
      repo({ name: 'web', skills: ['deploy'], agents: ['r.md'] }),
      repo({ name: 'ops', skills: ['deploy'] }),
    ]);
    const paths = out.links.map((l) => l.linkPath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('collides skills and agents independently — they are different namespaces', () => {
    const out = synth([
      repo({ name: 'api', skills: ['deploy'] }),
      repo({ name: 'web', agents: ['deploy'] }),
    ]);
    expect(out.conflicts).toEqual([]);
    expect(out.links.map((l) => l.linkPath)).toEqual([
      '.claude/skills/deploy',
      '.claude/agents/deploy',
    ]);
  });

  it('resolves a namespaced collision the same way every time it is asked', () => {
    expect(colliding()).toEqual(colliding());
  });

  it('does not collide a repo with itself when it lists a name once', () => {
    const out = synth([repo({ name: 'api', skills: ['deploy'] })]);
    expect(out.conflicts).toEqual([]);
  });
});

describe('settings — measured to never load from a nested repo, and NOT aggregatable', () => {
  it('reports a repo whose settings will not apply, rather than dropping it silently', () => {
    const out = synth([repo({ name: 'api', hasSettings: true })]);
    expect(out.notices).toHaveLength(1);
    expect(out.notices[0]).toContain('api');
  });

  it('says nothing when no repo has settings', () => {
    expect(synth([repo({ name: 'api' })]).notices).toEqual([]);
  });

  it('emits no link for settings — one file cannot be N files', () => {
    const out = synth([repo({ name: 'api', hasSettings: true }), repo({ name: 'web', hasSettings: true })]);
    expect(out.links).toEqual([]);
  });
});

describe('purity', () => {
  it('does not mutate its input', () => {
    const repos = [repo({ name: 'api', skills: ['deploy'] }), repo({ name: 'web', skills: ['deploy'] })];
    const before = JSON.stringify(repos);
    synthTaskRoot({ title: 't', brief: 'b', branch: 'slate-merino', repos });
    expect(JSON.stringify(repos)).toBe(before);
  });
});

/**
 * The branch, and permission to change it.
 *
 * A task's branch is minted before anyone knows what the task is about, so the
 * agent working in it is the first party in a position to name it well.
 */
describe('the branch section', () => {
  it('names the branch and the verb that renames it', () => {
    const claudeMd = synth([]).claudeMd;
    expect(claudeMd).toContain('slate-merino');
    expect(claudeMd).toContain('shepherd task rename-branch');
  });

  // It is a prompt to act, not an explanation. An agent needs the door, not the
  // history of why the door is there.
  it('does not explain why the branch is named what it is', () => {
    expect(synth([]).claudeMd).not.toMatch(/random|placeholder|minted|temporary/i);
  });
});
