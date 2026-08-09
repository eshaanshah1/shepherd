package com.eshaan.shepherd.v2

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * One Mac, many addresses — the model that replaces "one address is one Mac".
 *
 * Keyed by address, the same machine reached over wifi, over a tailnet and over
 * a USB forward was three separate pairings with three device ids and three
 * approvals; and moving between access points stranded the phone on a record
 * whose address now belongs to nobody. The pin does not move, so it is the key.
 */
class KnownMacTest {

    private fun mac(vararg endpoints: Endpoint) = KnownMac(
        pin = "abc123",
        endpoints = endpoints.toList(),
        deviceId = "device-1",
        secret = "s3cret",
    )

    @Test
    fun `a new transport is another address on the same Mac, not another Mac`() {
        val wifi = Endpoint("192.168.1.5", 8722, 8723, via = "wifi")
        val tailnet = Endpoint("100.64.0.2", 8722, 8723, via = "tailscale")

        val known = mac(wifi).reachableAt(tailnet)

        assertEquals(listOf(tailnet, wifi), known.endpoints)
        // The things that make it the same Mac to the HOST are untouched.
        assertEquals("device-1", known.deviceId)
        assertEquals("s3cret", known.secret)
    }

    @Test
    fun `reaching a known address again promotes it rather than duplicating it`() {
        val wifi = Endpoint("192.168.1.5", 8722, 8723, via = "wifi")
        val tailnet = Endpoint("100.64.0.2", 8722, 8723, via = "tailscale")

        val known = mac(wifi, tailnet).reachableAt(tailnet.copy(dataPort = 9999))

        assertEquals(2, known.endpoints.size)
        // …and the port it just reported wins, because a port is the host's to
        // choose and a cached one dials a daemon that has moved.
        assertEquals(9999, known.endpoints.first().dataPort)
    }

    @Test
    fun `an address that moved is replaced, keeping the pairing`() {
        // The access point changed and the Mac has a new IP. That is a new
        // address on a Mac we already know, not a Mac we have to pair with.
        val old = Endpoint("192.168.1.5", 8722, 8723, via = "wifi")
        val moved = Endpoint("10.0.0.9", 8722, 8723, via = "wifi")

        val known = mac(old).reachableAt(moved)

        assertEquals(moved, known.candidates.first())
        assertEquals("s3cret", known.secret)
    }

    @Test
    fun `it survives a round trip through storage`() {
        val known = mac(
            Endpoint("192.168.1.5", 8722, 8723, via = "wifi"),
            Endpoint("100.64.0.2", 8722, 8723, via = "tailscale"),
        )
        assertEquals(known, KnownMac.fromJson(known.toJson()))
    }

    @Test
    fun `an unpaired Mac round-trips with no secret, rather than the string null`() {
        val fresh = mac(Endpoint("192.168.1.5", 8722, 8723)).copy(secret = null)
        assertNull(KnownMac.fromJson(fresh.toJson()).secret)
    }
}
