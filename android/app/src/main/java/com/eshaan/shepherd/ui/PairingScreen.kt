package com.eshaan.shepherd.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.eshaan.shepherd.pairing.PairingState

@Composable
fun PairingScreen(vm: PairingViewModel, onPaired: () -> Unit) {
    val state by vm.state.collectAsState()
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("8722") }
    var code by remember { mutableStateOf("") }
    LaunchedEffect(state) { if (state is PairingState.Paired) onPaired() }
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Pair with a Shepherd host", style = MaterialTheme.typography.titleLarge)
        OutlinedTextField(host, { host = it }, label = { Text("Host (Tailscale 100.x or MagicDNS)") }, singleLine = true)
        OutlinedTextField(port, { port = it.filter(Char::isDigit) }, label = { Text("Port") }, singleLine = true)
        OutlinedTextField(code, { code = it.filter(Char::isDigit).take(4) }, label = { Text("Pairing code (4 digits)") }, singleLine = true)
        Button(onClick = { vm.pair(host.trim(), port.toIntOrNull() ?: 8722, code) },
            enabled = host.isNotBlank() && code.length == 4) { Text("Pair") }
        when (val s = state) {
            PairingState.Connecting -> Text("Connecting…")
            PairingState.WaitingApproval -> Text("Waiting for approval on the host…")
            is PairingState.Error -> Text("Failed: ${s.reason}", color = MaterialTheme.colorScheme.error)
            else -> {}
        }
    }
}
