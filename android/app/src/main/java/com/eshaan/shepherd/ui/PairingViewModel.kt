package com.eshaan.shepherd.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.eshaan.shepherd.data.DeviceIdentity
import com.eshaan.shepherd.data.Pairing
import com.eshaan.shepherd.data.PairingStore
import com.eshaan.shepherd.pairing.PairingController
import com.eshaan.shepherd.pairing.PairingState
import com.eshaan.shepherd.transport.RemoteConnection
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class PairingViewModel(
    private val store: PairingStore,
    private val controller: PairingController = PairingController(store),
    private val fcmToken: suspend () -> String?,
) : ViewModel() {
    private val _state = MutableStateFlow<PairingState>(PairingState.Idle)
    val state: StateFlow<PairingState> = _state
    private var conn: RemoteConnection? = null

    fun pair(host: String, ip: String?, port: Int) {
        val deviceId = DeviceIdentity.newDeviceId()
        val primary = host.ifBlank { ip ?: "" }
        val fallbacks = listOfNotNull(ip).filter { it != primary }
        val pending = Pairing(primary, port, deviceId, DeviceIdentity.deviceName(), DeviceIdentity.newSecret())
        viewModelScope.launch {
            val token = fcmToken()
            val c = RemoteConnection(primary, port,
                helloFactory = { controller.helloForFirstPair(deviceId, pending.deviceName, pending.secret, token) },
                scope = viewModelScope, fallbackHosts = fallbacks)
            conn = c
            viewModelScope.launch { c.status.collect { _state.value = controller.reduce(_state.value, it, pending) } }
            c.start()
        }
    }

    override fun onCleared() { conn?.stop() }
}
