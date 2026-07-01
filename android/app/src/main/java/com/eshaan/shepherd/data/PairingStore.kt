package com.eshaan.shepherd.data

data class Pairing(
    val host: String,
    val port: Int,
    val deviceId: String,
    val deviceName: String,
    val secret: String,
)

interface PairingStore {
    fun load(): Pairing?
    fun save(p: Pairing)
    fun clear()
}

class InMemoryPairingStore : PairingStore {
    private var current: Pairing? = null
    override fun load(): Pairing? = current
    override fun save(p: Pairing) { current = p }
    override fun clear() { current = null }
}
