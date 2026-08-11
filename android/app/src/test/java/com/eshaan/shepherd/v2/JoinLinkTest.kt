package com.eshaan.shepherd.v2

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The join link, which is how a phone joins without anybody typing an 88-character
 * key.
 *
 * The fixture is a link the MAC encodes (`encodeJoinURI`), so this is the second
 * interop surface after the canonical signing bytes. Its refusals matter as much
 * as its successes: a half-understood link must be refused HERE, where the
 * missing field can be named, rather than becoming a dial that ends in a
 * rejection the user cannot act on.
 */
class JoinLinkTest {
    private val root =
        "302a300506032b65700321002e2b6d5afe0988e03abae777aadaac67640f966d0652be9bc71e076cc212c991"
    private val netId = "f186e88c7ed87c2c9913d490796e285d5f70f58931d490bf7376e8fc5efab54f"
    private val pin = "ab".repeat(32)

    private fun link(
        extra: String = "",
        v: Int = HostLink.REMOTE_PROTOCOL_VERSION,
    ) = "shepherd://join?v=$v&host=192.168.1.7&port=8723&data=8724&pin=$pin" +
        "&code=424242&net=$netId&name=Eshaan%27s%20net&root=$root$extra"

    @Test
    fun `reads every field the Mac encodes`() {
        val parsed = JoinLink.parse(link())!!
        assertEquals("192.168.1.7", parsed.host)
        assertEquals(8723, parsed.port)
        assertEquals(8724, parsed.dataPort)
        assertEquals(pin, parsed.pin)
        assertEquals("424242", parsed.code)
        assertEquals(netId, parsed.netId)
        assertEquals("Eshaan's net", parsed.netName)
        assertEquals(root, parsed.rootPublicKey)
    }

    @Test
    fun `refuses a net id that is not the hash of the key it carries`() {
        // The two halves check each other, so a tampered or truncated link is
        // caught before a byte is sent.
        assertNull(JoinLink.parse(link().replace("net=$netId", "net=${"00".repeat(32)}")))
    }

    @Test
    fun `refuses a protocol version this app does not speak`() {
        assertNull(JoinLink.parse(link(v = HostLink.REMOTE_PROTOCOL_VERSION - 1)))
    }

    @Test
    fun `refuses anything that is not a shepherd join link`() {
        assertNull(JoinLink.parse("https://example.com/join?host=1.2.3.4"))
        assertNull(JoinLink.parse("nonsense"))
        assertNull(JoinLink.parse(""))
    }

    @Test
    fun `refuses a link with no root key, and one with no pin`() {
        assertNull(JoinLink.parse(link().replace("&root=$root", "")))
        assertNull(JoinLink.parse(link().replace("&pin=$pin", "")))
    }

    @Test
    fun `refuses a port that is not a port`() {
        assertNull(JoinLink.parse(link().replace("port=8723", "port=nope")))
    }

    @Test
    fun `takes a link with no data port, since browsing still works`() {
        val parsed = JoinLink.parse(link().replace("&data=8724", ""))!!
        assertEquals(0, parsed.dataPort)
    }

    /** Pasted from a message, so leading and trailing whitespace is ordinary. */
    @Test
    fun `tolerates whitespace around a pasted link`() {
        assertEquals("192.168.1.7", JoinLink.parse("  ${link()}\n")!!.host)
    }
}
