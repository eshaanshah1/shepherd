package com.eshaan.shepherd

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Surface
import com.eshaan.shepherd.ui.theme.ShepherdTheme
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.eshaan.shepherd.data.EncryptedPairingStore
import com.eshaan.shepherd.fcm.Notifications
import com.eshaan.shepherd.fcm.fcmToken
import com.eshaan.shepherd.transport.RemoteConnection
import com.eshaan.shepherd.ui.AgentScreen
import com.eshaan.shepherd.ui.AgentViewModel
import com.eshaan.shepherd.ui.FleetScreen
import com.eshaan.shepherd.ui.FleetViewModel
import com.eshaan.shepherd.ui.NavTarget
import com.eshaan.shepherd.ui.PairingScreen
import com.eshaan.shepherd.ui.PairingViewModel
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
                    val store = remember { EncryptedPairingStore(applicationContext) }
                    var paired by remember { mutableStateOf(store.load() != null) }
                    if (!paired) {
                        val pvm = remember { PairingViewModel(store, fcmToken = { fcmToken() }) }
                        PairingScreen(pvm) { paired = true }
                    } else {
                        val fvm = remember {
                            FleetViewModel(store, fcmToken = { fcmToken() },
                                connectionFactory = { scope, hello ->
                                    store.load()?.let { RemoteConnection(it.host, it.port, hello, scope) }
                                })
                        }
                        val nav by fvm.navTarget.collectAsState()
                        val pending by deepLinkPane.collectAsState()
                        // A notification tap → open that pane once the intent's paneID lands.
                        androidx.compose.runtime.LaunchedEffect(pending) {
                            pending?.let { fvm.openAgent(it); deepLinkPane.value = null }
                        }
                        when (val target = nav) {
                            is NavTarget.Agent -> {
                                val conn = fvm.activeConnection
                                val host = fvm.host; val port = fvm.port
                                if (conn != null && host != null && port != null) {
                                    val avm = remember(target.paneId) {
                                        AgentViewModel(target.paneId, host, port, conn)
                                    }
                                    AgentScreen(avm) { fvm.consumeNavTarget() }
                                } else {
                                    // No live connection yet — fall back to the Fleet list.
                                    fvm.consumeNavTarget(); FleetScreen(fvm)
                                }
                            }
                            null -> FleetScreen(fvm)
                        }
                    }
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
