import { describe, expect, it } from 'vitest';
import { hookRelay } from './hook-relay.ts';
import type { HookEnvelope } from '@shepherd/core';

/**
 * The app's own replay-then-live boundary, and it exists because of a measured
 * failure.
 *
 * The daemon flushes its hook journal inside the handshake — it has to, or it
 * would hold events for a client that has already gone live. But the handshake
 * happens in `whenReady` long before the extension host is forked, and the bus has
 * no retention: an emit with no subscriber is simply gone. So the replay landed on
 * an empty bus and the restart smoke read `working` for a turn that had ended.
 *
 * Nothing in main knows when a CHILD subscribes to a topic — `agents-core` says so
 * in as many words — but main does know when it has finished activating its
 * startup extensions, and `agents-core` declares `onStartup` precisely so it is
 * subscribed before the first hook. That moment is `goLive`.
 */

const hook = (event: string): HookEnvelope => ({
  topic: 'claude.hook',
  sessionId: 'session-1',
  payload: { event },
});

const events = (seen: HookEnvelope[]): string[] =>
  seen.map((e) => (e.payload as { event: string }).event);

describe('hookRelay', () => {
  it('holds what arrives before anything can consume it', () => {
    const seen: HookEnvelope[] = [];
    const relay = hookRelay((e) => void seen.push(e));

    relay.receive(hook('Stop'));

    expect(seen).toEqual([]);
    expect(relay.buffered).toBe(1);
  });

  it('flushes in arrival order once the consumers exist', () => {
    // Order is the whole value of the replay: the reducer folds these in sequence,
    // and `UserPromptSubmit` after `Stop` is a different state than before it.
    const seen: HookEnvelope[] = [];
    const relay = hookRelay((e) => void seen.push(e));
    relay.receive(hook('PreToolUse'));
    relay.receive(hook('Stop'));

    relay.goLive();

    expect(events(seen)).toEqual(['PreToolUse', 'Stop']);
    expect(relay.buffered).toBe(0);
  });

  it('passes straight through afterwards', () => {
    const seen: HookEnvelope[] = [];
    const relay = hookRelay((e) => void seen.push(e));
    relay.goLive();

    relay.receive(hook('UserPromptSubmit'));

    expect(events(seen)).toEqual(['UserPromptSubmit']);
  });

  it('does not replay a second time when asked to go live again', () => {
    // A reconnect re-handshakes and the daemon may flush again; going live is a
    // one-way door, so a second call must not re-emit what was already folded.
    const seen: HookEnvelope[] = [];
    const relay = hookRelay((e) => void seen.push(e));
    relay.receive(hook('Stop'));
    relay.goLive();

    relay.goLive();

    expect(events(seen)).toEqual(['Stop']);
  });

  it('keeps delivering when one emit throws', () => {
    // A throwing consumer must not cost the remaining events theirs — the same
    // rule every fan-out in this codebase keeps.
    const seen: HookEnvelope[] = [];
    const relay = hookRelay((e) => {
      if ((e.payload as { event: string }).event === 'bad') throw new Error('nope');
      seen.push(e);
    });
    relay.receive(hook('bad'));
    relay.receive(hook('Stop'));

    relay.goLive();

    expect(events(seen)).toEqual(['Stop']);
  });
});
