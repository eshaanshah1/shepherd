package com.eshaan.shepherd.protocol

import org.junit.Assert.*
import org.junit.Test

class DataWireCodecTest {
    private fun frame(json: String): ByteArray {
        val body = json.toByteArray(Charsets.UTF_8)
        val out = ByteArray(4 + body.size)
        out[0] = (body.size ushr 24).toByte(); out[1] = (body.size ushr 16).toByte()
        out[2] = (body.size ushr 8).toByte(); out[3] = body.size.toByte()
        body.copyInto(out, 4)
        return out
    }

    @Test fun dataHelloMatchesSwiftShape() {
        val enc = DataWireCodec.encode(DataMessage.DataHello("n1", "p1", 40, 30))
        val json = String(enc, 4, enc.size - 4, Charsets.UTF_8)
        assertTrue(json.contains("\"dataHello\""))
        assertTrue(json.contains("\"sessionNonce\":\"n1\"")); assertTrue(json.contains("\"paneID\":\"p1\""))
        assertTrue(json.contains("\"cols\":40")); assertTrue(json.contains("\"rows\":30"))
    }

    @Test fun decodesDataReady() {
        val m = DataWireCodec.Decoder().feed(frame("""{"dataReady":{"cols":41,"rows":22}}""")).single()
        assertEquals(DataMessage.DataReady(41, 22), m)
    }

    @Test fun decodesDataRejected() {
        val m = DataWireCodec.Decoder().feed(frame("""{"dataRejected":{"reason":"bad nonce"}}""")).single()
        assertEquals(DataMessage.DataRejected("bad nonce"), m)
    }

    @Test fun decoderReassemblesSplitAndCoalescedFrames() {
        val a = DataWireCodec.encode(DataMessage.DataReady(41, 22))
        val b = DataWireCodec.encode(DataMessage.DataRejected("nope"))
        val dec = DataWireCodec.Decoder()
        assertEquals(0, dec.feed(a.copyOfRange(0, 3)).size)
        val r1 = dec.feed(a.copyOfRange(3, a.size) + b.copyOfRange(0, 2))
        assertEquals(1, r1.size); assertEquals(DataMessage.DataReady(41, 22), r1[0])
        val r2 = dec.feed(b.copyOfRange(2, b.size))
        assertEquals(1, r2.size); assertEquals(DataMessage.DataRejected("nope"), r2[0])
    }

    /** [feedOne] parses at most one frame and returns the untouched tail (the C1 fix path). */
    @Test fun feedOneParsesOneFrameAndReturnsRawTail() {
        val ready = DataWireCodec.encode(DataMessage.DataReady(40, 30))
        val raw = "hello".toByteArray()
        val (m, tail) = DataWireCodec.Decoder().feedOne(ready + raw)
        assertEquals(DataMessage.DataReady(40, 30), m)
        assertEquals("hello", tail.toString(Charsets.UTF_8))
    }

    @Test fun feedOneWaitsForFullFrame() {
        val ready = DataWireCodec.encode(DataMessage.DataReady(40, 30))
        val dec = DataWireCodec.Decoder()
        val (m1, t1) = dec.feedOne(ready.copyOfRange(0, 3))
        assertNull(m1); assertEquals(0, t1.size)
        val (m2, t2) = dec.feedOne(ready.copyOfRange(3, ready.size))
        assertEquals(DataMessage.DataReady(40, 30), m2); assertEquals(0, t2.size)
    }
}
