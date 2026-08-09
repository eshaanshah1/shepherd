// The framing contract, asserted at exact byte boundaries.
//
// A socket delivers whatever it delivers, and every shape below is something it
// really does: half a header, three frames at once, a snapshot split across a
// dozen chunks. This is the class of defect that works on one machine and
// corrupts under load, so it is tested by construction rather than by
// round-tripping a happy case.

import { describe, expect, it } from 'vitest';
import {
  FrameDecoder,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  REQUEST,
  RESPONSE,
  encodeByteFrame,
  encodeJsonFrame,
  isByteKind,
} from './protocol.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** Everything a decoder yields for one input, for brevity below. */
function decodeAll(chunks: readonly Uint8Array[], max?: number) {
  const decoder = new FrameDecoder(max);
  const frames = [];
  let error;
  for (const chunk of chunks) {
    const result = decoder.feed(chunk);
    frames.push(...result.frames);
    if (result.error) {
      error = result.error;
      break;
    }
  }
  return { frames, error, decoder };
}

describe('frames', () => {
  it('round-trips a JSON frame', () => {
    const { frames } = decodeAll([encodeJsonFrame(REQUEST.hello, { version: PROTOCOL_VERSION })]);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe(REQUEST.hello);
    expect(frames[0]?.json).toEqual({ version: PROTOCOL_VERSION });
  });

  /**
   * The hot path. Bytes must arrive byte-identical and must never have been a
   * string on the way — `host.ts` opens the pty with `encoding: null` exactly so
   * a multi-byte sequence is not decoded at a chunk boundary, and a protocol
   * that base64'd or stringified them would undo that where it matters most.
   */
  it('round-trips a byte frame without touching the bytes', () => {
    // A deliberately hostile payload: a NUL, a lone continuation byte, and the
    // start of a multi-byte sequence with its tail missing.
    const payload = new Uint8Array([0x00, 0xff, 0xe6, 0x97, 0x1b, 0x5b, 0x41]);
    const { frames } = decodeAll([encodeByteFrame(RESPONSE.data, 'sess-1', payload)]);
    expect(frames[0]?.sessionId).toBe('sess-1');
    expect([...(frames[0]?.bytes ?? [])]).toEqual([...payload]);
  });

  it('knows which kinds carry bytes', () => {
    expect(isByteKind(RESPONSE.data)).toBe(true);
    expect(isByteKind(REQUEST.write)).toBe(true);
    expect(isByteKind(REQUEST.hello)).toBe(false);
    expect(isByteKind(RESPONSE.ok)).toBe(false);
  });

  it('yields several frames arriving in ONE chunk', () => {
    const wire = concat([
      encodeJsonFrame(REQUEST.list, {}),
      encodeByteFrame(RESPONSE.data, 's', bytes('one')),
      encodeJsonFrame(RESPONSE.ok, { seq: 3 }),
    ]);
    const { frames } = decodeAll([wire]);
    expect(frames.map((f) => f.kind)).toEqual([REQUEST.list, RESPONSE.data, RESPONSE.ok]);
    expect(text(frames[1]?.bytes ?? new Uint8Array())).toBe('one');
  });

  it('yields nothing until a frame is whole, then yields it', () => {
    const wire = encodeJsonFrame(RESPONSE.ok, { seq: 7, value: 'x'.repeat(50) });
    const decoder = new FrameDecoder();
    // One byte at a time — the pathological case, and the one that catches a
    // decoder that reads the header before it has all five bytes.
    for (let i = 0; i < wire.length - 1; i += 1) {
      expect(decoder.feed(wire.subarray(i, i + 1)).frames).toHaveLength(0);
    }
    const last = decoder.feed(wire.subarray(wire.length - 1));
    expect(last.frames).toHaveLength(1);
    expect(last.frames[0]?.json).toEqual({ seq: 7, value: 'x'.repeat(50) });
  });

  it('reassembles a large payload split across many chunks', () => {
    const payload = new Uint8Array(200_000).map((_, i) => i % 251);
    const wire = encodeByteFrame(RESPONSE.data, 'big', payload);
    const chunks = [];
    for (let at = 0; at < wire.length; at += 4096) chunks.push(wire.subarray(at, at + 4096));
    const { frames } = decodeAll(chunks);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.bytes).toEqual(payload);
  });

  it('keeps a trailing partial frame for the next chunk', () => {
    const first = encodeJsonFrame(RESPONSE.ok, { seq: 1 });
    const second = encodeJsonFrame(RESPONSE.ok, { seq: 2 });
    const decoder = new FrameDecoder();
    const round = decoder.feed(concat([first, second.subarray(0, 3)]));
    expect(round.frames).toHaveLength(1);
    expect(decoder.feed(second.subarray(3)).frames[0]?.json).toEqual({ seq: 2 });
  });

  it('carries an empty byte payload', () => {
    const { frames } = decodeAll([encodeByteFrame(RESPONSE.data, 's', new Uint8Array(0))]);
    expect(frames[0]?.bytes).toEqual(new Uint8Array(0));
  });

  /**
   * A delivered frame must OWN its bytes, not view the decoder's buffer.
   *
   * Written first as "keep some bytes, feed more, check they did not change",
   * and that test was **vacuous**: this decoder reallocates on every feed, so a
   * `subarray` view points at an array nobody mutates and the assertion passes
   * with the defect planted. Verified by planting it.
   *
   * The property that is actually checkable is ownership — a `slice` returns a
   * view over a buffer of exactly its own length, a `subarray` returns a window
   * onto a larger one. That distinction is what stops a future in-place or
   * pooled buffer from silently corrupting bytes a sink is still holding, and it
   * fails immediately if the copy is removed.
   */
  it('hands back bytes that OWN their buffer, not a window onto the decoder’s', () => {
    const decoder = new FrameDecoder();
    const payload = bytes('KEEP-ME');
    const { frames } = decoder.feed(
      concat([
        encodeByteFrame(RESPONSE.data, 's', payload),
        encodeJsonFrame(RESPONSE.ok, { trailing: true }),
      ]),
    );
    const kept = frames[0]?.bytes as Uint8Array;
    expect(text(kept)).toBe('KEEP-ME');
    expect(kept.byteOffset).toBe(0);
    expect(kept.buffer.byteLength).toBe(kept.byteLength);
  });

});

