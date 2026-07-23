package com.eshaan.shepherd.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.eshaan.shepherd.pairing.PairingState
import com.eshaan.shepherd.protocol.PairingPayload
import com.eshaan.shepherd.ui.components.PrimaryButton
import com.eshaan.shepherd.ui.theme.ShepherdPalette
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

    Column(
        Modifier.fillMaxSize().background(Color(ShepherdPalette.ground)).padding(28.dp),
        verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Shepherd", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold,
            color = Color(ShepherdPalette.textPrimary))
        Spacer(Modifier.height(10.dp))
        Text("Pair with a Shepherd host", style = MaterialTheme.typography.titleMedium,
            color = Color(ShepherdPalette.textSecondary), textAlign = TextAlign.Center)
        Spacer(Modifier.height(4.dp))
        Text("On the Mac: ⋯ menu → Connect a phone… → scan the QR.",
            style = MaterialTheme.typography.bodyMedium, color = Color(ShepherdPalette.textDim), textAlign = TextAlign.Center)
        Spacer(Modifier.height(24.dp))

        PrimaryButton("Scan QR to pair", {
            scanError = null
            scanLauncher.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setBeepEnabled(false).setPrompt("Scan the Shepherd QR").setOrientationLocked(false))
        }, Modifier.fillMaxWidth())

        scanError?.let { Spacer(Modifier.height(8.dp)); Text(it, color = Color(0xFFE5645D)) }

        Spacer(Modifier.height(12.dp))
        TextButton(onClick = { showManual = !showManual }) {
            Text(if (showManual) "Hide manual entry" else "Enter host manually",
                color = Color(ShepherdPalette.textSecondary))
        }
        if (showManual) {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp))
                .background(Color(ShepherdPalette.surface2)).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(host, { host = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    label = { Text("Host (Tailscale 100.x or MagicDNS)") })
                OutlinedTextField(port, { port = it.filter(Char::isDigit) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    label = { Text("Port") })
                PrimaryButton("Pair", { vm.pair(host.trim(), null, port.toIntOrNull() ?: 8722) },
                    Modifier.fillMaxWidth(), enabled = host.isNotBlank())
            }
        }

        Spacer(Modifier.height(16.dp))
        when (val s = state) {
            PairingState.Connecting -> StatusLine(Color(0xFFE5A23D), "Connecting…")
            PairingState.WaitingApproval -> StatusLine(Color(0xFFE5A23D), "Waiting for approval on the host…")
            is PairingState.Error -> StatusLine(Color(0xFFE5645D), "Failed: ${s.reason}")
            else -> {}
        }
    }
}

@Composable
private fun StatusLine(color: Color, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        CircularProgressIndicator(Modifier.size(16.dp), color = color, strokeWidth = 2.dp)
        Text(text, color = color, style = MaterialTheme.typography.bodyMedium)
    }
}
