package com.eshaan.shepherd.protocol

import org.junit.Assert.*
import org.junit.Test

/** The QR gained the LAN address, certificate pin and live code, so scanning can pair over
 *  wifi with no Tailscale and no typing. Byte-pinned against the Swift encoder. */
class PairingPayloadLanTest {
    @Test fun `parses the lan fields`() {
        val p = PairingPayload.parse(
            "shepherd://pair?host=work.tail1234.ts.net&ip=100.78.141.27&port=8722&name=work" +
            "&lan=192.168.0.145:8723&pin=YWJjZA%3D%3D&code=424242")!!
        assertEquals("192.168.0.145", p.lanHost)
        assertEquals(8723, p.lanPort)
        assertEquals("abcd".toByteArray().let { java.util.Base64.getEncoder().encodeToString(it) }, p.pin)
        assertEquals("424242", p.code)
        assertTrue(p.hasLan)
    }

    @Test fun `a tailnet-only QR still parses and reports no lan`() {
        val p = PairingPayload.parse(
            "shepherd://pair?host=work.tail1234.ts.net&ip=100.78.141.27&port=8722&name=work")!!
        assertNull(p.lanHost); assertNull(p.pin); assertNull(p.code)
        assertFalse(p.hasLan)
        assertEquals(8722, p.port)
    }

    /** A malformed lan= must not throw away an otherwise usable tailnet pairing. */
    @Test fun `a malformed lan is treated as absent`() {
        val p = PairingPayload.parse(
            "shepherd://pair?ip=100.78.141.27&port=8722&name=w&lan=garbage&pin=x")!!
        assertFalse(p.hasLan)
        assertEquals("100.78.141.27", p.ip)
    }
}
