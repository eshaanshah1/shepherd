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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
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
import com.eshaan.shepherd.util.SLog
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import java.util.UUID

/**
 * The v2 app: pair with a Mac, browse whatever it contributes, open a terminal.
 *
 * Three screens and no fourth, because the Mac decides what there is to see. The
 * middle one draws contributed views rather than a fleet of panes, so this file
 * has no idea what a task is either.
 */

@Composable
fun V2App(context: Context, deviceName: String) {
    val macs = remember { MacStore(context) }
    var mac by remember { mutableStateOf(macs.all().firstOrNull()) }
    var session by remember { mutableStateOf<String?>(null) }

    val known = mac
    if (known == null) {
        PairScreen { entered, code ->
            pairingCodeOnce = code
            macs.put(entered)
            mac = entered
        }
        return
    }

    /**
     * Which address we are currently trying.
     *
     * A Mac has several and they all point at the same machine — the pin says
     * so. Walking to another network changes which one answers, and that must
     * cost a retry rather than a re-pairing, which is what an address-keyed
     * record made it cost.
     */
    var attempt by remember(known.pin) { mutableIntStateOf(0) }
    val endpoint = known.candidates.getOrNull(attempt % known.candidates.size.coerceAtLeast(1))
    if (endpoint == null) {
        Message("No address for this Mac", "Pair again to give it one.") {
            macs.forget(known.pin)
            mac = null
        }
        return
    }

    val scope = remember { CoroutineScope(SupervisorJob() + Dispatchers.IO) }
    val link = remember(known.pin, endpoint.host, endpoint.port) {
        HostLink(endpoint.host, endpoint.port, known.pin, scope)
    }
    /**
     * The data link, to the daemon.
     *
     * Same certificate, same secret, second connection. It never needs a code:
     * the daemon shows none, so it can only admit a device the app already
     * approved — which is exactly what makes serving ptys from a headless
     * process safe.
     */
    val dataLink = remember(known.pin, endpoint.host, endpoint.dataPort) {
        if (endpoint.dataPort > 0) {
            HostLink(endpoint.host, endpoint.dataPort, known.pin, scope, speaksSessions = true)
        } else {
            null
        }
    }
    val state by link.state.collectAsState()

    DisposableEffect(link) {
        link.start(known.deviceId, deviceName, pairingCodeOnce, known.secret)
        onDispose { link.stop() }
    }

    /**
     * The data link waits for a secret, and says so when it cannot start.
     *
     * It cannot pair — it can only present — so before the app has approved this
     * phone there is nothing for it to do. Getting this wrong is invisible: the
     * task list works, a row opens a terminal, and the terminal paints nothing
     * because the second connection was never dialled.
     */
    DisposableEffect(dataLink, known.secret) {
        val secret = known.secret
        if (dataLink != null && secret != null) {
            dataLink.start(known.deviceId, deviceName, null, secret)
        } else {
            SLog.i(
                SLog.DATA,
                "data link idle — ${if (dataLink == null) "no data port" else "no secret yet"}",
            )
        }
        onDispose { dataLink?.stop() }
    }

    /**
     * Everything the Mac tells us about itself, folded back into the record.
     *
     * The secret and the data port both arrive on admit, and BOTH have to reach
     * state rather than just storage: the data link starts only once a secret
     * exists, so writing to prefs alone left it null for the whole session — a
     * terminal that paints nothing, with no error, because nothing had failed.
     * And a port is the host's to choose, so a cached one dials a daemon that
     * moved.
     */
    LaunchedEffect(state, known.pin) {
        val ready = state as? HostLink.State.Ready ?: return@LaunchedEffect
        val reachedAt = endpoint.copy(dataPort = ready.dataPort ?: endpoint.dataPort)
        val updated = known
            .copy(secret = ready.deviceSecret ?: known.secret)
            // Promoted to the front: the address that just worked is
            // overwhelmingly the one that will work next time.
            .reachableAt(reachedAt)
        if (updated != known) {
            macs.put(updated)
            mac = updated
        }
    }

    /**
     * A non-terminal failure moves to the NEXT address rather than retrying this
     * one forever.
     *
     * `HostLink` already retries a single address with backoff, which is right
     * for a socket that dropped. It is wrong for a Mac that moved: the address
     * is simply gone, and the one that answers is another entry on this record.
     */
    LaunchedEffect(state, attempt) {
        val failed = state as? HostLink.State.Failed ?: return@LaunchedEffect
        if (failed.terminal) return@LaunchedEffect
        if (known.candidates.size <= 1) return@LaunchedEffect
        delay(ADDRESS_RETRY_MS)
        SLog.i(SLog.CONN, "no answer at ${endpoint.host}:${endpoint.port} — trying the next address")
        attempt += 1
    }

    when (val current = state) {
        is HostLink.State.Failed -> Message(
            "Cannot reach this Mac",
            current.reason + if (current.terminal) "" else " — retrying",
        ) { macs.forget(known.pin); mac = null }
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
            } else if (dataLink != null) {
                TerminalScreen(open, dataLink, scope) { session = null }
            } else {
                // Said plainly rather than shown as a terminal that never
                // paints: without a data port this phone can browse but not
                // open anything.
                Message("No terminal path", "This Mac did not report a data port.") { session = null }
            }
        }
        else -> Message("Connecting", endpoint.host, null)
    }
}

/** Long enough that a slow network is not mistaken for the wrong address. */
private const val ADDRESS_RETRY_MS = 4_000L

/**
 * First contact: the facts a Mac's pairing payload carries.
 *
 * Typed rather than scanned, for now. The payload is `host`, `port`, `pin` and a
 * six-digit code — the same four fields a QR would encode — so a scanner is a
 * nicer way in rather than a different one.
 */
@Composable
private fun PairScreen(onPaired: (KnownMac, String?) -> Unit) {
    var host by remember { mutableStateOf("127.0.0.1") }
    var port by remember { mutableStateOf("") }
    var dataPort by remember { mutableStateOf("") }
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
            "The Mac's address on this network, or 127.0.0.1 over a USB forward",
            color = Color(ShepherdPalette.textDim),
            fontSize = 12.sp,
            modifier = Modifier.padding(top = 4.dp, bottom = 16.dp),
        )
        Field("Host", host) { host = it }
        Field("Port", port, numeric = true) { port = it }
        Field("Data port", dataPort, numeric = true) { dataPort = it }
        Field("Certificate pin", pin) { pin = it.trim() }
        Field("Pairing code", code, numeric = true) { code = it }
        Button(
            onClick = {
                onPaired(
                    KnownMac(
                        pin = pin.trim(),
                        endpoints = listOf(
                            Endpoint(
                                host = host.trim(),
                                port = port.toIntOrNull() ?: 0,
                                dataPort = dataPort.toIntOrNull() ?: 0,
                            ),
                        ),
                        deviceId = UUID.randomUUID().toString(),
                        secret = null,
                    ),
                    code.ifBlank { null },
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
private fun Message(title: String, detail: String, onForget: (() -> Unit)? = null) {
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
