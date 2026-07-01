package com.eshaan.shepherd.pairing

import com.eshaan.shepherd.data.InMemoryPairingStore
import com.eshaan.shepherd.data.Pairing
import com.eshaan.shepherd.transport.ConnStatus
import org.junit.Assert.*
import org.junit.Test

class PairingControllerTest {
    private val pending = Pairing("100.64.0.5", 8722, "dev-1", "Pixel 8", "secret-abc")

    @Test fun firstPairHelloCarriesCodeAndSecretAndToken() {
        val c = PairingController(InMemoryPairingStore())
        val h = c.helloForFirstPair("h", 8722, "0042", "dev-1", "Pixel 8", "secret-abc", "tok")
        assertEquals("0042", h.pairingCode); assertEquals("secret-abc", h.secret)
        assertEquals("tok", h.fcmToken); assertEquals("dev-1", h.deviceId)
    }
    @Test fun reconnectHelloHasNoCode() {
        val c = PairingController(InMemoryPairingStore())
        val h = c.helloForReconnect(pending, "tok")
        assertNull(h.pairingCode); assertEquals("secret-abc", h.secret)
    }
    @Test fun statusDrivesStateAndPersistsOnAccept() {
        val store = InMemoryPairingStore()
        val c = PairingController(store)
        assertEquals(PairingState.Connecting, c.reduce(PairingState.Idle, ConnStatus.Connecting, pending))
        assertEquals(PairingState.WaitingApproval, c.reduce(PairingState.Connecting, ConnStatus.Pending, pending))
        val paired = c.reduce(PairingState.WaitingApproval, ConnStatus.Connected("n"), pending)
        assertEquals(PairingState.Paired(pending), paired)
        assertEquals(pending, store.load())   // persisted on accept
    }
    @Test fun rejectionSurfacesError() {
        val c = PairingController(InMemoryPairingStore())
        val s = c.reduce(PairingState.Connecting, ConnStatus.Failed("bad secret"), pending)
        assertEquals(PairingState.Error("bad secret"), s)
    }
}
