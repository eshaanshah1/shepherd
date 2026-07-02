package com.eshaan.shepherd.fcm

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class ShepherdMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        // Always parse (keeps the state/wake pipeline intact), but skip the banner for the pane the
        // user is actively viewing in the foreground — the live terminal already shows it.
        FcmWake.parse(message.data)?.let { wake ->
            if (!AppForeground.isViewing(wake.paneId)) Notifications.post(this, wake)
        }
    }

    // No onNewToken override: the live token is read fresh into every hello, so a rotated
    // token is reconciled on the next control connection (host: reconcile-on-known-device-reconnect).
}
