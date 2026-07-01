package com.eshaan.shepherd.fcm

import org.junit.Assert.*
import org.junit.Test

class FcmWakeTest {
    @Test fun parsesBlockedWakeAsUrgent() {
        val w = FcmWake.parse(mapOf("paneID" to "p1", "state" to "blocked", "urgent" to "true"))!!
        assertEquals("p1", w.paneId); assertTrue(w.urgent)
        assertTrue(w.body.contains("needs you") || w.body.contains("blocked"))
    }
    @Test fun parsesNeedsCheckNonUrgent() {
        val w = FcmWake.parse(mapOf("paneID" to "p2", "state" to "need-to-check", "urgent" to "false"))!!
        assertFalse(w.urgent)
    }
    @Test fun nullWhenNoPaneId() {
        assertNull(FcmWake.parse(mapOf("state" to "blocked")))
    }
}
