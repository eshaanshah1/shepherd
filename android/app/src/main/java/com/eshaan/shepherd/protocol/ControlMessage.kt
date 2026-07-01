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
    data object Detach : ControlMessage
    data object Ping : ControlMessage
    data object Pong : ControlMessage
}
