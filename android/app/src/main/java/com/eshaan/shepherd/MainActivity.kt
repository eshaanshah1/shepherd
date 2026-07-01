package com.eshaan.shepherd

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.eshaan.shepherd.data.EncryptedPairingStore
import com.eshaan.shepherd.fcm.Notifications
import com.eshaan.shepherd.fcm.fcmToken
import com.eshaan.shepherd.transport.RemoteConnection
import com.eshaan.shepherd.ui.FleetScreen
import com.eshaan.shepherd.ui.FleetViewModel
import com.eshaan.shepherd.ui.PairingScreen
import com.eshaan.shepherd.ui.PairingViewModel

class MainActivity : ComponentActivity() {
    private val requestNotif =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Notifications.ensureChannel(this)
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestNotif.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        setContent {
            MaterialTheme {
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
                        FleetScreen(fvm)
                    }
                }
            }
        }
    }
}
