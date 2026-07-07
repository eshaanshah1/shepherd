package com.eshaan.shepherd.model

import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.protocol.PaneInfo
import com.eshaan.shepherd.protocol.RemoteNode
import com.eshaan.shepherd.protocol.WorkspaceTree

data class Fleet(val panes: List<PaneInfo>) {
    fun pane(id: String): PaneInfo? = panes.firstOrNull { it.paneId == id }
    val attentionCount: Int get() = panes.count { AgentState.fromRaw(it.state).wantsAttention }

    fun byWorkspace(): List<Pair<String, List<PaneInfo>>> {
        val order = LinkedHashMap<String, MutableList<PaneInfo>>()
        for (p in panes) order.getOrPut(p.workspace) { mutableListOf() }.add(p)
        return order.map { it.key to it.value.toList() }
    }

    fun applying(msg: ControlMessage): Fleet = when (msg) {
        // v2: replace just this workspace's panes with the flattened tree; other workspaces
        // (keyed by name) are untouched. A removed pane is simply absent from the new tree.
        is ControlMessage.WorkspaceTreeMsg -> Fleet(panes.filterNot { it.workspace == msg.tree.name } + flatten(msg.tree))
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

    companion object {
        /// Flatten a WorkspaceTree's leaves into flat PaneInfo rows (the phone renders a
        /// list, not split geometry). Workspace name is the grouping key, matching byWorkspace().
        fun flatten(tree: WorkspaceTree): List<PaneInfo> {
            val out = ArrayList<PaneInfo>()
            fun walk(n: RemoteNode) {
                when (n) {
                    is RemoteNode.Leaf -> out.add(PaneInfo(n.pane.paneId, n.pane.title, tree.name, n.pane.state, n.pane.reason))
                    is RemoteNode.Split -> { walk(n.first); walk(n.second) }
                }
            }
            tree.tabs.forEach { walk(it.root) }
            return out
        }
    }
}
