package com.eshaan.shepherd.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class EncryptedPairingStore(context: Context) : PairingStore {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "shepherd_pairing",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
    override fun load(): Pairing? {
        val host = prefs.getString("host", null) ?: return null
        return Pairing(host, prefs.getInt("port", 8722), prefs.getString("deviceId", "")!!,
            prefs.getString("deviceName", "")!!, prefs.getString("secret", "")!!)
    }
    override fun save(p: Pairing) = prefs.edit()
        .putString("host", p.host).putInt("port", p.port).putString("deviceId", p.deviceId)
        .putString("deviceName", p.deviceName).putString("secret", p.secret).apply()
    override fun clear() = prefs.edit().clear().apply()
}
