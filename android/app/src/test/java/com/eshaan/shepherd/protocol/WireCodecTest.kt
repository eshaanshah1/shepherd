package com.eshaan.shepherd.protocol

import org.junit.Assert.*
import org.junit.Test

class WireCodecTest {
    private fun frameJson(msg: ControlMessage): String {
        val bytes = WireCodec.encode(msg)
        val len = ((bytes[0].toInt() and 0xff) shl 24) or ((bytes[1].toInt() and 0xff) shl 16) or
                  ((bytes[2].toInt() and 0xff) shl 8) or (bytes[3].toInt() and 0xff)
        assertEquals(bytes.size - 4, len)
        return String(bytes, 4, len, Charsets.UTF_8)
    }
    private fun decodeOne(json: String): ControlMessage {
        val body = json.toByteArray(Charsets.UTF_8)
        val frame = ByteArray(4 + body.size)
        frame[0] = (body.size ushr 24).toByte(); frame[1] = (body.size ushr 16).toByte()
        frame[2] = (body.size ushr 8).toByte(); frame[3] = body.size.toByte()
        body.copyInto(frame, 4)
        val msgs = WireCodec.Decoder().feed(frame)
        assertEquals(1, msgs.size)
        return msgs[0]
    }

    @Test fun pingFrameMatchesHostBytes() {
        val bytes = WireCodec.encode(ControlMessage.Ping)
        assertArrayEquals(byteArrayOf(0,0,0,0x0b, '{'.code.toByte(),'"'.code.toByte(),'p'.code.toByte(),
            'i'.code.toByte(),'n'.code.toByte(),'g'.code.toByte(),'"'.code.toByte(),':'.code.toByte(),
            '{'.code.toByte(),'}'.code.toByte(),'}'.code.toByte()), bytes)
    }

    @Test fun helloOmitsNilFields() {
        val json = frameJson(ControlMessage.Hello("dev-123","Pixel 8", pairingCode = null,
            secret = "s3cr3t", fcmToken = "tok", protocolVersion = 1))
        assertFalse("nil pairingCode must be omitted, not null", json.contains("pairingCode"))
        assertTrue(json.contains("\"secret\":\"s3cr3t\""))
        assertTrue(json.contains("\"deviceID\":\"dev-123\""))
        assertTrue(json.contains("\"deviceName\":\"Pixel 8\""))
        assertTrue(json.contains("\"protocolVersion\":1"))
    }

    @Test fun decodesHostSnapshot() {
        val m = decodeOne("""{"snapshot":{"panes":[{"paneID":"p1","state":"blocked","title":"~/proj","reason":"approve Bash","workspace":"Work"}]}}""")
        m as ControlMessage.Snapshot
        assertEquals(1, m.panes.size)
        assertEquals(PaneInfo("p1","~/proj","Work","blocked","approve Bash"), m.panes[0])
    }

    @Test fun decodesStateWithMissingReasonAsNull() {
        val m = decodeOne("""{"state":{"paneID":"p1","state":"working"}}""") as ControlMessage.StateMsg
        assertEquals("p1", m.paneId); assertEquals("working", m.state); assertNull(m.reason)
    }

    @Test fun decodesPaneAddedUnderUnderscoreZero() {
        val m = decodeOne("""{"paneAdded":{"_0":{"paneID":"p2","state":"idle","title":"t","workspace":"W"}}}""") as ControlMessage.PaneAdded
        assertEquals("p2", m.pane.paneId); assertNull(m.pane.reason)
    }

    @Test fun decodesAcceptedRejectedPending() {
        assertEquals("nonce-1", (decodeOne("""{"accepted":{"sessionNonce":"nonce-1"}}""") as ControlMessage.Accepted).sessionNonce)
        assertEquals("nope", (decodeOne("""{"rejected":{"reason":"nope"}}""") as ControlMessage.Rejected).reason)
        assertTrue(decodeOne("""{"pendingApproval":{}}""") is ControlMessage.PendingApproval)
        assertTrue(decodeOne("""{"pong":{}}""") is ControlMessage.Pong)
    }

    @Test fun encodesResizeMatchesSwift() {
        val json = frameJson(ControlMessage.Resize("p1", 40, 30))
        assertTrue(json.contains("\"resize\"")); assertTrue(json.contains("\"paneID\":\"p1\""))
        assertTrue(json.contains("\"cols\":40")); assertTrue(json.contains("\"rows\":30"))
    }

    @Test fun decodesPrompt() {
        val m = decodeOne("""{"prompt":{"paneID":"p1","kind":"askUserQuestion","questions":[{"prompt":"Pick one","header":"H","options":["A","B"],"multiSelect":false}]}}""") as ControlMessage.Prompt
        assertEquals("p1", m.paneId); assertEquals("askUserQuestion", m.kind); assertNull(m.detail)
        assertEquals(1, m.questions!!.size)
        assertEquals(PromptQuestion("Pick one", "H", listOf("A", "B"), false), m.questions!![0])
    }

    @Test fun decodesPermissionPromptNoQuestions() {
        val m = decodeOne("""{"prompt":{"paneID":"p1","kind":"permission","detail":"Bash"}}""") as ControlMessage.Prompt
        assertEquals("permission", m.kind); assertEquals("Bash", m.detail); assertNull(m.questions)
    }

    @Test fun decoderReassemblesSplitAndCoalescedFrames() {
        val a = WireCodec.encode(ControlMessage.Ping)
        val b = WireCodec.encode(ControlMessage.Pong)
        val dec = WireCodec.Decoder()
        assertEquals(0, dec.feed(a.copyOfRange(0, 3)).size)
        val r1 = dec.feed(a.copyOfRange(3, a.size) + b.copyOfRange(0, 2))
        assertEquals(1, r1.size); assertTrue(r1[0] is ControlMessage.Ping)
        val r2 = dec.feed(b.copyOfRange(2, b.size))
        assertEquals(1, r2.size); assertTrue(r2[0] is ControlMessage.Pong)
    }
}
