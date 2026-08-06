import { describe, expect, it } from 'vitest';
import { newPaneId, newSessionId } from './identity.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('identity', () => {
  it('mints a v4 uuid by default', () => {
    expect(newSessionId()).toMatch(UUID);
    expect(newPaneId()).toMatch(UUID);
  });

  it('never repeats an id', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newSessionId()));
    expect(ids.size).toBe(5000);
  });

  it('takes an injected generator so a test can name the id it is about', () => {
    let n = 0;
    const fake = () => `session-${(n += 1)}`;
    expect(newSessionId(fake)).toBe('session-1');
    expect(newSessionId(fake)).toBe('session-2');
  });
});
