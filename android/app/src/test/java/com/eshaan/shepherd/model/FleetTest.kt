package com.eshaan.shepherd.model

import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.protocol.PaneInfo
import com.eshaan.shepherd.protocol.RemoteNode
import com.eshaan.shepherd.protocol.RemotePane
import com.eshaan.shepherd.protocol.RemoteTab
import com.eshaan.shepherd.protocol.WorkspaceTree
import org.junit.Assert.*
import org.junit.Test

class FleetTest {
    private val p1 = PaneInfo("p1","a","W1","working",null)
    private val p2 = PaneInfo("p2","b","W2","blocked","approve Bash")

    /// A single-workspace, single-tab, single-leaf tree named `ws`.
    private fun leafTree(ws: String, pane: RemotePane) =
        WorkspaceTree(ws, ws, listOf(RemoteTab("t-$ws", RemoteNode.Leaf(pane), pane.paneId, null)), "t-$ws")

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
    @Test fun workspaceTreeReplacesPerWorkspaceAndCounts() {
        val f = Fleet(emptyList())
            .applying(ControlMessage.WorkspaceTreeMsg(leafTree("W1", RemotePane("p1","a",null,"working",null))))
            .applying(ControlMessage.WorkspaceTreeMsg(leafTree("W2", RemotePane("p2","b",null,"blocked","approve Bash"))))
        assertEquals(2, f.panes.size); assertEquals(1, f.attentionCount)
    }

    @Test fun workspaceTreeReplacesOnlyItsOwnWorkspace() {
        // Re-sending W1's tree with a different pane replaces W1's panes but leaves W2 intact.
        val f = Fleet(listOf(p1, p2))
            .applying(ControlMessage.WorkspaceTreeMsg(leafTree("W1", RemotePane("p9","z",null,"idle",null))))
        assertNull(f.pane("p1")); assertNotNull(f.pane("p9")); assertNotNull(f.pane("p2"))
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
