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
                        // Reconnect whenever the app comes to the foreground: a backgrounded socket
                        // often dies (Doze) and the backoff loop can be mid-delay, so without this you
                        // open the app to a stale "offline" until a manual pull-to-refresh. addObserver
                        // syncs the observer to the current state, so ON_START also fires on first
                        // registration — this is the initial connect too.
                        val lifecycleOwner = LocalLifecycleOwner.current
                        DisposableEffect(lifecycleOwner, fvm) {
                            val obs = LifecycleEventObserver { _, event ->
                                if (event == Lifecycle.Event.ON_START) fvm.refresh()
                            }
                            lifecycleOwner.lifecycle.addObserver(obs)
                            onDispose { lifecycleOwner.lifecycle.removeObserver(obs) }
                        }
                        val nav by fvm.navTarget.collectAsState()
                        val fleet by fvm.fleet.collectAsState()
                        val pending by deepLinkPane.collectAsState()
                        // A notification tap → open that pane once the intent's paneID lands.
                        androidx.compose.runtime.LaunchedEffect(pending) {
                            pending?.let { fvm.openAgent(it); deepLinkPane.value = null }
                        }
                        // iOS-style push: opening a chat slides the Agent in from the right over the
                        // Fleet, which parallax-drifts left + dims; back reverses it. Detail stays on
                        // top (higher z) so it rides over the list both ways.
                        AnimatedContent(
                            targetState = nav,
                            transitionSpec = {
                                val opening = targetState is NavTarget.Agent
                                val slide = tween<IntOffset>(300, easing = FastOutSlowInEasing)
                                val fade = tween<Float>(300)
                                val spec = if (opening) {
                                    slideInHorizontally(slide) { it } togetherWith
                                        (slideOutHorizontally(slide) { -it / 4 } + fadeOut(fade, 0.7f))
                                } else {
                                    (slideInHorizontally(slide) { -it / 4 } + fadeIn(fade, 0.7f)) togetherWith
                                        slideOutHorizontally(slide) { it }
                                }
                                spec.apply { targetContentZIndex = if (opening) 1f else 0f }
                            },
                            label = "nav",
                        ) { target ->
                            when (target) {
                                is NavTarget.Agent -> {
                                    val conn = fvm.activeConnection
                                    val host = fvm.host; val port = fvm.port
                                    if (conn != null && host != null && port != null) {
                                        val avm = remember(target.paneId) {
                                            AgentViewModel(target.paneId, host, port, conn)
                                        }
                                        val title = fleet.pane(target.paneId)?.title ?: ""
                                        AgentScreen(avm, title) { fvm.consumeNavTarget() }
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
