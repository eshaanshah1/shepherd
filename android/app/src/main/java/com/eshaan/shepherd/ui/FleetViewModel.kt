package com.eshaan.shepherd.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.eshaan.shepherd.data.PairingStore
import com.eshaan.shepherd.model.Fleet
import com.eshaan.shepherd.pairing.PairingController
import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.transport.ConnStatus
import com.eshaan.shepherd.transport.RemoteConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** Where the Fleet screen wants to navigate next (a pane tap or a notification deep-link). */
sealed interface NavTarget {
    data class Agent(val paneId: String) : NavTarget
}

class FleetViewModel(
    private val store: PairingStore,
    private val fcmToken: suspend () -> String?,
    private val connectionFactory: (CoroutineScope, () -> ControlMessage.Hello) -> RemoteConnection?,
) : ViewModel() {
    private val _fleet = MutableStateFlow(Fleet(emptyList()))
    val fleet: StateFlow<Fleet> = _fleet
    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected
    private val _navTarget = MutableStateFlow<NavTarget?>(null)
    val navTarget: StateFlow<NavTarget?> = _navTarget
    private var conn: RemoteConnection? = null

    /** The live control connection + its endpoint, for the Agent screen to open a data channel. */
    val activeConnection: RemoteConnection? get() = conn
    val host: String? get() = store.load()?.host
    val port: Int? get() = store.load()?.port

    fun openAgent(paneId: String) { _navTarget.value = NavTarget.Agent(paneId) }
    fun consumeNavTarget() { _navTarget.value = null }
    private var connectJob: Job? = null
    private var inboundJob: Job? = null
    private var statusJob: Job? = null

    /** Pure reducer (unit-tested). */
    fun applyInbound(msg: ControlMessage) { _fleet.value = _fleet.value.applying(msg) }

    fun connect() {
        val p = store.load() ?: return
        val controller = PairingController(store)
        connectJob = viewModelScope.launch {
            val token = fcmToken()
            val c = connectionFactory(viewModelScope) { controller.helloForReconnect(p, token) } ?: return@launch
            conn = c
            inboundJob = viewModelScope.launch { c.inbound.collect { applyInbound(it) } }
            statusJob = viewModelScope.launch { c.status.collect { _connected.value = it is ConnStatus.Connected } }
            c.start()
        }
    }

    fun refresh() { disconnect(); connect() }   // reconnect re-snapshots

    fun disconnect() {
        connectJob?.cancel(); connectJob = null
        inboundJob?.cancel(); inboundJob = null
        statusJob?.cancel(); statusJob = null
        conn?.stop(); conn = null
        _connected.value = false
    }

    override fun onCleared() { disconnect() }
}
