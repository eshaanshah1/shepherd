package com.eshaan.shepherd.model

import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.protocol.PaneInfo

data class Fleet(val panes: List<PaneInfo>) {
    fun pane(id: String): PaneInfo? = panes.firstOrNull { it.paneId == id }
    val attentionCount: Int get() = panes.count { AgentState.fromRaw(it.state).wantsAttention }

    fun byWorkspace(): List<Pair<String, List<PaneInfo>>> {
        val order = LinkedHashMap<String, MutableList<PaneInfo>>()
        for (p in panes) order.getOrPut(p.workspace) { mutableListOf() }.add(p)
        return order.map { it.key to it.value.toList() }
    }

    fun applying(msg: ControlMessage): Fleet = when (msg) {
        is ControlMessage.Snapshot -> Fleet(msg.panes)
        is ControlMessage.StateMsg -> Fleet(panes.map {
            if (it.paneId == msg.paneId) it.copy(state = msg.state, reason = msg.reason) else it
        })
        is ControlMessage.PaneAdded ->
            if (pane(msg.pane.paneId) != null) this else Fleet(panes + msg.pane)
        is ControlMessage.PaneRemoved -> Fleet(panes.filterNot { it.paneId == msg.paneId })
        is ControlMessage.PaneRenamed -> Fleet(panes.map {
            if (it.paneId == msg.paneId) it.copy(title = msg.title) else it
        })
        else -> this
    }
}
