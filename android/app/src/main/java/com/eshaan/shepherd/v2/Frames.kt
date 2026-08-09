package com.eshaan.shepherd.v2

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The v2 wire format, which this app now speaks end to end.
 *
 * One framing for everything:
 *
 *     [u32 length][u8 kind][payload…]
 *      ^ of kind + payload, NOT of itself, LITTLE-endian
 *
 * Two payload shapes, and the split is the point. Control is JSON; `data` and
 * `write` are RAW BYTES with a length-prefixed session id, and never pass
 * through JSON — base64 would inflate the hot path by a third, and the host
 * opens the pty with no encoding precisely so a multi-byte sequence is never
 * decoded at a chunk boundary. A client that stringified them would undo that in
 * the one place it matters most.
 *
 * Little-endian is not a preference: it is what the host writes
 * (`DataView.setUint32(…, true)`), and Java's default is BIG-endian — so every
 * buffer here sets it explicitly. Getting that wrong yields a length in the
 * hundreds of millions and a decoder that waits forever for bytes that never
 * come, which looks exactly like a dead connection.
 */
object Frames {
    /** Far above any real frame (the biggest is a screen snapshot, ~55 KB). */
    const val MAX_FRAME = 16 * 1024 * 1024
    private const val HEADER = 5

    // The session protocol. Client -> host.
    /**
     * The SESSION protocol's version, which is not the remote protocol's.
     *
     * Two handshakes ride one socket and they version independently: the remote
     * one decides whether this device may talk at all, the session one decides
     * whether both ends agree about frames. Conflating them would tie a pairing
     * change to a pty-protocol change.
     */
    const val SESSION_PROTOCOL_VERSION = 1

    const val REQ_HELLO = 1
    const val REQ_CREATE = 2
    const val REQ_ATTACH = 3
    const val REQ_DETACH = 4
    const val REQ_WRITE = 5
    const val REQ_RESIZE = 7
    const val REQ_KILL = 8
    const val REQ_LIST = 9
    const val REQ_SET_VIEWPORT = 11

    // Host -> client.
    const val RES_OK = 64
    const val RES_ERR = 65
    const val RES_DATA = 66
    const val RES_EXIT = 67
    const val RES_SNAPSHOT = 68

    /**
     * The pty was reshaped — `{sessionId, cols, rows}`, with a snapshot behind it.
     *
     * The size is arbitrated between everyone watching, so it moves without this
     * client asking: another viewer attached, or somebody took control.
     */
    const val RES_RESIZED = 69

    // The remote handshake, deliberately disjoint from the session range so ONE
    // decoder reads both and a frame arriving in the wrong phase is a typed
    // refusal rather than a misparse.
    const val REMOTE_HELLO = 128
    const val REMOTE_ACCEPTED = 129
    const val REMOTE_REJECTED = 130
    const val REMOTE_PENDING = 131

    // The control channel: a device invoking commands, and nothing else.
    const val CONTROL_INVOKE = 140
    const val CONTROL_RESULT = 141
    const val CONTROL_CHANGED = 142

    /** Payload is raw bytes rather than JSON, for these kinds only. */
    fun isByteKind(kind: Int): Boolean =
        kind == REQ_WRITE || kind == RES_DATA || kind == RES_SNAPSHOT

    fun json(kind: Int, body: String): ByteArray = frame(kind, body.toByteArray(Charsets.UTF_8))

    /**
     * `[u8 idLength][id][bytes]`. Length-prefixed rather than delimited, because
     * a delimiter would have to be escaped out of the byte payload — the one
     * thing this frame exists to avoid touching.
     */
    fun bytes(kind: Int, sessionId: String, payload: ByteArray): ByteArray {
        val id = sessionId.toByteArray(Charsets.UTF_8)
        require(id.size <= 255) { "session id too long to frame: ${id.size} bytes" }
        val out = ByteArray(1 + id.size + payload.size)
        out[0] = id.size.toByte()
        System.arraycopy(id, 0, out, 1, id.size)
        System.arraycopy(payload, 0, out, 1 + id.size, payload.size)
        return frame(kind, out)
    }

    private fun frame(kind: Int, payload: ByteArray): ByteArray {
        val out = ByteArray(HEADER + payload.size)
        ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN).putInt(payload.size + 1)
        out[4] = kind.toByte()
        System.arraycopy(payload, 0, out, HEADER, payload.size)
        return out
    }

    /** One decoded frame. Exactly one of [text] and [payload] is meaningful. */
    data class Frame(
        val kind: Int,
        val text: String? = null,
        val sessionId: String? = null,
        val payload: ByteArray? = null,
    ) {
        // Data classes compare arrays by identity; these are compared in tests.
        override fun equals(other: Any?): Boolean =
            other is Frame && kind == other.kind && text == other.text &&
                sessionId == other.sessionId && (payload?.toList() == other.payload?.toList())

        override fun hashCode(): Int =
            (kind * 31 + (text?.hashCode() ?: 0)) * 31 + (payload?.toList()?.hashCode() ?: 0)
    }

    class Refused(message: String) : Exception(message)

    /**
     * Accumulates socket chunks and yields whole frames.
     *
     * A socket delivers whatever it delivers: half a header, three frames at
     * once, a 55 KB snapshot across a dozen reads. Every one of those is a case
     * here — it is the class of defect that works on one device and corrupts
     * under load.
     *
     * An oversized frame is refused on the HEADER, before anything is allocated
     * toward it, and the refusal is TERMINAL: there is no framing marker to
     * resynchronize on (by design), so the caller drops the connection rather
     * than guessing.
     */
    class Decoder {
        private var buffer = ByteArray(0)
        private var failed: String? = null

        fun feed(chunk: ByteArray, length: Int): List<Frame> {
            failed?.let { throw Refused(it) }
            buffer = buffer.copyOf(buffer.size + length).also {
                System.arraycopy(chunk, 0, it, buffer.size, length)
            }

            val out = ArrayList<Frame>()
            while (true) {
                if (buffer.size < HEADER) break
                val frameLength = ByteBuffer.wrap(buffer, 0, 4).order(ByteOrder.LITTLE_ENDIAN).int
                if (frameLength > MAX_FRAME || frameLength < 1) {
                    failed = "frame claims $frameLength bytes"
                    buffer = ByteArray(0)
                    throw Refused(failed!!)
                }
                if (buffer.size < 4 + frameLength) break

                val kind = buffer[4].toInt() and 0xFF
                val payload = buffer.copyOfRange(HEADER, 4 + frameLength)
                buffer = buffer.copyOfRange(4 + frameLength, buffer.size)

                out += if (isByteKind(kind)) {
                    if (payload.isEmpty()) throw Refused("a byte frame carries no session id")
                    val idLength = payload[0].toInt() and 0xFF
                    if (payload.size < 1 + idLength) throw Refused("truncated session id")
                    Frame(
                        kind = kind,
                        sessionId = String(payload, 1, idLength, Charsets.UTF_8),
                        payload = payload.copyOfRange(1 + idLength, payload.size),
                    )
                } else {
                    Frame(kind = kind, text = String(payload, Charsets.UTF_8))
                }
            }
            return out
        }
    }
}