describe('refusals', () => {
  /**
   * An unbounded decoder is a memory denial-of-service reachable from a socket.
   * The refusal must happen on the HEADER — before anything is allocated or
   * buffered toward the claimed length.
   */
  it('refuses an oversized frame without buffering toward it', () => {
    const header = new Uint8Array(5);
    new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1, true);
    header[4] = RESPONSE.data;

    const decoder = new FrameDecoder();
    const result = decoder.feed(header);
    expect(result.error?.code).toBe('frame-too-large');
    expect(result.frames).toHaveLength(0);
  });

  it('stays failed once it has failed, because a stream cannot be resynchronized', () => {
    const decoder = new FrameDecoder(64);
    const header = new Uint8Array(5);
    new DataView(header.buffer).setUint32(0, 1000, true);
    header[4] = RESPONSE.ok;
    expect(decoder.feed(header).error?.code).toBe('frame-too-large');

    // A perfectly good frame afterwards is still refused: there is no framing
    // marker to hunt for (by design), so the position in the stream is lost.
    const good = decoder.feed(encodeJsonFrame(RESPONSE.ok, { seq: 1 }));
    expect(good.frames).toHaveLength(0);
    expect(good.error?.code).toBe('frame-too-large');
    expect(decoder.failed?.code).toBe('frame-too-large');
  });

  it('refuses a frame with no kind byte', () => {
    const header = new Uint8Array(5);
    new DataView(header.buffer).setUint32(0, 0, true);
    expect(decodeAll([header]).error?.code).toBe('malformed-frame');
  });

  it('refuses invalid JSON rather than throwing', () => {
    const payload = bytes('{not json');
    const wire = new Uint8Array(5 + payload.length);
    new DataView(wire.buffer).setUint32(0, payload.length + 1, true);
    wire[4] = RESPONSE.ok;
    wire.set(payload, 5);
    expect(decodeAll([wire]).error?.code).toBe('bad-json');
  });

  it('refuses a byte frame whose session id is truncated', () => {
    const payload = new Uint8Array([200, 0x61]); // claims a 200-byte id, carries 1
    const wire = new Uint8Array(5 + payload.length);
    new DataView(wire.buffer).setUint32(0, payload.length + 1, true);
    wire[4] = RESPONSE.data;
    wire.set(payload, 5);
    expect(decodeAll([wire]).error?.code).toBe('malformed-frame');
  });

  it('refuses to encode a session id that cannot be length-prefixed', () => {
    expect(() => encodeByteFrame(RESPONSE.data, 'x'.repeat(256), new Uint8Array(0))).toThrow(
      RangeError,
    );
  });
});

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
