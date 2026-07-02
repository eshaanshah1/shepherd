package com.eshaan.shepherd.fcm

/**
 * Process-wide record of whether the app is foregrounded on a specific pane's Agent screen. An
 * incoming push for the pane you're actively viewing skips the banner — the live terminal already
 * shows it. FCM is still delivered and parsed (state pipeline intact); only the notification is
 * withheld. Set from [com.eshaan.shepherd.MainActivity] (resumed) + AgentScreen (visible pane).
 */
object AppForeground {
    @Volatile var resumed = false
    @Volatile var visiblePane: String? = null

    /** True iff the app is in the foreground AND its Agent screen is showing exactly [paneId]. */
    fun isViewing(paneId: String): Boolean = resumed && visiblePane == paneId
}
