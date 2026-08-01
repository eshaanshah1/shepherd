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
    /** The Mac currently being shown, or null if none are paired. */
    fun load(): Pairing?
    /** Add or update a pairing AND select it. */
    fun save(p: Pairing)
    /** Every Mac this phone has paired with, in the order they were added. */
    fun loadAll(): List<Pairing>
    /** Switch which paired Mac is shown. No-op for an id we don't hold. */
    fun select(hostID: String)
    /** Forget one Mac; if it was selected, the next one takes over. */
    fun forget(hostID: String)
    /** Forget everything. */
    fun clear()
}

/** "host:port" — the identity a pairing is stored under. */
val Pairing.hostID: String get() = "$host:$port"

/** Shared list semantics, so the in-memory and encrypted stores cannot drift apart. */
internal fun List<Pairing>.upserting(p: Pairing): List<Pairing> {
    val i = indexOfFirst { it.hostID == p.hostID }
    return if (i < 0) this + p else toMutableList().also { it[i] = p }
}

class InMemoryPairingStore : PairingStore {
    private var all: List<Pairing> = emptyList()
    private var selected: String? = null

    override fun load(): Pairing? =
        all.firstOrNull { it.hostID == selected } ?: all.firstOrNull()
    override fun loadAll(): List<Pairing> = all
    override fun save(p: Pairing) { all = all.upserting(p); selected = p.hostID }
    override fun select(hostID: String) { if (all.any { it.hostID == hostID }) selected = hostID }
    override fun forget(hostID: String) {
        all = all.filterNot { it.hostID == hostID }
        if (selected == hostID) selected = all.firstOrNull()?.hostID
    }
    override fun clear() { all = emptyList(); selected = null }
}
