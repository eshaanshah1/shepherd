package com.eshaan.shepherd.data

import org.junit.Assert.*
import org.junit.Test

class PairingStoreTest {
    @Test fun saveLoadClearRoundTrips() {
        val store = InMemoryPairingStore()
        assertNull(store.load())
        val p = Pairing("100.64.0.5", 8722, "dev-1", "Pixel 8", "secret-abc")
        store.save(p)
        assertEquals(p, store.load())
        store.clear()
        assertNull(store.load())
    }
    @Test fun newSecretIsUniqueAndNonEmpty() {
        val a = DeviceIdentity.newSecret(); val b = DeviceIdentity.newSecret()
        assertTrue(a.isNotBlank()); assertNotEquals(a, b)
    }
}
