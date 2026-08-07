import { describe, expect, it } from 'vitest';
import {
  childFrameSchema,
  EXT_PROTOCOL_VERSION,
  frameIds,
  hostFrameSchema,
  negotiate,
  readFrames,
  wireErr,
  wireOk,
  type ChildFrame,
} from './ext-protocol.ts';

/**
 * The frame union's own decisions. Three of them are the reason the file exists,
 * so each gets a negative control:
 *
 *   - a version is negotiated, and a refusal names BOTH numbers;
 *   - a bad element in a batch costs only itself;
 *   - a frame cannot name a principal.
 */

describe('negotiate', () => {
  it('accepts the version this build speaks', () => {
    expect(negotiate(EXT_PROTOCOL_VERSION)).toEqual({ ok: true, value: EXT_PROTOCOL_VERSION });
  });

  it('refuses an unknown version and names both sides', () => {
    const verdict = negotiate(7);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    // Both numbers, because "protocol mismatch" sends the reader to two files.
    expect(verdict.error).toContain('speaks protocol 7');
    expect(verdict.error).toContain(String(EXT_PROTOCOL_VERSION));
  });

  it('refuses a non-integer without throwing', () => {
    for (const claimed of [undefined, null, '1', 1.5, {}]) {
      const verdict = negotiate(claimed);
      expect(verdict.ok).toBe(false);
    }
  });
});

describe('readFrames', () => {
  const hello: ChildFrame = { kind: 'hello', id: 'c-1', protocol: EXT_PROTOCOL_VERSION, childPid: 4242 };

  it('reads a single frame', () => {
    const read = readFrames(hello, childFrameSchema);
    expect(read.frames).toEqual([hello]);
    expect(read.skipped).toEqual([]);
  });

  it('keeps the frames it understood when one element in a batch is unknown', () => {
    const answer: ChildFrame = { kind: 'answer', id: 'c-2', result: wireOk('done') };
    const read = readFrames([hello, { kind: 'from-the-future', wat: 1 }, answer], childFrameSchema);

    // The batch rule: one bad element must not cost the other two. A reader that
    // returned [] here is review §Bad-2 reincarnated in the extension bridge.
    expect(read.frames).toEqual([hello, answer]);
    expect(read.skipped).toHaveLength(1);
    expect(read.skipped[0]).toContain('frame[1]');
    expect(read.skipped[0]).toContain('kind="from-the-future"');
  });

  it('skips rather than throws on any garbage', () => {
    for (const garbage of [null, undefined, 7, 'hello', [1, 2]]) {
      expect(() => readFrames(garbage, childFrameSchema)).not.toThrow();
      expect(readFrames(garbage, childFrameSchema).frames).toEqual([]);
    }
  });

  it('refuses a call frame that tries to name its own extension', () => {
    // The spoof. A `call` carries a `handle` the host minted and nothing else
    // identifying — an `extensionId` field is an unknown key, and `s.object`
    // rejects those rather than dropping them, so the frame never dispatches.
    const honest = { kind: 'call', id: 'c-9', handle: 'handle-for-diagnostics', call: { kind: 'command.invoke', commandId: 'diagnostics.ping' } };
    const spoof = { ...honest, extensionId: 'shepherd.some-other-extension' };

    // The control: the extra key is the ONLY difference, so the refusal below is
    // about naming a principal and not about some other defect in the frame.
    expect(readFrames(honest, childFrameSchema).frames).toEqual([honest]);
    expect(readFrames(spoof, childFrameSchema).frames).toEqual([]);
    expect(readFrames(spoof, childFrameSchema).skipped[0]).toContain('kind="call"');
  });

  it('round-trips a success with no value', () => {
    const read = readFrames({ kind: 'answer', id: 'c-3', result: wireOk() }, childFrameSchema);
    expect(read.frames).toHaveLength(1);
    expect(read.frames[0]).toEqual({ kind: 'answer', id: 'c-3', result: { ok: true } });
  });

  it('round-trips a typed failure', () => {
    const read = readFrames(
      { kind: 'answer', id: 'c-4', result: wireErr('denied', 'lacks permission "attention"') },
      childFrameSchema,
    );
    expect(read.frames[0]).toEqual({
      kind: 'answer',
      id: 'c-4',
      result: { ok: false, error: { code: 'denied', message: 'lacks permission "attention"' } },
    });
  });

  it('reads a host activate ask, manifest and caller included', () => {
    const ask = {
      kind: 'ask' as const,
      id: 'h-1',
      ask: {
        kind: 'activate' as const,
        extension: 'shepherd.diagnostics',
        handle: 'opaque',
        manifest: {
          id: 'shepherd.diagnostics',
          name: 'Diagnostics',
          version: '0.1.0',
          api: '^1.0.0',
          activation: ['onStartup'],
          permissions: ['storage'],
        },
        source: 'builtin' as const,
        proposed: true,
        apiVersion: '1.0.0',
        permissions: ['storage'],
        storage: { pings: 4 },
      },
    };
    expect(readFrames(ask, hostFrameSchema).frames).toEqual([ask]);
  });

  it('reads a command ask carrying the real caller', () => {
    const ask = {
      kind: 'ask' as const,
      id: 'h-2',
      ask: {
        kind: 'command' as const,
        extension: 'shepherd.diagnostics',
        commandId: 'diagnostics.ping',
        caller: { kind: 'device' as const, deviceId: 'local-cli' },
      },
    };
    expect(readFrames(ask, hostFrameSchema).frames).toEqual([ask]);
  });
});

describe('frameIds', () => {
  it('mints prefixed, monotonic ids so an out-of-order log still reads', () => {
    const next = frameIds('host');
    expect([next(), next(), next()]).toEqual(['host-1', 'host-2', 'host-3']);
  });

  it('gives two factories independent counters', () => {
    const a = frameIds('a');
    const b = frameIds('b');
    a();
    expect(b()).toBe('b-1');
  });
});
