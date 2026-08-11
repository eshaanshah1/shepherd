package com.eshaan.shepherd.v2

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * One Mac, many addresses — the model that replaces "one address is one Mac".
 *
 * Keyed by address, the same machine reached over wifi, over a tailnet and over
 * a USB forward was three separate pairings with three device ids and three
 * approvals; and moving between access points stranded the phone on a record
 * whose address now belongs to nobody. The pin does not move, so it is the key.
 *
 * Since shep-nets this record is ONLY an address list: the phone's identity is a
 * membership of a net, shared by every Mac in it.
 */
class KnownMacTest {

    private fun mac(vararg endpoints: Endpoint) = KnownMac(
        pin = "abc123",
        endpoints = endpoints.toList(),
        netId = "net-1",
    )

    @Test
    fun `a new transport is another address on the same Mac, not another Mac`() {
        val wifi = Endpoint("192.168.1.5", 8722, 8723, via = "wifi")
        val tailnet = Endpoint("100.64.0.2", 8722, 8723, via = "tailscale")

        val known = mac(wifi).reachableAt(tailnet)

        assertEquals(listOf(tailnet, wifi), known.endpoints)
        // The net it belongs to is untouched: identity is the MEMBERSHIP, held
        // once per net, not something this record carries per address.
        assertEquals("net-1", known.netId)
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
    fun `an address that moved is replaced, keeping the membership`() {
        // The access point changed and the Mac has a new IP. That is a new
        // address on a Mac we already know, not a Mac we have to pair with.
        val old = Endpoint("192.168.1.5", 8722, 8723, via = "wifi")
        val moved = Endpoint("10.0.0.9", 8722, 8723, via = "wifi")

        val known = mac(old).reachableAt(moved)

        assertEquals(moved, known.candidates.first())
        assertEquals("net-1", known.netId)
    }

    @Test
    fun `it survives a round trip through storage`() {
        val known = mac(
            Endpoint("192.168.1.5", 8722, 8723, via = "wifi"),
            Endpoint("100.64.0.2", 8722, 8723, via = "tailscale"),
        )
        assertEquals(known, KnownMac.fromJson(known.toJson()))
    }

    /**
     * A record written before shep-nets names no net. It reads back as a Mac with
     * no membership rather than failing to read at all — the phone then joins
     * once, which is what the Mac's own migration does and for the same reason:
     * a membership is a signature over a public key, and the old record has none.
     */
    @Test
    fun `a record from before nets reads back with no net rather than not at all`() {
        val legacy = org.json.JSONObject()
            .put("pin", "abc123")
            .put("endpoints", org.json.JSONArray())
        assertEquals("", KnownMac.fromJson(legacy).netId)
    }
}
