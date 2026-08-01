package com.eshaan.shepherd.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject

/**
 * Every Mac this phone has paired with, encrypted at rest.
 *
 * Stored as one JSON array under `pairings` plus a `selected` host id. The previous shape was a
 * set of flat keys holding exactly one pairing, so a second Mac silently replaced the first;
 * [migrateLegacy] folds that single record into the list on first read, and only then clears it.
 */
class EncryptedPairingStore(context: Context) : PairingStore {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "shepherd_pairing",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    override fun load(): Pairing? {
        val all = loadAll()
        val sel = prefs.getString("selected", null)
        return all.firstOrNull { it.hostID == sel } ?: all.firstOrNull()
    }

    override fun loadAll(): List<Pairing> {
        migrateLegacy()
        val raw = prefs.getString("pairings", null) ?: return emptyList()
        return runCatching {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { decode(arr.getJSONObject(it)) }
        }.getOrDefault(emptyList())
    }

    override fun save(p: Pairing) {
        write(loadAll().upserting(p), selected = p.hostID)
    }

    override fun select(hostID: String) {
        if (loadAll().any { it.hostID == hostID }) prefs.edit().putString("selected", hostID).apply()
    }

    override fun forget(hostID: String) {
        val rest = loadAll().filterNot { it.hostID == hostID }
        val sel = prefs.getString("selected", null)
        write(rest, selected = if (sel == hostID) rest.firstOrNull()?.hostID else sel)
    }

    override fun clear() = prefs.edit().clear().apply()

    private fun write(all: List<Pairing>, selected: String?) {
        val arr = JSONArray()
        all.forEach { arr.put(encode(it)) }
        prefs.edit().putString("pairings", arr.toString())
            .putString("selected", selected).apply()
    }

    /** Fold a pre-list single pairing into the array, once. */
    private fun migrateLegacy() {
        val host = prefs.getString("host", null) ?: return
        if (prefs.getString("pairings", null) == null) {
            val legacy = Pairing(
                host, prefs.getInt("port", 8722), prefs.getString("deviceId", "")!!,
                prefs.getString("deviceName", "")!!, prefs.getString("secret", "")!!,
                prefs.getString("lanPin", null))
            write(listOf(legacy), selected = legacy.hostID)
        }
        // Only after the list exists — a crash between the two must not lose the pairing.
        prefs.edit().remove("host").remove("port").remove("deviceId")
            .remove("deviceName").remove("secret").remove("lanPin").apply()
    }

    private fun encode(p: Pairing) = JSONObject().apply {
        put("host", p.host); put("port", p.port)
        put("deviceId", p.deviceId); put("deviceName", p.deviceName)
        put("secret", p.secret)
        p.lanPin?.let { put("lanPin", it) }
    }

    private fun decode(o: JSONObject) = Pairing(
        host = o.getString("host"), port = o.getInt("port"),
        deviceId = o.optString("deviceId"), deviceName = o.optString("deviceName"),
        secret = o.optString("secret"),
        lanPin = if (o.has("lanPin")) o.getString("lanPin") else null)
}
