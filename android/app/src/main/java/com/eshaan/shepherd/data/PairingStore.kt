package com.eshaan.shepherd.data

data class Pairing(
    val host: String,
    val port: Int,
    val deviceId: String,
    val deviceName: String,
    val secret: String,
    /**
     * Base64 SHA-256 of the host's certificate, set only for a pairing made over the local
     * network. Null ⇒ a tailnet pairing, dialled in the clear inside WireGuard exactly as before.
     */
    val lanPin: String? = null,
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
