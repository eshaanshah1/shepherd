package com.eshaan.shepherd

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.ui.unit.IntOffset
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Surface
import com.eshaan.shepherd.ui.theme.ShepherdTheme
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.eshaan.shepherd.data.EncryptedPairingStore
import com.eshaan.shepherd.fcm.Notifications
import com.eshaan.shepherd.fcm.fcmToken
import com.eshaan.shepherd.transport.Pinning
import com.eshaan.shepherd.transport.RemoteConnection
import com.eshaan.shepherd.ui.AgentScreen
import com.eshaan.shepherd.ui.AgentViewModel
import com.eshaan.shepherd.ui.FleetScreen
import com.eshaan.shepherd.ui.FleetViewModel
import com.eshaan.shepherd.ui.NavTarget
import com.eshaan.shepherd.ui.PairingScreen
import com.eshaan.shepherd.ui.PairingViewModel
import com.eshaan.shepherd.v2.V2App
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {
    private val requestNotif =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    /** A pane id delivered via a notification tap; consumed once by the Fleet VM. */
    private val deepLinkPane = MutableStateFlow<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Notifications.ensureChannel(this)
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestNotif.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        intent?.getStringExtra("paneID")?.let { deepLinkPane.value = it }
        setContent {
            ShepherdTheme {
                Surface {
                    /**
                     * The v2 root.
                     *
                     * v1's Fleet/Agent/Pairing screens are still in the tree and
                     * are no longer reached: they speak the old wire protocol (a
                     * control connection plus a data connection per pane, each
                     * with its own message set) and the Mac no longer answers it.
                     * They are left in place rather than deleted in the same
                     * commit that adds their replacement, so this change stays
                     * reviewable — removing them is its own.
                     */
                    V2App(applicationContext, deviceName = android.os.Build.MODEL ?: "A phone")
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra("paneID")?.let { deepLinkPane.value = it }
    }

    // Foreground gate for push suppression: only skip a pane's banner while the app is actually
    // resumed (a still-attached-but-backgrounded session must NOT suppress — you'd miss it).
    override fun onResume() { super.onResume(); com.eshaan.shepherd.fcm.AppForeground.resumed = true }
    override fun onPause() { super.onPause(); com.eshaan.shepherd.fcm.AppForeground.resumed = false }
}
