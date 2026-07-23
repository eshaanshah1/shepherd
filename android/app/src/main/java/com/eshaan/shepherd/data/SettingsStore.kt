package com.eshaan.shepherd.data

import android.content.Context

/** App preferences (non-secret). One flag today: "sound alerts on silent". */
interface SettingsStore {
    var ignoreSilent: Boolean
}

class InMemorySettingsStore : SettingsStore {
    override var ignoreSilent: Boolean = false
}

class PrefsSettingsStore(context: Context) : SettingsStore {
    private val prefs = context.getSharedPreferences("shepherd_settings", Context.MODE_PRIVATE)
    override var ignoreSilent: Boolean
        get() = prefs.getBoolean(KEY_IGNORE_SILENT, false)
        set(value) { prefs.edit().putBoolean(KEY_IGNORE_SILENT, value).apply() }

    private companion object { const val KEY_IGNORE_SILENT = "ignore_silent" }
}
