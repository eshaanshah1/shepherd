/**
 * The framed protocol a session client and the daemon speak.
 *
 * Pure: no socket, no `SessionHost`, no process. That is what lets the framing
 * contract — the one thing here that is genuinely easy to get wrong — be
 * asserted against exact byte boundaries rather than inferred from a working
 * connection.
 *
 * **Two payload shapes, and the split is the point.** Control messages are JSON.
 * `data` and `write` are RAW BYTES with a session id in the header, and they
 * never pass through JSON: base64 inflates the hot path by a third, and
 * `host.ts` opens the pty with `encoding: null` precisely so a multi-byte
 * sequence is never decoded at a chunk boundary. A protocol that stringified
 * them would undo that in the one place it matters most.
 *
 * Frame layout, little-endian:
 *
 *     [u32 length][u8 kind][payload…]
 *      ^ of kind + payload, NOT of itself
 *
 * For byte frames the payload is `[u8 idLength][id…][bytes…]`; for JSON frames
 * it is UTF-8 JSON.
 */

/** Bumped when a field changes meaning. A mismatch is refused, never guessed. */
export const PROTOCOL_VERSION = 1;

/**
 * The largest frame that will ever be accepted.
 *
 * An unbounded decoder is a memory denial-of-service reachable from a socket:
 * a peer sends `length = 0xFFFFFFFF` and the decoder allocates, or buffers
 * forever waiting for bytes that never come. 16 MB is far above any real frame
 * (the biggest is a screen snapshot, ~55 KB at the default depth) and far below
 * anything that hurts.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const HEADER_BYTES = 5;

/** Client → daemon. */
export const REQUEST = {
  hello: 1,
  create: 2,
  attach: 3,
  detach: 4,
  write: 5,
  paste: 6,
  resize: 7,
  kill: 8,
  list: 9,
  screen: 10,
  setViewport: 11,
  snapshot: 12,
  /** The liveness sweep's only input; see `SessionHost.foreground`. */
  foreground: 13,
} as const;

/** Daemon → client. */
export const RESPONSE = {
  ok: 64,
  err: 65,
  /** Raw pty output. A BYTE frame — see the file comment. */
  data: 66,
  exit: 67,
  /**
   * A serialized screen, answering `snapshot`. A BYTE frame, and a kind of its
   * own rather than a `data` frame, because the client has to tell it apart:
   * ONE process may hold several viewers of one session, and a viewer attaching
   * late needs the screen delivered to IT and not to the others, who already
   * have it. Sharing `data` would mean guessing from arrival order, which live
   * output can beat.
   */
  snapshot: 68,
  /**
   * The pty changed size. A JSON frame: `{ sessionId, cols, rows }`.
   *
   * It exists because **one pty has one size and several viewers**, and the size
   * is arbitrated (smallest wins) rather than owned by whoever is looking. A
   * viewer that is not told renders bytes laid out for somebody else's grid:
   * with a phone attached the Mac silently dropped lines, and a phone attaching
   * to a wide session painted a mangled screen. Neither reported anything,
   * because from each end's point of view nothing had failed.
   *
   * A fresh snapshot follows it, always — resizing an emulator reflows the grid
   * but nothing redraws the CONTENT, so the size and the screen have to arrive
   * together or the viewer is correct-sized and stale.
   */
  resized: 69,
  /**
   * A session's program named itself or changed directory. A JSON frame:
   * `{ sessionId, title?, cwd? }`, carrying only what changed.
   *
   * **Broadcast to every client, unlike `resized`.** A resize matters only to
   * somebody painting, so it is gated on attachment. This is the opposite case:
   * a suspended pane detaches, and it is exactly that tab whose label would
   * otherwise freeze at whatever it said when you last looked at it.
   */
  observed: 70,
} as const;

export type RequestKind = (typeof REQUEST)[keyof typeof REQUEST];
export type ResponseKind = (typeof RESPONSE)[keyof typeof RESPONSE];
export type FrameKind = RequestKind | ResponseKind;

/** The kinds whose payload is raw bytes rather than JSON. */
const BYTE_KINDS = new Set<number>([REQUEST.write, RESPONSE.data, RESPONSE.snapshot]);

export function isByteKind(kind: number): boolean {
  return BYTE_KINDS.has(kind);
}

export interface Frame {
  readonly kind: FrameKind;
  /** JSON frames only. */
  readonly json?: unknown;
  /** Byte frames only. */
  readonly sessionId?: string;
  readonly bytes?: Uint8Array;
}

export type ProtocolErrorCode = 'frame-too-large' | 'malformed-frame' | 'bad-json';

export interface ProtocolError {
  readonly code: ProtocolErrorCode;
  readonly message: string;
}

// ------------------------------------------------------------------- encoding

export function encodeJsonFrame(kind: FrameKind, json: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(json));
  return frameOf(kind, payload);
}

/**
 * `[u8 idLength][id][bytes]`. The id is length-prefixed rather than delimited
 * because a delimiter would have to be escaped out of the byte payload, which is
 * the one thing this frame exists to avoid touching.
 */
