package com.eshaan.shepherd.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.eshaan.shepherd.pairing.PairingState
import com.eshaan.shepherd.protocol.PairingPayload
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

@Composable
fun PairingScreen(vm: PairingViewModel, onPaired: () -> Unit) {
    val state by vm.state.collectAsState()
    var showManual by remember { mutableStateOf(false) }
    var scanError by remember { mutableStateOf<String?>(null) }
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("8722") }
    LaunchedEffect(state) { if (state is PairingState.Paired) onPaired() }

    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents ?: return@rememberLauncherForActivityResult   // cancelled
        val p = PairingPayload.parse(contents)
        if (p == null) scanError = "That QR isn't a Shepherd pairing code."
        else { scanError = null; vm.pair(p.host ?: "", p.ip, p.port) }
    }

    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Pair with a Shepherd host", style = MaterialTheme.typography.titleLarge)
        Text("On the Mac: ⋯ menu → Connect a phone… → scan the QR.",
            style = MaterialTheme.typography.bodyMedium)
        Button(onClick = {
            scanError = null
            scanLauncher.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setBeepEnabled(false).setPrompt("Scan the Shepherd QR").setOrientationLocked(false))
        }) { Text("Scan QR to pair") }

        scanError?.let { Text(it, color = MaterialTheme.colorScheme.error) }

        TextButton(onClick = { showManual = !showManual }) {
            Text(if (showManual) "Hide manual entry" else "Enter host manually")
        }
        if (showManual) {
            OutlinedTextField(host, { host = it }, singleLine = true,
                label = { Text("Host (Tailscale 100.x or MagicDNS)") })
            OutlinedTextField(port, { port = it.filter(Char::isDigit) }, singleLine = true,
                label = { Text("Port") })
            Button(onClick = { vm.pair(host.trim(), null, port.toIntOrNull() ?: 8722) },
                enabled = host.isNotBlank()) { Text("Pair") }
        }

        when (val s = state) {
            PairingState.Connecting -> Text("Connecting…")
            PairingState.WaitingApproval -> Text("Waiting for approval on the host…")
            is PairingState.Error -> Text("Failed: ${s.reason}", color = MaterialTheme.colorScheme.error)
            else -> {}
        }
    }
}
