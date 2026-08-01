package com.eshaan.shepherd.data

import org.junit.Assert.*
import org.junit.Test

/** The store held ONE Mac, so pairing a second silently replaced the first. */
class MultiPairingTest {
    private fun p(host: String, pin: String? = null) =
        Pairing(host, 8722, "dev", "Pixel", "secret-$host", pin)

    @Test fun `a second pairing does not replace the first`() {
        val s = InMemoryPairingStore()
        s.save(p("work"))
        s.save(p("air"))
        assertEquals(listOf("work", "air"), s.loadAll().map { it.host })
        assertEquals("the newest pairing is the one shown", "air", s.load()?.host)
    }

    @Test fun `re-pairing the same host updates rather than duplicates`() {
        val s = InMemoryPairingStore()
        s.save(p("work"))
        s.save(p("work", pin = "PIN"))
        assertEquals(1, s.loadAll().size)
        assertEquals("PIN", s.load()?.lanPin)
    }

    @Test fun `select switches which Mac is shown`() {
        val s = InMemoryPairingStore()
        s.save(p("work")); s.save(p("air"))
        s.select("work:8722")
        assertEquals("work", s.load()?.host)
        s.select("nope:1")   // unknown id must not change the selection
        assertEquals("work", s.load()?.host)
    }

    @Test fun `forgetting the shown Mac falls back to another`() {
        val s = InMemoryPairingStore()
        s.save(p("work")); s.save(p("air"))
        assertEquals("air", s.load()?.host)
        s.forget("air:8722")
        assertEquals("work", s.load()?.host)
        s.forget("work:8722")
        assertNull(s.load())
        assertTrue(s.loadAll().isEmpty())
    }

    @Test fun `same host on two ports is two pairings`() {
        val s = InMemoryPairingStore()
        s.save(Pairing("mac", 8722, "d", "n", "s1"))          // tailnet
        s.save(Pairing("mac", 8723, "d", "n", "s2", "PIN"))   // local network
        assertEquals(2, s.loadAll().size)
    }
}
