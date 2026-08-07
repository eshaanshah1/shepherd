import { describe, expect, it } from 'vitest';
import { sessionId } from '@shepherd/sdk';
import { correlationEnv } from './correlation-env.ts';

/**
 * The env a hook reads back. Two things are pinned here and they are different
 * claims: that the three variables carry what a hook needs to correlate, and
 * that none of them is one of v1's — a name collision is not a style problem,
 * it is a hook posting to the wrong running app.
 */

const ENV = correlationEnv({
  sessionId: sessionId('sess-1'),
  eventsSocket: '/tmp/support/hooks.sock',
  controlSocket: '/tmp/support/control.sock',
});

describe('correlationEnv', () => {
  it('carries the session id and both socket paths, and nothing else', () => {
    expect(ENV).toEqual({
      SHEPHERD_SESSION_ID: 'sess-1',
      SHEPHERD_EVENTS_SOCK: '/tmp/support/hooks.sock',
      SHEPHERD_CONTROL_SOCK: '/tmp/support/control.sock',
    });
  });

  it('names v1 none of its variables', () => {
    // The negative control, and the reason this file exists. v1's plugin is
    // installed globally on the dev machine and fires on
    // `SHEPHERD_TAB_ID` + `SHEPHERD_SOCK`, so reusing either name puts a v2
    // agent's `Stop` into the live v1 app — a pane in another application
    // flipping state on behalf of a session it has never heard of.
    for (const name of ['SHEPHERD_TAB_ID', 'SHEPHERD_SOCK', 'SHEPHERD_CTL_SOCK', 'SHEPHERD_PTY_SOCK']) {
      expect(Object.keys(ENV)).not.toContain(name);
    }
  });

  it('holds the SESSION id, not a pane id', () => {
    // v1's `tab_id` held a pane id across ~10 files. The value here is the
    // draft's own session id and the assertion says so by construction.
    const id = sessionId('sess-9');
    expect(correlationEnv({ sessionId: id, eventsSocket: 'e', controlSocket: 'c' })['SHEPHERD_SESSION_ID']).toBe(id);
  });

  it('is a plain string record, mergeable as a WillCreatePatch env', () => {
    // `SessionHost` merges a patch key by key into the resolved spec's env; a
    // non-string value would reach `node-pty` and die there rather than here.
    for (const value of Object.values(ENV)) expect(typeof value).toBe('string');
  });
});
