package com.eshaan.shepherd.protocol

sealed interface ControlMessage {
    data class Hello(
        val deviceId: String,
        val deviceName: String,
        val pairingCode: String?,
        val secret: String?,
        val fcmToken: String?,
        val protocolVersion: Int = 1,
    ) : ControlMessage
    data class RefreshFcmToken(val token: String) : ControlMessage
    data class Accepted(val sessionNonce: String) : ControlMessage
    data class Rejected(val reason: String) : ControlMessage
    data object PendingApproval : ControlMessage
    data class Snapshot(val panes: List<PaneInfo>) : ControlMessage
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
