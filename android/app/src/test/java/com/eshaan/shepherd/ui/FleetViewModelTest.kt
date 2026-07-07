package com.eshaan.shepherd.ui

import com.eshaan.shepherd.data.InMemoryPairingStore
import com.eshaan.shepherd.data.Pairing
import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.protocol.PaneInfo
import com.eshaan.shepherd.protocol.RemoteNode
import com.eshaan.shepherd.protocol.RemotePane
import com.eshaan.shepherd.protocol.RemoteTab
import com.eshaan.shepherd.protocol.WorkspaceTree
import org.junit.Assert.*
import org.junit.Test

class FleetViewModelTest {
    private fun vm(): FleetViewModel {
        val store = InMemoryPairingStore()
        store.save(Pairing("h", 8722, "d", "n", "sec"))
        return FleetViewModel(store, fcmToken = { null }, connectionFactory = { _, _ -> null })
    }
    @Test fun snapshotThenDeltaUpdatesFleet() {
        val vm = vm()
        vm.applyInbound(ControlMessage.WorkspaceTreeMsg(
            WorkspaceTree("w", "W", listOf(RemoteTab("t1",
                RemoteNode.Leaf(RemotePane("p1","t",null,"idle",null)), "p1", null)), "t1")))
        assertEquals(1, vm.fleet.value.panes.size)
        vm.applyInbound(ControlMessage.StateMsg("p1","blocked","approve Bash"))
        assertEquals("blocked", vm.fleet.value.pane("p1")!!.state)
        assertEquals(1, vm.fleet.value.attentionCount)
    }

    @Test fun openAgentSetsNavTargetAndConsumeClears() {
        val vm = vm()
        assertNull(vm.navTarget.value)
        vm.openAgent("p1")
        assertEquals(NavTarget.Agent("p1"), vm.navTarget.value)
        vm.consumeNavTarget()
        assertNull(vm.navTarget.value)
    }
}
