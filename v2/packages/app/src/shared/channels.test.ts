import { describe, expect, it } from 'vitest';
import { COALESCE, EMIT, INVOKE, emitChannels, invokeChannels } from './channels.ts';

describe('IPC channels', () => {
  it('has no name used by two channels — the preload allow-list is keyed by name', () => {
    const all = [...invokeChannels, ...emitChannels];
    expect(new Set(all).size).toBe(all.length);
  });

  it('namespaces every channel `<domain>:<verb>`', () => {
    for (const name of [...invokeChannels, ...emitChannels]) {
      expect(name, name).toMatch(/^[a-z]+:[a-z]+$/);
    }
  });

  it('keeps request/response and push channels disjoint', () => {
    const pushes = new Set<string>(emitChannels);
    for (const name of invokeChannels) expect(pushes.has(name)).toBe(false);
  });

  it('covers the session verbs the renderer needs', () => {
    expect(Object.keys(INVOKE)).toEqual(
      expect.arrayContaining([
        'sessionCreate',
        'sessionAttach',
        'sessionWrite',
        'sessionResize',
        'sessionKill',
      ]),
    );
    expect(EMIT.sessionData).toBe('session:data');
  });
});

describe('COALESCE', () => {
  it('flushes within half a frame at 60Hz', () => {
    expect(COALESCE.intervalMs).toBeGreaterThan(0);
    expect(COALESCE.intervalMs).toBeLessThanOrEqual(8);
  });

  it('caps a pending batch well under a megabyte', () => {
    expect(COALESCE.maxBytes).toBeGreaterThanOrEqual(16 * 1024);
    expect(COALESCE.maxBytes).toBeLessThanOrEqual(64 * 1024);
  });
});
