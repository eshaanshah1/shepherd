import { describe, expect, it } from 'vitest';
import { CommandRegistry, emptyGrants } from '@shepherd/core';
import { manualClock, nullLogger, type Caller } from '@shepherd/sdk';
import { capturePath, registerCaptureCommand, type CaptureImage } from './capture-command.ts';

/**
 * The decisions, without Electron.
 *
 * `capturePage()` itself is smoke territory — it needs a real window with real
 * pixels, and faking it would assert nothing. What IS decided here is where the
 * PNG lands, that the bytes reach it, that the permission is the gate, and what
 * happens when there is no window: every one of those is a branch that would
 * otherwise only be exercised by a human looking at a file that did or did not
 * appear.
 */

const LOCAL: Caller = { kind: 'device', deviceId: 'local-cli' };
const IMAGE: CaptureImage = { png: new Uint8Array([137, 80, 78, 71]), width: 1280, height: 800 };

interface Harness {
  readonly registry: CommandRegistry;
  readonly written: { path: string; png: Uint8Array }[];
}

function harness(over: { capture?: () => Promise<CaptureImage | null> } = {}): Harness {
  const written: { path: string; png: Uint8Array }[] = [];
  const registry = new CommandRegistry({
    logger: nullLogger,
    // The local device gets `layout`, which is how it reaches this command at
    // all — the denial case gets its own grant set below.
    grants: () => ({ ...emptyGrants(), devices: new Map([['local-cli', ['layout'] as const]]) }),
  });
  registerCaptureCommand({
    registry,
    clock: manualClock(1_754_640_000_000),
    supportDir: '/support',
    capture: over.capture ?? (() => Promise.resolve(IMAGE)),
    write: (path, png) => {
      written.push({ path, png });
      return Promise.resolve();
    },
  });
  return { registry, written };
}

describe('capturePath', () => {
  it('takes the caller’s path verbatim, because that is the whole point of naming one', () => {
    expect(capturePath({ path: '/tmp/x.png', supportDir: '/support', at: 0 })).toBe('/tmp/x.png');
  });

  it('falls back to a TIMESTAMPED file, so a second capture does not overwrite the first', () => {
    const first = capturePath({ supportDir: '/support', at: 1_754_640_000_000 });
    const second = capturePath({ supportDir: '/support', at: 1_754_640_001_000 });
    expect(first).not.toBe(second);
    expect(first.startsWith('/support/capture-')).toBe(true);
  });

  it('leaves no colon in the name — an ISO string is not a filename everywhere', () => {
    // A path that silently fails to be creatable is the worst of the available
    // answers: the command reports success and names a file nobody can find.
    expect(capturePath({ supportDir: '/support', at: 1_754_640_000_000 })).not.toContain(':');
  });

  it('treats an EMPTY path as unnamed rather than as the current directory', () => {
    // `--path ` cannot happen through the CLI (a valueless flag is refused), but
    // an empty string over the socket would otherwise write to a bare filename.
    expect(capturePath({ path: '', supportDir: '/support', at: 1 })).toBe(capturePath({ supportDir: '/support', at: 1 }));
  });
});

describe('window.capture', () => {
  it('writes the PNG where it was asked and answers with the path and the size', async () => {
    const h = harness();
    const result = await h.registry.invoke('window.capture', { path: '/tmp/x.png' }, LOCAL);

    expect(result).toEqual({ ok: true, value: { path: '/tmp/x.png', width: 1280, height: 800 } });
    // The BYTES, not just the path: a command that answered correctly and wrote
    // an empty file would pass every assertion about its return value.
    expect(h.written).toEqual([{ path: '/tmp/x.png', png: IMAGE.png }]);
  });

  it('defaults to the support dir, and the answer names the file it actually wrote', async () => {
    const h = harness();
    const result = (await h.registry.invoke('window.capture', {}, LOCAL)) as { ok: true; value: { path: string } };

    expect(result.ok).toBe(true);
    expect(result.value.path.startsWith('/support/capture-')).toBe(true);
    expect(h.written[0]?.path).toBe(result.value.path);
  });

  it('FAILS when there is no window, rather than naming a file it never wrote', async () => {
    // Reachable on macOS, where the app outlives its last window.
    const h = harness({ capture: () => Promise.resolve(null) });
    const result = await h.registry.invoke('window.capture', {}, LOCAL);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toContain('no window to capture');
    expect(h.written).toEqual([]);
  });

  it('is gated on `layout`, because what comes back is the contents of your screen', async () => {
    const h = harness();
    const stranger: Caller = { kind: 'device', deviceId: 'phone' };
    const result = await h.registry.invoke('window.capture', { path: '/tmp/x.png' }, stranger);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('denied');
    expect(h.written).toEqual([]);
  });
});
