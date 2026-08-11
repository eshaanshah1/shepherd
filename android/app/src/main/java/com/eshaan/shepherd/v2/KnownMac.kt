package com.eshaan.shepherd.v2

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * A Mac this phone knows, and every way it has ever been reached.
 *
 * **The identity is the certificate pin, not an address.** That is the whole
 * point of this file. A Mac's address changes constantly — it moves between
 * access points, it is 127.0.0.1 over a USB forward, it is a 100.x address on a
 * tailnet, and it is a different 192.168.x on every network you carry it to. Key
 * a pairing by `(host, port)` and each of those is a DIFFERENT Mac: a separate
 * pairing, a separate device id, a separate approval, and a terminal that says
 * "cannot reach this Mac" the moment you walk into another building.
 *
 * The pin does not move, so it is the right primary key for an ADDRESS LIST —
 * which, since shep-nets, is all this record is. Identity moved out: this phone
 * is a member of a NET (see `Membership`), and every Mac in that net admits it
 * with the same chain. What is left here is "where has this Mac answered", plus
 * which net it belongs to.
 *
 * An address is therefore a CANDIDATE, and there can be several. Adding
 * `remote-tailscale` to a Mac you already reach over wifi is adding an endpoint
 * to this record — no second join, no second approval, same membership.
 */
data class Endpoint(
    /** Where control (the app) answers. */
    val host: String,
    val port: Int,
    /**
     * Where the ptys are — the DAEMON's port, not the app's.
     *
     * A device holds two connections on purpose: control to the app (where
     * extensions, and therefore views, live) and data to the daemon (which owns
     * the ptys). The split is what makes restarting Shepherd drop this phone's
     * task list while the terminal it is watching keeps streaming.
     */
    val dataPort: Int,
    /** How it was found — `wifi`, `tailscale`, `usb`. For the UI, and for order. */
    val via: String = "manual",
) {
    fun toJson(): JSONObject = JSONObject()
        .put("host", host)
        .put("port", port)
        .put("dataPort", dataPort)
        .put("via", via)

    companion object {
        fun fromJson(json: JSONObject) = Endpoint(
            host = json.getString("host"),
            port = json.getInt("port"),
            dataPort = json.optInt("dataPort", 0),
            via = json.optString("via", "manual"),
        )
    }
}

data class KnownMac(
    /** SHA-256 of the certificate DER, lowercase hex. THE identity. */
    val pin: String,
    /** Every address this Mac has been reachable at, most recently used first. */
    val endpoints: List<Endpoint>,
    /**
     * Which net this Mac belongs to.
     *
     * The membership — this phone's key pair and chain — lives in `NetStore`
     * under this id, because it is shared by every Mac in the net. Keeping a copy
     * per Mac is what the old per-Mac `secret` did, and it is the thing that made
     * a third device cost a third ceremony.
     */
    val netId: String,
) {
    /**
     * The order to try addresses in.
     *
     * Most-recently-successful first, because the address you used last is
     * overwhelmingly the one that still works; the rest are there so that
     * walking to another network costs a retry rather than a re-pairing.
     */
    val candidates: List<Endpoint> get() = endpoints

    /** Same Mac, now also reachable here. Never a second record. */
    fun reachableAt(endpoint: Endpoint): KnownMac {
        val rest = endpoints.filterNot { it.host == endpoint.host && it.port == endpoint.port }
        return copy(endpoints = listOf(endpoint) + rest)
    }

    fun toJson(): JSONObject = JSONObject()
        .put("pin", pin)
        .put("netId", netId)
        .put("endpoints", JSONArray().apply { endpoints.forEach { put(it.toJson()) } })

    companion object {
        fun fromJson(json: JSONObject): KnownMac {
            val list = json.optJSONArray("endpoints") ?: JSONArray()
            return KnownMac(
                pin = json.getString("pin"),
                endpoints = (0 until list.length()).map { Endpoint.fromJson(list.getJSONObject(it)) },
                netId = json.optString("netId", ""),
            )
        }
    }
}

/**
 * Where known Macs live.
 *
 * JSON in prefs rather than a column per field, because the shape is a list of
 * lists now — and the previous flat `host`/`port`/`pin` keys are what encoded
 * the "one address is one Mac" mistake into storage.
 */
class MacStore(context: Context) {
    private val prefs = context.getSharedPreferences("shepherd.v2", Context.MODE_PRIVATE)

    fun all(): List<KnownMac> {
        val raw = prefs.getString(KEY, null) ?: return dropLegacy()
        return runCatching {
            val list = JSONArray(raw)
            (0 until list.length()).map { KnownMac.fromJson(list.getJSONObject(it)) }
        }.getOrDefault(emptyList())
    }

    fun byPin(pin: String): KnownMac? = all().firstOrNull { it.pin.equals(pin, ignoreCase = true) }

    /** Insert or update, keyed by pin. Never appends a duplicate of one Mac. */
    fun put(mac: KnownMac) = write(listOf(mac) + all().filterNot { it.pin.equals(mac.pin, ignoreCase = true) })

    /**
     * The only writer, and it must not go through `put`.
     *
     * `all()` falls back to the legacy path when the key is absent, and that path
     * used `put`, which called `all()` again — on a phone with old flat keys it
     * recursed until the stack ran out, at the first frame, every launch. A write
     * path that re-enters the read path is the whole bug.
     */
    private fun write(macs: List<KnownMac>) {
        val json = JSONArray().apply { macs.forEach { put(it.toJson()) } }
        prefs.edit().putString(KEY, json.toString()).apply()
    }

    fun forget(pin: String) = write(all().filterNot { it.pin.equals(pin, ignoreCase = true) })

    fun forgetAll() = prefs.edit().remove(KEY).apply()

    /**
     * The old flat keys, dropped rather than lifted.
     *
     * A record from before shep-nets holds a `secret` the Mac issued and no key
     * pair — and a membership is a signature over a PUBLIC KEY, so there is
     * nothing to migrate: the credential cannot be minted from what was stored.
     * The Mac made the same call for the same reason and re-joins its devices
     * once. Carrying the secret forward would mean promoting a bearer token into
     * net membership, which is precisely what this design removed.
     */
    private fun dropLegacy(): List<KnownMac> {
        if (prefs.getString("host", null) == null) return emptyList()
        prefs.edit()
            .remove("host").remove("port").remove("dataPort").remove("pin").remove("secret")
            .remove("deviceId")
            .apply()
        return emptyList()
    }

    private companion object {
        const val KEY = "macs.v1"
    }
}
