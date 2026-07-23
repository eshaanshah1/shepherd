package com.eshaan.shepherd.fcm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.eshaan.shepherd.MainActivity

object Notifications {
    private const val CHANNEL = "agents"

    fun ensureChannel(context: Context) {
        val mgr = context.getSystemService(NotificationManager::class.java)
        if (mgr.getNotificationChannel(CHANNEL) == null)
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL, "Agent alerts", NotificationManager.IMPORTANCE_HIGH)
            )
    }

    fun post(context: Context, w: WakeContent) {
        ensureChannel(context)
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("paneID", w.paneId)
        }
        val pi = PendingIntent.getActivity(context, w.paneId.hashCode(), intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setContentTitle(w.title).setContentText(w.body)
            .setSmallIcon(com.eshaan.shepherd.R.drawable.ic_notification)
            .setColor(0xFF8D9578.toInt())
            .setPriority(if (w.urgent) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(pi).setAutoCancel(true).build()
        runCatching { NotificationManagerCompat.from(context).notify(w.paneId.hashCode(), n) }
    }
}
