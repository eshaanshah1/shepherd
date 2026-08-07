import { describe, expect, it } from 'vitest';
import { gitEnv, truncate, MAX_OUTPUT_BYTES } from './exec.ts';

/**
 * The pure decisions inside the runner. `runExec` itself spawns a process and is
 * covered by the app's integration path; what is tested here is everything that
 * can be wrong without a subprocess — and both env rules are v1 bugs the Rebuild
 * checklist asked to make structural rather than remembered.
 */

describe('gitEnv', () => {
  it('sets GIT_OPTIONAL_LOCKS=0 for a read', () => {
    // v1: a plain `git status` REWRITES .git/index, which woke the watcher that
    // had just run it, and the two sustained each other with nothing happening
    // in the repo. This flag is git's own switch for exactly that.
    expect(gitEnv('read', {}, { HOME: '/u/me' }).GIT_OPTIONAL_LOCKS).toBe('0');
  });

  it('does NOT set it for a write, which legitimately takes the lock', () => {
    expect(gitEnv('write', {}, { HOME: '/u/me' }).GIT_OPTIONAL_LOCKS).toBeUndefined();
  });

  it('MERGES into the inherited environment rather than replacing it', () => {
    // v1: replacing loses HOME, and with it git's config — so a `git commit`
    // would fail on an unset user.name in a repo that was configured correctly.
    const env = gitEnv('write', { GIT_EDITOR: 'true' }, { HOME: '/u/me', PATH: '/bin' });
    expect(env.HOME).toBe('/u/me');
    expect(env.PATH).toBe('/bin');
    expect(env.GIT_EDITOR).toBe('true');
  });

  it('lets an explicit override win over the inherited value', () => {
    expect(gitEnv('write', { HOME: '/tmp/fake' }, { HOME: '/u/me' }).HOME).toBe('/tmp/fake');
  });

  it('drops inherited keys with no value, which spawn rejects', () => {
    expect('EMPTY' in gitEnv('read', {}, { HOME: '/u/me', EMPTY: undefined })).toBe(false);
  });
});

describe('truncate', () => {
  it('leaves ordinary output alone', () => {
    expect(truncate('hello')).toEqual({ text: 'hello', truncated: false });
  });

  it('caps output that would otherwise cross the port whole', () => {
    // A `git diff` can be megabytes, and it crosses a message port as a cloned
    // string. Both HTTP ingresses already cap their bodies; this path is the
    // one that did not.
    const out = truncate('x'.repeat(MAX_OUTPUT_BYTES * 2));
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + 200);
  });

  it('SAYS it truncated, in the output itself', () => {
    // Silent truncation reads as a complete answer, which is how a caller
    // concludes a file has no more matches.
    expect(truncate('x'.repeat(MAX_OUTPUT_BYTES * 2)).text).toMatch(/truncat/i);
  });

  it('keeps the beginning, not the end', () => {
    expect(truncate(`START${'x'.repeat(MAX_OUTPUT_BYTES * 2)}`).text.startsWith('START')).toBe(true);
  });
});
