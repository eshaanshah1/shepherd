package com.eshaan.shepherd.v2

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The framing contract, at exact byte boundaries.
 *
 * These are the same cases the host's own `protocol.test.ts` asserts, written
 * against this implementation — because "both sides passed their own tests" is
 * how two framings drift into disagreeing about a boundary and corrupting a pty
 * only under load.
 */
class FramesTest {
    private fun feedAll(decoder: Frames.Decoder, bytes: ByteArray, chunk: Int = Int.MAX_VALUE): List<Frames.Frame> {
        val out = ArrayList<Frames.Frame>()
        var at = 0
        while (at < bytes.size) {
            val take = minOf(chunk, bytes.size - at)
            out += decoder.feed(bytes.copyOfRange(at, at + take), take)
            at += take
        }
        return out
    }

    @Test
    fun `round-trips a json frame`() {
        val frames = feedAll(Frames.Decoder(), Frames.json(Frames.REQ_HELLO, """{"seq":1}"""))
        assertEquals(1, frames.size)
        assertEquals(Frames.REQ_HELLO, frames[0].kind)
        assertEquals("""{"seq":1}""", frames[0].text)
    }

    /**
     * The hot path. A NUL, a lone continuation byte and a truncated multi-byte
     * sequence must all arrive unchanged — the host opens the pty with no
     * encoding for exactly this reason.
     */
    @Test
    fun `round-trips bytes without touching them`() {
        val payload = byteArrayOf(0x00, 0xFF.toByte(), 0xE6.toByte(), 0x97.toByte(), 0x1B, 0x5B, 0x41)
        val frames = feedAll(Frames.Decoder(), Frames.bytes(Frames.RES_DATA, "sess-1", payload))
        assertEquals("sess-1", frames[0].sessionId)
        assertArrayEquals(payload, frames[0].payload)
    }

    /**
     * LITTLE-endian, which Java's default is not. Getting it wrong yields a
     * length in the hundreds of millions and a decoder that waits forever —
     * indistinguishable from a dead connection.
     */
    @Test
    fun `writes its length little-endian, as the host reads it`() {
        val frame = Frames.json(Frames.REQ_LIST, "{}")
        val length = ByteBuffer.wrap(frame, 0, 4).order(ByteOrder.LITTLE_ENDIAN).int
        assertEquals(frame.size - 4, length)
        // …and the naive big-endian read is nonsense, which is what makes this
        // assertion worth writing down.
        assertTrue(ByteBuffer.wrap(frame, 0, 4).int > 1_000_000)
    }

    @Test
    fun `yields several frames arriving in one chunk`() {
        val wire = Frames.json(Frames.REQ_LIST, "{}") +
            Frames.bytes(Frames.RES_DATA, "s", "one".toByteArray()) +
            Frames.json(Frames.RES_OK, """{"seq":3}""")
        val frames = feedAll(Frames.Decoder(), wire)
        assertEquals(listOf(Frames.REQ_LIST, Frames.RES_DATA, Frames.RES_OK), frames.map { it.kind })
        assertEquals("one", String(frames[1].payload!!))
    }

    @Test
    fun `yields nothing until a frame is whole`() {
        val wire = Frames.json(Frames.RES_OK, """{"seq":7,"value":"${"x".repeat(50)}"}""")
        val decoder = Frames.Decoder()
        // One byte at a time — the case that catches a decoder reading its
        // header before it has all five bytes.
        val frames = feedAll(decoder, wire, chunk = 1)
        assertEquals(1, frames.size)
    }

    @Test
    fun `reassembles a large payload split across many chunks`() {
        val payload = ByteArray(200_000) { (it % 251).toByte() }
        val frames = feedAll(Frames.Decoder(), Frames.bytes(Frames.RES_DATA, "big", payload), chunk = 4096)
        assertEquals(1, frames.size)
        assertArrayEquals(payload, frames[0].payload)
    }

    @Test
    fun `keeps a trailing partial frame for the next chunk`() {
        val first = Frames.json(Frames.RES_OK, """{"seq":1}""")
        val second = Frames.json(Frames.RES_OK, """{"seq":2}""")
        val decoder = Frames.Decoder()
        val partial = first + second.copyOfRange(0, 3)
        assertEquals(1, decoder.feed(partial, partial.size).size)
        val rest = second.copyOfRange(3, second.size)
        assertEquals("""{"seq":2}""", decoder.feed(rest, rest.size)[0].text)
    }

    @Test
    fun `carries an empty byte payload`() {
        val frames = feedAll(Frames.Decoder(), Frames.bytes(Frames.RES_DATA, "s", ByteArray(0)))
        assertEquals(0, frames[0].payload!!.size)
    }

    /**
     * An unbounded decoder is a memory denial-of-service reachable from a
     * socket, so the refusal happens on the HEADER — before anything is
     * allocated toward the claimed length.
     */
    @Test(expected = Frames.Refused::class)
    fun `refuses an oversized frame`() {
        val header = ByteArray(5)
        ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN).putInt(Frames.MAX_FRAME + 1)
        header[4] = Frames.RES_DATA.toByte()
        Frames.Decoder().feed(header, header.size)
    }

    @Test(expected = Frames.Refused::class)
    fun `refuses a byte frame whose session id is truncated`() {
        // Claims a 200-byte id and carries one.
        val payload = byteArrayOf(200.toByte(), 0x61)
        val wire = ByteArray(5 + payload.size)
        ByteBuffer.wrap(wire).order(ByteOrder.LITTLE_ENDIAN).putInt(payload.size + 1)
        wire[4] = Frames.RES_DATA.toByte()
        System.arraycopy(payload, 0, wire, 5, payload.size)
        Frames.Decoder().feed(wire, wire.size)
    }

    @Test
    fun `knows which kinds carry bytes`() {
        assertTrue(Frames.isByteKind(Frames.RES_DATA))
        assertTrue(Frames.isByteKind(Frames.REQ_WRITE))
        assertTrue(Frames.isByteKind(Frames.RES_SNAPSHOT))
        assertTrue(!Frames.isByteKind(Frames.REQ_HELLO))
        assertTrue(!Frames.isByteKind(Frames.CONTROL_INVOKE))
    }
}
