package com.eshaan.shepherd.protocol

import org.junit.Assert.*
import org.junit.Test

class PairingPayloadTest {
    @Test fun parsesPinnedSwiftString() {
        val p = PairingPayload.parse("shepherd://pair?host=work.tail1234.ts.net&ip=100.78.141.27&port=8722&name=work")!!
        assertEquals("work.tail1234.ts.net", p.host)
        assertEquals("100.78.141.27", p.ip)
        assertEquals(8722, p.port)
        assertEquals("work", p.name)
    }
    @Test fun toleratesMissingHost() {
        val p = PairingPayload.parse("shepherd://pair?ip=100.64.0.5&port=8722&name=mac")!!
        assertNull(p.host); assertEquals("100.64.0.5", p.ip)
    }
    @Test fun rejectsWrongSchemeAndNoEndpoint() {
        assertNull(PairingPayload.parse("https://pair?ip=1.2.3.4&port=8722"))
        assertNull(PairingPayload.parse("shepherd://pair?port=8722&name=x"))
        assertNull(PairingPayload.parse("garbage"))
    }
    @Test fun decodesPercentEncodedName() {
        val p = PairingPayload.parse("shepherd://pair?ip=100.64.0.5&port=8722&name=my%20mac")!!
        assertEquals("my mac", p.name)
    }
}
