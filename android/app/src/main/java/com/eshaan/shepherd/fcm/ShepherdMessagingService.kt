package com.eshaan.shepherd.fcm

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class ShepherdMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        FcmWake.parse(message.data)?.let { Notifications.post(this, it) }
    }

    // No onNewToken override: the live token is read fresh into every hello, so a rotated
    // token is reconciled on the next control connection (host: reconcile-on-known-device-reconnect).
}