export function encodeByteFrame(kind: FrameKind, sessionId: string, bytes: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(sessionId);
  if (id.length > 255) throw new RangeError(`session id too long to frame: ${id.length} bytes`);
  const payload = new Uint8Array(1 + id.length + bytes.length);
  payload[0] = id.length;
  payload.set(id, 1);
  payload.set(bytes, 1 + id.length);
  return frameOf(kind, payload);
}

function frameOf(kind: FrameKind, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length + 1, true);
  out[4] = kind;
  out.set(payload, HEADER_BYTES);
  return out;
}

// ------------------------------------------------------------------- decoding

/**
 * Accumulates socket chunks and yields whole frames.
 *
 * A socket delivers whatever it delivers: half a header, three frames in one
 * chunk, a 55 KB snapshot split across a dozen. Every one of those is a case
 * here, and each has a test — this is the class of bug that shows up as "it
 * works on my machine and corrupts under load".
 *
 * A frame over `MAX_FRAME_BYTES` is a TERMINAL error: `feed` reports it and the
 * decoder refuses everything afterwards, because the stream can no longer be
 * resynchronized — there is no framing marker to hunt for, by design. The caller
 * is expected to drop the connection.
 */
export class FrameDecoder {
  /**
   * `ArrayBufferLike`, not `ArrayBuffer`: `concat` returns whatever the incoming
   * chunk was backed by, and a socket chunk can be a view over a pooled buffer.
   */
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  #failed: ProtocolError | undefined;
  /** A field, not a parameter property — `erasableSyntaxOnly` forbids those. */
  readonly #max: number;

  constructor(max: number = MAX_FRAME_BYTES) {
    this.#max = max;
  }

  get failed(): ProtocolError | undefined {
    return this.#failed;
  }

  feed(chunk: Uint8Array): { frames: Frame[]; error?: ProtocolError } {
    if (this.#failed) return { frames: [], error: this.#failed };

    this.#buffer = concat(this.#buffer, chunk);
    const frames: Frame[] = [];

    for (;;) {
      if (this.#buffer.length < HEADER_BYTES) break;
      const view = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset,
        this.#buffer.byteLength,
      );
      const length = view.getUint32(0, true);

      if (length > this.#max) {
        // Checked BEFORE waiting for the body: the whole point is to refuse
        // without ever allocating or buffering toward it.
        this.#failed = {
          code: 'frame-too-large',
          message: `frame claims ${length} bytes, cap is ${this.#max}`,
        };
        this.#buffer = new Uint8Array(0);
        return { frames, error: this.#failed };
      }
      if (length < 1) {
        this.#failed = { code: 'malformed-frame', message: 'a frame must carry at least a kind' };
        this.#buffer = new Uint8Array(0);
        return { frames, error: this.#failed };
      }
      if (this.#buffer.length < 4 + length) break;

      const kind = this.#buffer[4] as FrameKind;
      // A view, deliberately: `decodePayload` copies whatever it hands out, so
      // copying here too would mean TWO full copies of every pty frame on the
      // hot path. Measured by planting the defect — a mutation of this line
      // changes nothing observable, which is what said it was redundant.
      const payload = this.#buffer.subarray(HEADER_BYTES, 4 + length);
      this.#buffer = this.#buffer.slice(4 + length);

      const frame = decodePayload(kind, payload);
      if ('code' in frame) {
        this.#failed = frame;
        this.#buffer = new Uint8Array(0);
        return { frames, error: frame };
      }
      frames.push(frame);
    }

    return { frames };
  }
}

function decodePayload(kind: FrameKind, payload: Uint8Array): Frame | ProtocolError {
  if (isByteKind(kind)) {
    if (payload.length < 1) {
      return { code: 'malformed-frame', message: 'a byte frame carries no session id' };
    }
    const idLength = payload[0] as number;
    if (payload.length < 1 + idLength) {
      return { code: 'malformed-frame', message: 'a byte frame’s session id is truncated' };
    }
    return {
      kind,
      sessionId: new TextDecoder().decode(payload.subarray(1, 1 + idLength)),
      /**
       * **The copy the callers depend on, and the only one.** A sink keeps these
       * bytes, and `PtyFanout` queues them until a snapshot lands — so a view
       * onto the decoder's own buffer would let a later `feed` change bytes that
       * have already been delivered. Unreproducible by construction, and it
       * would present as pty corruption.
       *
       * `protocol.test.ts` asserts OWNERSHIP (`byteOffset === 0`, buffer sized to
       * the view) rather than "the bytes did not change", because the latter is
       * vacuous against a decoder that reallocates — verified by planting it.
       */
      bytes: payload.slice(1 + idLength),
    };
  }

  try {
    return { kind, json: JSON.parse(new TextDecoder().decode(payload)) as unknown };
  } catch (error) {
    return { code: 'bad-json', message: `frame kind ${kind} carried invalid JSON: ${String(error)}` };
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBufferLike> {
  if (a.length === 0) return b.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
