package com.eshaan.shepherd.fcm

import com.eshaan.shepherd.model.AgentState
import org.junit.Assert.*
import org.junit.Test

class ChimeTest {
    @Test fun needsCheckMapsToDone() {
        assertEquals(ChimeKind.DONE, Chime.soundFor(AgentState.NEEDS_CHECK))
    }
    @Test fun blockedMapsToBlocked() {
        assertEquals(ChimeKind.BLOCKED, Chime.soundFor(AgentState.BLOCKED))
    }
    @Test fun errorReusesBlockedChime() {
        assertEquals(ChimeKind.BLOCKED, Chime.soundFor(AgentState.ERROR))
    }
    @Test fun nonAttentionStatesHaveNoChime() {
        assertNull(Chime.soundFor(AgentState.IDLE))
        assertNull(Chime.soundFor(AgentState.WORKING))
        assertNull(Chime.soundFor(AgentState.SHELL))
        assertNull(Chime.soundFor(AgentState.UNKNOWN))
    }
}
