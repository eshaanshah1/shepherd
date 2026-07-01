package com.eshaan.shepherd.pairing

import com.eshaan.shepherd.data.Pairing
import com.eshaan.shepherd.data.PairingStore
import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.transport.ConnStatus

sealed interface PairingState {
    data object Idle : PairingState
    data object Connecting : PairingState
    data object WaitingApproval : PairingState
    data class Paired(val pairing: Pairing) : PairingState
    data class Error(val reason: String) : PairingState
}

class PairingController(private val store: PairingStore) {
    fun helloForFirstPair(host: String, port: Int, code: String, deviceId: String,
                          deviceName: String, secret: String, fcmToken: String?): ControlMessage.Hello =
        ControlMessage.Hello(deviceId, deviceName, pairingCode = code, secret = secret, fcmToken = fcmToken)

    fun helloForReconnect(p: Pairing, fcmToken: String?): ControlMessage.Hello =
        ControlMessage.Hello(p.deviceId, p.deviceName, pairingCode = null, secret = p.secret, fcmToken = fcmToken)

    /** Pure status->state map. Persists the pending pairing exactly when accepted. */
    fun reduce(prev: PairingState, status: ConnStatus, pending: Pairing): PairingState = when (status) {
        is ConnStatus.Connecting -> PairingState.Connecting
        is ConnStatus.Pending -> PairingState.WaitingApproval
        is ConnStatus.Connected -> { store.save(pending); PairingState.Paired(pending) }
        is ConnStatus.Failed -> PairingState.Error(status.reason)
        is ConnStatus.Disconnected -> prev   // transient between retries; don't clobber
    }
}
