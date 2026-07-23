package com.eshaan.shepherd.data

import org.junit.Assert.*
import org.junit.Test

class SettingsStoreTest {
    @Test fun ignoreSilentDefaultsOff() {
        assertFalse(InMemorySettingsStore().ignoreSilent)
    }
    @Test fun ignoreSilentRoundTrips() {
        val store = InMemorySettingsStore()
        store.ignoreSilent = true
        assertTrue(store.ignoreSilent)
        store.ignoreSilent = false
        assertFalse(store.ignoreSilent)
    }
}
