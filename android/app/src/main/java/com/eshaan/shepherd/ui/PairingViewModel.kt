package com.eshaan.shepherd.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.eshaan.shepherd.data.DeviceIdentity
import com.eshaan.shepherd.data.Pairing
import com.eshaan.shepherd.data.PairingStore
import com.eshaan.shepherd.pairing.PairingController
import com.eshaan.shepherd.pairing.PairingState
import com.eshaan.shepherd.transport.ConnStatus
import com.eshaan.shepherd.transport.Pinning
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
    /** While a LAN pairing is in flight: the six digits derived from the certificate this phone
     *  was actually handed. The user picks these on the Mac — a mismatch is the detection. */
    private val _sas = MutableStateFlow<String?>(null)
    val sas: StateFlow<String?> = _sas

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

    /**
     * Pair over the local network. There is no pin yet, so the certificate is learned and its SAS
     * published for the user to confirm on the host; the pin is persisted only when the host
     * accepts, which happens only if that confirmation matched.
     */
    fun pairOverLan(host: String, port: Int, code: String) {
        val deviceId = DeviceIdentity.newDeviceId()
        val pending = Pairing(host, port, deviceId, DeviceIdentity.deviceName(), DeviceIdentity.newSecret())
        val observed = java.util.concurrent.atomic.AtomicReference<ByteArray?>(null)
        viewModelScope.launch {
            val token = fcmToken()
            val c = RemoteConnection(host, port,
                helloFactory = {
                    controller.helloForFirstPair(deviceId, pending.deviceName, pending.secret, token,
                                                 pairingCode = code)
                },
                scope = viewModelScope,
                connect = Pinning.learningConnector { hash ->
                    observed.set(hash)
                    _sas.value = Pinning.sasDigits(hash)
                })
            conn = c
            viewModelScope.launch {
                c.status.collect { st ->
                    val withPin = pending.copy(lanPin = observed.get()?.let(Pinning::encodePin))
                    _state.value = controller.reduce(_state.value, st, withPin)
                    if (st !is ConnStatus.Connecting && st !is ConnStatus.Pending) _sas.value = null
                }
            }
            c.start()
        }
    }

    override fun onCleared() { conn?.stop() }
}
