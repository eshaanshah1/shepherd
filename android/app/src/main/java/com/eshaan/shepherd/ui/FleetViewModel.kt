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
    /**
     * Finds a wifi-paired Mac again when DHCP moves it. Null on tailnet-only builds and in tests.
     * Returns the address now serving the certificate behind the pin, or null.
     */
    private val relocate: (suspend (String) -> Pair<String, Int>?)? = null,
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
    /** Null on the tailnet; on the LAN the data channel must be pinned like the control one. */
    val lanPin: String? get() = store.load()?.lanPin

    fun openAgent(paneId: String) { _navTarget.value = NavTarget.Agent(paneId) }
    fun consumeNavTarget() { _navTarget.value = null }
    private var connectJob: Job? = null
    private var inboundJob: Job? = null
    private var statusJob: Job? = null

    /** Pure reducer (unit-tested). */
    fun applyInbound(msg: ControlMessage) { _fleet.value = _fleet.value.applying(msg); PromptStore.update(msg) }

    fun connect() {
        val p = store.load() ?: return
        val controller = PairingController(store)
        connectJob = viewModelScope.launch {
            val token = fcmToken()
            val c = connectionFactory(viewModelScope) { controller.helloForReconnect(p, token) } ?: return@launch
            conn = c
            inboundJob = viewModelScope.launch { c.inbound.collect { applyInbound(it) } }
            statusJob = viewModelScope.launch {
                c.status.collect { st ->
                    _connected.value = st is ConnStatus.Connected
                    if (st is ConnStatus.Failed) tryRelocate(p.lanPin)
                }
            }
            c.start()
        }
    }

    /**
     * A wifi pairing that stops connecting is usually a moved DHCP lease, not a gone Mac. The
     * certificate pin is the identity and does not move, so re-discover the address behind it and
     * reconnect. Guarded so a failing loop cannot spawn a browse per retry.
     */
    private var relocating = false
    private fun tryRelocate(pinB64: String?) {
        val find = relocate ?: return
        if (pinB64 == null || relocating) return
        relocating = true
        viewModelScope.launch {
            try {
                val found = find(pinB64) ?: return@launch
                val current = store.load() ?: return@launch
                if (found.first == current.host && found.second == current.port) return@launch
                store.save(current.copy(host = found.first, port = found.second))
                refresh()
            } finally { relocating = false }
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
