package com.eshaan.shepherd.fcm

import com.eshaan.shepherd.model.AgentState

data class WakeContent(
    val paneId: String,
    val title: String,
    val body: String,
    val urgent: Boolean,
    val state: AgentState,
)

object FcmWake {
    fun parse(data: Map<String, String>): WakeContent? {
        val paneId = data["paneID"] ?: return null
        val state = AgentState.fromRaw(data["state"] ?: "")
        val urgent = data["urgent"] == "true"
        val body = when (state) {
            AgentState.BLOCKED -> "An agent needs you (blocked)"
            AgentState.NEEDS_CHECK -> "An agent finished — needs a check"
            AgentState.ERROR -> "An agent hit an error"
            else -> "Agent update"
        }
        return WakeContent(paneId, "Shepherd", body, urgent, state)
    }
}
