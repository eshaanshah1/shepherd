package com.eshaan.shepherd.v2

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * This phone's membership of a net: its key pair, and the chain that proves the
 * net admitted it.
 *
 * **It is per NET, not per Mac** — which is the whole change. The record it
 * replaces held a `secret` per Mac, so three Macs meant three ceremonies and
 * three secrets; here one join produces one chain that every Mac in the net
 * accepts, including Macs this phone has never connected to.
 *
 * The private key never leaves this device and is never sent: what travels is the
 * chain (public) plus a signature proving this phone holds the key the chain
 * names. That is why a stolen chain is worth nothing.
 */
data class Membership(
    val netId: String,
    val netName: String,
    /** Hex SPKI DER. What every chain in this net terminates at. */
    val rootPublicKey: String,
    /** This phone's id inside the net. */
    val memberId: String,
    val memberKey: MemberKey,
    /** This phone's chain, leaf first. */
    val chain: List<Credential>,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("netId", netId)
        .put("netName", netName)
        .put("rootPublicKey", rootPublicKey)
        .put("memberId", memberId)
        .put("publicKey", memberKey.publicKey)
        .put("privateKey", memberKey.privateKey)
        .put("chain", Credential.listToJson(chain))

    companion object {
        fun fromJson(json: JSONObject) = Membership(
            netId = json.getString("netId"),
            netName = json.optString("netName", ""),
            rootPublicKey = json.getString("rootPublicKey"),
            memberId = json.getString("memberId"),
            memberKey = MemberKey(json.getString("publicKey"), json.getString("privateKey")),
            chain = Credential.listFromJson(json.optJSONArray("chain") ?: JSONArray()),
        )
    }
}

/**
 * One other member of the net, as somebody's roster describes it.
 *
 * A HINT, not authority: the name and address are what a Mac told us, and what
 * makes a connection safe is the chain that member presents plus the certificate
 * its credential names. What this buys is that a second Mac never has to be
 * scanned — it arrives in the roster of the first.
 */
data class RosterEntry(
    val memberId: String,
    val name: String,
    /** `host:port` for control, most recent first. Empty for a device that serves nothing. */
    val addrs: List<String>,
    /** Where that member's ptys are. 0 when it has none. */
    val dataPort: Int,
) {
    val host: String? get() = addrs.firstOrNull()?.substringBeforeLast(':')
    val port: Int? get() = addrs.firstOrNull()?.substringAfterLast(':')?.toIntOrNull()
    val reachable: Boolean get() = host != null && port != null

    fun toJson(): JSONObject = JSONObject()
        .put("memberId", memberId)
        .put("name", name)
        .put("dataPort", dataPort)
        .put("addrs", JSONArray().apply { addrs.forEach { put(it) } })

    companion object {
        fun fromJson(json: JSONObject): RosterEntry {
            val list = json.optJSONArray("addrs") ?: JSONArray()
            return RosterEntry(
                memberId = json.getString("memberId"),
                name = json.optString("name", ""),
                addrs = (0 until list.length()).map { list.getString(it) },
                dataPort = json.optInt("dataPort", 0),
            )
        }

        fun listFromJson(array: JSONArray): List<RosterEntry> =
            (0 until array.length()).mapNotNull { runCatching { fromJson(array.getJSONObject(it)) }.getOrNull() }
    }
}

/**
 * Where memberships live, and where this phone's own identity comes from.
 *
 * **The device id is minted once and kept.** It is what a credential names and
 * what a revocation names, so a phone that minted a fresh one per join would
 * arrive at every Mac as a stranger — and revoking it on one Mac would name an id
 * that no longer exists anywhere.
 *
 * **The key pair is minted once per JOIN**, not per launch: it is the thing the
 * chain is about. Minting a new one would invalidate the membership silently, and
 * the symptom would be every Mac refusing a phone that believes it is a member.
 */
class NetStore(context: Context) {
    private val prefs = context.getSharedPreferences("shepherd.v2", Context.MODE_PRIVATE)

    fun all(): List<Membership> {
        val raw = prefs.getString(KEY, null) ?: return emptyList()
        return runCatching {
            val list = JSONArray(raw)
            (0 until list.length()).map { Membership.fromJson(list.getJSONObject(it)) }
        }.getOrDefault(emptyList())
    }

    fun byNet(netId: String): Membership? = all().firstOrNull { it.netId == netId }

    /**
     * The net whose Macs this phone is currently watching.
     *
     * Several memberships, one active — the same rule the Mac keeps. A phone
     * watching two laptops needs both in ONE net; the active choice only matters
     * across nets, say home and work, which is where the separation is wanted.
     */
    fun active(): Membership? {
        val netId = prefs.getString(ACTIVE, null) ?: return all().firstOrNull()
        return byNet(netId) ?: all().firstOrNull()
    }

    fun setActive(netId: String) = prefs.edit().putString(ACTIVE, netId).apply()

    fun put(membership: Membership) {
        write(all().filterNot { it.netId == membership.netId } + membership)
        // Joining your first net selects it: a phone in exactly one net that
        // watches nothing because nothing was "selected" is a state with no
        // visible cause and no way out.
        if (prefs.getString(ACTIVE, null) == null) setActive(membership.netId)
    }

    fun forget(netId: String) {
        write(all().filterNot { it.netId == netId })
        if (prefs.getString(ACTIVE, null) == netId) prefs.edit().remove(ACTIVE).apply()
    }

    fun forgetAll() = prefs.edit().remove(KEY).remove(ACTIVE).remove(ROSTER).apply()

    /**
     * The other members of a net, as last heard.
     *
     * Kept because a phone that has been away needs somewhere to look BEFORE it
     * has connected to anything — otherwise the device list is empty until you
     * reach a Mac, which is exactly when you do not need it.
     */
    fun roster(netId: String): List<RosterEntry> = runCatching {
        val raw = prefs.getString("$ROSTER.$netId", null) ?: return emptyList()
        RosterEntry.listFromJson(JSONArray(raw))
    }.getOrDefault(emptyList())

    fun putRoster(netId: String, entries: List<RosterEntry>) {
        val json = JSONArray().apply { entries.forEach { put(it.toJson()) } }
        prefs.edit().putString("$ROSTER.$netId", json.toString()).apply()
    }

    /** Minted once, kept forever. See the class comment. */
    fun deviceId(): String {
        prefs.getString(DEVICE, null)?.let { return it }
        val minted = UUID.randomUUID().toString()
        prefs.edit().putString(DEVICE, minted).apply()
        return minted
    }

    private fun write(memberships: List<Membership>) {
        val json = JSONArray().apply { memberships.forEach { put(it.toJson()) } }
        prefs.edit().putString(KEY, json.toString()).apply()
    }

    private companion object {
        const val KEY = "nets.v1"
        const val ACTIVE = "nets.active"
        const val DEVICE = "device.id"
        const val ROSTER = "nets.roster"
    }
}
