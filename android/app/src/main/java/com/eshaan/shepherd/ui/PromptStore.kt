package com.eshaan.shepherd.ui

import com.eshaan.shepherd.protocol.ControlMessage
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map

/**
 * The current blocking prompt per pane. Populated by the ALWAYS-ON inbound collector
 * ([FleetViewModel]) so the value survives until the Agent screen opens — the host broadcasts a
 * `prompt` once at block time (no replay), and the screen attaches later. The Agent screen reads
 * from here (current value + live updates), so it never misses a prompt. Cleared when a pane leaves
 * the blocked state.
 */
object PromptStore {
    private val _byPane = MutableStateFlow<Map<String, ControlMessage.Prompt>>(emptyMap())

    fun update(m: ControlMessage) {
        when (m) {
            is ControlMessage.Prompt -> _byPane.value = _byPane.value + (m.paneId to m)
            is ControlMessage.StateMsg -> if (m.state != "blocked") _byPane.value = _byPane.value - m.paneId
            else -> {}
        }
    }

    fun flow(paneId: String): Flow<ControlMessage.Prompt?> = _byPane.map { it[paneId] }

    /** Test-only reset (the store is a process-wide singleton). */
    fun reset() { _byPane.value = emptyMap() }
}
