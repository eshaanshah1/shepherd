package com.eshaan.shepherd.model

import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.protocol.PaneInfo
import org.junit.Assert.*
import org.junit.Test

class FleetTest {
    private val p1 = PaneInfo("p1","a","W1","working",null)
    private val p2 = PaneInfo("p2","b","W2","blocked","approve Bash")

    @Test fun fromRawMapsHyphenatedNeedsCheck() {
        assertEquals(AgentState.NEEDS_CHECK, AgentState.fromRaw("need-to-check"))
        assertEquals(AgentState.ERROR, AgentState.fromRaw("error"))
        assertEquals(AgentState.UNKNOWN, AgentState.fromRaw("bogus"))
    }
    @Test fun attentionStates() {
        assertTrue(AgentState.BLOCKED.wantsAttention)
        assertTrue(AgentState.NEEDS_CHECK.wantsAttention)
        assertTrue(AgentState.ERROR.wantsAttention)
        assertFalse(AgentState.WORKING.wantsAttention)
    }
    @Test fun snapshotReplacesAndCounts() {
        val f = Fleet(emptyList()).applying(ControlMessage.Snapshot(listOf(p1, p2)))
        assertEquals(2, f.panes.size); assertEquals(1, f.attentionCount)
    }
    @Test fun stateUpdatesOnePane() {
        val f = Fleet(listOf(p1, p2)).applying(ControlMessage.StateMsg("p1","blocked","plan approval"))
        assertEquals("blocked", f.pane("p1")!!.state)
        assertEquals("plan approval", f.pane("p1")!!.reason)
        assertEquals(2, f.attentionCount)
    }
    @Test fun addRemoveRename() {
        var f = Fleet(listOf(p1)).applying(ControlMessage.PaneAdded(p2))
        assertEquals(2, f.panes.size)
        f = f.applying(ControlMessage.PaneRemoved("p1"))
        assertNull(f.pane("p1"))
        f = f.applying(ControlMessage.PaneRenamed("p2","renamed"))
        assertEquals("renamed", f.pane("p2")!!.title)
    }
    @Test fun groupsByWorkspacePreservingOrder() {
        val f = Fleet(listOf(p1, p2, p1.copy(paneId="p3")))
        val g = f.byWorkspace()
        assertEquals(listOf("W1","W2"), g.map { it.first })
        assertEquals(2, g[0].second.size)
    }
}
