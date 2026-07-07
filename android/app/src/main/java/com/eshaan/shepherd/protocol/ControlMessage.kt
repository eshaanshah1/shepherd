package com.eshaan.shepherd.protocol

sealed interface ControlMessage {
    data class Hello(
        val deviceId: String,
        val deviceName: String,
        val pairingCode: String?,
        val secret: String?,
        val fcmToken: String?,
        val protocolVersion: Int = 2,
    ) : ControlMessage
    data class RefreshFcmToken(val token: String) : ControlMessage
    data class Accepted(val sessionNonce: String) : ControlMessage
    data class Rejected(val reason: String) : ControlMessage
    data object PendingApproval : ControlMessage
    // v2 structural snapshot (host→client). The flat Snapshot is gone; the fleet list is
    // derived by flattening each WorkspaceTree's leaves (Fleet.flatten).
    data class WorkspaceTreeMsg(val tree: WorkspaceTree) : ControlMessage
    data class WorkspaceList(val ids: List<String>) : ControlMessage
    data class WorkspaceRemoved(val workspaceId: String) : ControlMessage
    data class StateMsg(val paneId: String, val state: String, val reason: String?) : ControlMessage
    data class PaneAdded(val pane: PaneInfo) : ControlMessage
    data class PaneRemoved(val paneId: String) : ControlMessage
    data class PaneRenamed(val paneId: String, val title: String) : ControlMessage
    data class Resize(val paneId: String, val cols: Int, val rows: Int) : ControlMessage
    data class Prompt(
        val paneId: String,
        val kind: String,                       // "askUserQuestion" | "permission" | "plan"
        val detail: String?,                    // permission: the tool name; else null
        val questions: List<PromptQuestion>?,   // askUserQuestion only
    ) : ControlMessage
    data object Detach : ControlMessage
    data object Ping : ControlMessage
    data object Pong : ControlMessage
}

/** One question in an AskUserQuestion prompt. Byte-pinned to the Swift PromptQuestion. */
data class PromptQuestion(
    val prompt: String,
    val header: String,
    val options: List<String>,
    val multiSelect: Boolean,
)

// v2 structural tree DTOs — byte-pinned to the Swift RemotePane/RemoteNode/RemoteTab/WorkspaceTree.

/** One leaf pane, live fields. Mirrors the Swift RemotePane. */
data class RemotePane(val paneId: String, val title: String, val cwd: String?, val state: String, val reason: String?)

/** A tab's split tree. Mirrors the Swift RemoteNode (same JSON: kind/pane/axis/ratio/first/second). */
sealed interface RemoteNode {
    data class Leaf(val pane: RemotePane) : RemoteNode
    data class Split(val axis: String, val ratio: Double, val first: RemoteNode, val second: RemoteNode) : RemoteNode
}

data class RemoteTab(val tabId: String, val root: RemoteNode, val focusedPaneId: String?, val zoomedPaneId: String?)

data class WorkspaceTree(val workspaceId: String, val name: String, val tabs: List<RemoteTab>, val selectedTabId: String?)
