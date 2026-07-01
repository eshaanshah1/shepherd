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

class FleetViewModel(
    private val store: PairingStore,
    private val fcmToken: suspend () -> String?,
    private val connectionFactory: (CoroutineScope, () -> ControlMessage.Hello) -> RemoteConnection?,
) : ViewModel() {
    private val _fleet = MutableStateFlow(Fleet(emptyList()))
    val fleet: StateFlow<Fleet> = _fleet
    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected
    private var conn: RemoteConnection? = null
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
