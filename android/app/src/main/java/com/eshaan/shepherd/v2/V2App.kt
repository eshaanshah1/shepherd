package com.eshaan.shepherd.v2

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.eshaan.shepherd.ui.components.ShepherdTopBar
import com.eshaan.shepherd.ui.theme.ShepherdPalette
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.util.UUID

/**
 * The v2 app: pair with a Mac, browse whatever it contributes, open a terminal.
 *
 * Three screens and no fourth, because the Mac decides what there is to see. The
 * middle one draws contributed views rather than a fleet of panes, so this file
 * has no idea what a task is either.
 */

/** What this phone remembers about a Mac. Small enough to keep in prefs. */
data class Pairing(
    val host: String,
    val port: Int,
    val pin: String,
    val deviceId: String,
    val secret: String?,
)

class PairingPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("shepherd.v2", Context.MODE_PRIVATE)

    fun load(): Pairing? {
        val host = prefs.getString("host", null) ?: return null
        return Pairing(
            host = host,
            port = prefs.getInt("port", 0),
            pin = prefs.getString("pin", "") ?: "",
            // Minted once and kept: the Mac knows this phone by it, so a new id
            // each launch would mean pairing again every time.
            deviceId = prefs.getString("deviceId", null) ?: UUID.randomUUID().toString().also {
                prefs.edit().putString("deviceId", it).apply()
            },
            secret = prefs.getString("secret", null),
        )
    }

    fun save(pairing: Pairing) {
        prefs.edit()
            .putString("host", pairing.host)
            .putInt("port", pairing.port)
            .putString("pin", pairing.pin)
            .putString("deviceId", pairing.deviceId)
            .apply()
    }

    /** Stored separately: it arrives AFTER the Mac approves, not when we connect. */
    fun saveSecret(secret: String) {
        prefs.edit().putString("secret", secret).apply()
    }

    fun deviceId(): String =
        prefs.getString("deviceId", null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString("deviceId", it).apply()
        }

    fun forget() = prefs.edit().clear().apply()
}

@Composable
fun V2App(context: Context, deviceName: String) {
    val prefs = remember { PairingPrefs(context) }
    var pairing by remember { mutableStateOf(prefs.load()) }
    var session by remember { mutableStateOf<String?>(null) }

    val known = pairing
    if (known == null) {
        PairScreen { entered ->
            prefs.save(entered)
            pairing = entered
        }
        return
    }

    val scope = remember { CoroutineScope(SupervisorJob() + Dispatchers.IO) }
    val link = remember(known.host, known.port) {
        HostLink(known.host, known.port, known.pin, scope)
    }
    val state by link.state.collectAsState()

    DisposableEffect(link) {
        link.start(known.deviceId, deviceName, pairingCodeOnce, known.secret)
        onDispose { link.stop() }
    }

    // The Mac issues a secret on every admit, so a phone that lost one is not
    // stranded — but it is only worth storing once it actually arrives.
    (state as? HostLink.State.Ready)?.deviceSecret?.let { issued ->
        DisposableEffect(issued) {
            prefs.saveSecret(issued)
            onDispose { }
        }
    }

    when (val current = state) {
        is HostLink.State.Failed -> Message(
            "Cannot reach this Mac",
            current.reason + if (current.terminal) "" else " — retrying",
        ) { prefs.forget(); pairing = null }
        is HostLink.State.PendingApproval ->
            Message("Waiting for approval", "Approve this phone on the Mac.", null)
        is HostLink.State.Ready -> {
            val open = session
            if (open == null) {
                val model = remember(link) { BrowseViewModel(link, scope) }
                Column(Modifier.fillMaxSize()) {
                    ShepherdTopBar(title = "Shepherd", onBack = null)
                    BrowseScreen(model) { session = it }
                }
            } else {
                TerminalScreen(open, link, scope) { session = null }
            }
        }
        else -> Message("Connecting", known.host, null)
    }
}

/**
 * First contact: the facts a Mac's pairing payload carries.
 *
 * Typed rather than scanned, for now. The payload is `host`, `port`, `pin` and a
 * six-digit code — the same four fields a QR would encode — so a scanner is a
 * nicer way in rather than a different one.
 */
@Composable
private fun PairScreen(onPaired: (Pairing) -> Unit) {
    var host by remember { mutableStateOf("127.0.0.1") }
    var port by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }

    Column(
        Modifier.fillMaxSize().background(Color(ShepherdPalette.ground)).padding(24.dp),
        verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
    ) {
        Text("Pair with a Mac", color = Color(ShepherdPalette.textPrimary), fontSize = 20.sp)
        Text(
            // Loopback is what the Mac serves today, so a USB reverse-forward is
            // the way in until a LAN transport extension exists.
            "adb reverse tcp:PORT tcp:PORT, then use 127.0.0.1",
            color = Color(ShepherdPalette.textDim),
            fontSize = 12.sp,
            modifier = Modifier.padding(top = 4.dp, bottom = 16.dp),
        )
        Field("Host", host) { host = it }
        Field("Port", port, numeric = true) { port = it }
        Field("Certificate pin", pin) { pin = it.trim() }
        Field("Pairing code", code, numeric = true) { code = it }
        Button(
            onClick = {
                pairingCodeOnce = code.ifBlank { null }
                onPaired(
                    Pairing(
                        host = host.trim(),
                        port = port.toIntOrNull() ?: 0,
                        pin = pin.trim(),
                        deviceId = UUID.randomUUID().toString(),
                        secret = null,
                    ),
                )
            },
            enabled = host.isNotBlank() && port.toIntOrNull() != null && pin.length == 64,
            modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
        ) { Text("Pair") }
    }
}

/**
 * The code, for exactly one connection attempt.
 *
 * It is not stored: a pairing code authorizes ONE first contact and the secret
 * is what a returning phone presents. Keeping it would be keeping a credential
 * that is already spent.
 */
private var pairingCodeOnce: String? = null

@Composable
private fun Field(label: String, value: String, numeric: Boolean = false, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        singleLine = true,
        keyboardOptions = if (numeric) KeyboardOptions(keyboardType = KeyboardType.Number) else KeyboardOptions.Default,
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    )
}

@Composable
private fun Message(title: String, detail: String, onForget: (() -> Unit)?) {
    Box(
        Modifier.fillMaxSize().background(Color(ShepherdPalette.ground)),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(title, color = Color(ShepherdPalette.textPrimary), fontSize = 16.sp)
            Text(
                detail,
                color = Color(ShepherdPalette.textDim),
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 6.dp),
            )
            onForget?.let {
                Button(onClick = it, modifier = Modifier.padding(top = 16.dp)) { Text("Forget this Mac") }
            }
        }
    }
}
