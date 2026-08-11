package com.eshaan.shepherd.v2

import android.content.Context
import androidx.activity.compose.rememberLauncherForActivityResult
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
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
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
    val nets = remember { NetStore(context) }
    var mac by remember { mutableStateOf(macs.all().firstOrNull()) }
    var session by remember { mutableStateOf<String?>(null) }

    val known = mac
    if (known == null) {
        JoinScreen { facts ->
            // The link is the whole first contact: it carries the net, the root
            // key, the address and the code. Kept until the accept, because the
            // membership is issued against the key minted for this attempt.
            joiningOnce = facts
            val entered = KnownMac(
                pin = facts.pin,
                endpoints = listOf(Endpoint(facts.host, facts.port, facts.dataPort, via = "link")),
                netId = facts.netId,
            )
            macs.put(entered)
            mac = entered
        }
        return
    }

    /**
     * The membership for this Mac's net — the phone's identity, shared by every
     * Mac in it.
     *
     * Null while joining, which is exactly the state the code is for.
     */
    var membership by remember(known.netId) { mutableStateOf(nets.byNet(known.netId)) }
    val deviceId = remember { nets.deviceId() }

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

    DisposableEffect(link, membership) {
        link.start(deviceId, deviceName, joiningOnce, membership)
        onDispose { link.stop() }
    }

    /**
     * The data link waits for a membership, and says so when it cannot start.
     *
     * It cannot join — it can only present — so before this phone is in the net
     * there is nothing for it to do. The daemon shows no code, which is exactly
     * what makes serving ptys from a headless process safe. Getting this wrong is
     * invisible: the task list works, a row opens a terminal, and the terminal
     * paints nothing because the second connection was never dialled.
     */
    DisposableEffect(dataLink, membership) {
        val held = membership
        if (dataLink != null && held != null) {
            dataLink.start(deviceId, deviceName, null, held)
        } else {
            SLog.i(
                SLog.DATA,
                "data link idle — ${if (dataLink == null) "no data port" else "not in the net yet"}",
            )
        }
        onDispose { dataLink?.stop() }
    }

    /**
     * Everything the Mac tells us, folded back into storage.
     *
     * The membership and the data port both arrive on admit, and BOTH have to
     * reach state rather than only storage: the data link starts only once a
     * membership exists, so writing to prefs alone left it null for the whole
     * session — a terminal that paints nothing, with no error, because nothing
     * had failed. And a port is the host's to choose, so a cached one dials a
     * daemon that moved.
     */
    LaunchedEffect(state, known.pin) {
        val ready = state as? HostLink.State.Ready ?: return@LaunchedEffect
        ready.issued?.let { joined ->
            nets.put(joined)
            membership = joined
            // Spent: a code authorizes ONE first contact, and this phone is now
            // a member. Keeping it would be keeping a credential already used.
            joiningOnce = null
            if (known.netId != joined.netId) {
                val moved = known.copy(netId = joined.netId)
                macs.put(moved)
                mac = moved
            }
        }
        val reachedAt = endpoint.copy(dataPort = ready.dataPort ?: endpoint.dataPort)
        // Promoted to the front: the address that just worked is overwhelmingly
        // the one that will work next time.
        val updated = (mac ?: known).reachableAt(reachedAt)
        if (updated != mac) {
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
 * First contact: one link, scanned or pasted.
 *
 * The Mac's `remote.pair` hands back a `shepherd://join?…` URI and the same URI
 * as a QR block. That link carries the net, its root key, the address, the
 * certificate pin and the six-digit code — five fields nobody would retype, one
 * of which is 88 hex characters. So there is no typed form here any more: a
 * camera or a paste, and the parser refuses anything it cannot fully act on
 * rather than starting a join that fails somewhere the user cannot see.
 */
@Composable
private fun JoinScreen(onJoining: (JoinFacts) -> Unit) {
    var pasted by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }

    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents ?: return@rememberLauncherForActivityResult // cancelled
        val facts = JoinLink.parse(contents)
        if (facts == null) {
            problem = "That QR is not a Shepherd join link for this version."
        } else {
            problem = null
            onJoining(facts)
        }
    }

    Column(
        Modifier.fillMaxSize().background(Color(ShepherdPalette.ground)).padding(24.dp),
        verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
    ) {
        Text("Join a shep-net", color = Color(ShepherdPalette.textPrimary), fontSize = 20.sp)
        Text(
            "On the Mac, run  shepherd raw remote.pair  and scan the QR it prints.",
            color = Color(ShepherdPalette.textDim),
            fontSize = 12.sp,
            modifier = Modifier.padding(top = 4.dp, bottom = 16.dp),
        )
        Button(
            onClick = {
                problem = null
                scanner.launch(
                    ScanOptions()
                        .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                        .setBeepEnabled(false)
                        .setPrompt("Scan the Mac's join QR"),
                )
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Scan the QR") }

        Text(
            "…or paste the link",
            color = Color(ShepherdPalette.textDim),
            fontSize = 12.sp,
            modifier = Modifier.padding(top = 20.dp, bottom = 4.dp),
        )
        Field("shepherd://join?…", pasted) { pasted = it }
        problem?.let {
            Text(it, color = Color(ShepherdPalette.textPrimary), fontSize = 12.sp)
        }
        Button(
            onClick = {
                val facts = JoinLink.parse(pasted)
                if (facts == null) {
                    // Named rather than shrugged at: a link that is merely
                    // truncated looks exactly like one for another net.
                    problem = "That is not a join link this app can use."
                } else {
                    problem = null
                    onJoining(facts)
                }
            },
            enabled = pasted.isNotBlank(),
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        ) { Text("Join") }
    }
}

/**
 * The join link, for exactly one connection attempt.
 *
 * It is not stored: the code inside it authorizes ONE first contact, and after
 * that the membership is what this phone presents. Keeping it would be keeping a
 * credential that is already spent.
 */
private var joiningOnce: JoinFacts? = null

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
