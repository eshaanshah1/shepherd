import { describe, expect, it } from 'vitest';
import { parseArgv } from './argv.ts';

/**
 * The whole CLI, minus the socket.
 *
 * Its job is to turn what a person (or an agent, which is the point — §7b makes
 * this the agent API) typed into the one thing the kernel takes: a command id,
 * some JSON arguments, and a claimed caller. Everything interesting is here, so
 * everything interesting is testable without a running app.
 */

describe('parseArgv', () => {
  it('maps a noun and a verb onto a command id', () => {
    expect(parseArgv(['task', 'list'])).toMatchObject({ ok: true, command: 'tasks.list' });
  });

  it('collects --flags into arguments', () => {
    expect(parseArgv(['task', 'new', '--title', 'Fix login', '--brief', 'Do it'])).toMatchObject({
      ok: true,
      command: 'tasks.create',
      args: { title: 'Fix login', brief: 'Do it' },
    });
  });

  it('accepts --flag=value as well as --flag value', () => {
    expect(parseArgv(['task', 'new', '--title=Fix login'])).toMatchObject({
      ok: true,
      args: { title: 'Fix login' },
    });
  });

  it('collects a repeated --repo into the list a task takes', () => {
    // A task spans 1..n repos, so the one flag anybody repeats is this one.
    expect(parseArgv(['task', 'new', '--title', 'T', '--repo', '/a/api', '--repo', '/b/web'])).toMatchObject({
      ok: true,
      args: {
        title: 'T',
        repos: [
          { path: '/a/api', name: 'api' },
          { path: '/b/web', name: 'web' },
        ],
      },
    });
  });

  it('maps `task delete` onto the command that destroys, which must not be reachable by accident', () => {
    // Named here because this verb is the one that removes worktrees for good:
    // a typo that resolved to some other command id would be a surprise, and a
    // typo that resolved to THIS one would be a loss.
    expect(parseArgv(['task', 'delete', '--task', 'x'])).toMatchObject({
      ok: true,
      command: 'tasks.delete',
      args: { task: 'x' },
    });
  });

  it('claims an agent caller when a session id is in the environment', () => {
    // This is what makes `tasks.spawn` scoped rather than ambient: an agent in a
    // pane is a session, and the kernel authorizes it as one (D9b).
    expect(parseArgv(['task', 'list'], { SHEPHERD_SESSION_ID: 's-1' })).toMatchObject({
      caller: { kind: 'agent', sessionId: 's-1' },
    });
  });

  it('claims the local device when there is no session — a human at a terminal', () => {
    expect(parseArgv(['task', 'list'], {})).toMatchObject({
      caller: { kind: 'device', deviceId: 'local-cli' },
    });
  });

  it('refuses an unknown verb by NAME, and lists what it knows', () => {
    const out = parseArgv(['task', 'frobnicate']);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain('frobnicate');
      expect(out.error).toContain('list');
    }
  });

  it('refuses an unknown noun', () => {
    expect(parseArgv(['wombat', 'list']).ok).toBe(false);
  });

  it('refuses nothing at all, rather than doing something', () => {
    expect(parseArgv([]).ok).toBe(false);
  });

  it('refuses a flag with no value instead of passing undefined along', () => {
    expect(parseArgv(['task', 'new', '--title']).ok).toBe(false);
  });

  it('passes a bare command id straight through, so a new verb needs no CLI release', () => {
    // The registry is the verb table; this is a transport. An agent that knows a
    // command id must not have to wait for this file to learn it.
    expect(parseArgv(['raw', 'agents.list'])).toMatchObject({ ok: true, command: 'agents.list' });
  });
});
