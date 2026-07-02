package com.eshaan.shepherd.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.eshaan.shepherd.model.AgentState
import com.eshaan.shepherd.protocol.PaneInfo
import com.eshaan.shepherd.ui.theme.ShepherdColors

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetScreen(vm: FleetViewModel) {
    val fleet by vm.fleet.collectAsState()
    val connected by vm.connected.collectAsState()
    LaunchedEffect(Unit) { vm.connect() }
    Scaffold(topBar = {
        TopAppBar(title = { Text(if (connected) "Agents" else "Agents (offline)") },
            actions = { TextButton(onClick = { vm.refresh() }) { Text("Refresh") } })
    }) { pad ->
        LazyColumn(Modifier.padding(pad).fillMaxSize()) {
            fleet.byWorkspace().forEach { (ws, panes) ->
                item { Text(ws, Modifier.padding(16.dp, 12.dp, 16.dp, 4.dp), style = MaterialTheme.typography.labelLarge) }
                items(panes, key = { it.paneId }) { PaneRow(it) { vm.openAgent(it.paneId) } }
            }
        }
    }
}

@Composable
private fun PaneRow(p: PaneInfo, onClick: () -> Unit) {
    val state = AgentState.fromRaw(p.state)
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp, 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(10.dp).clip(CircleShape).background(ShepherdColors.dot(state)))
        Spacer(Modifier.width(12.dp))
        Column {
            Text(p.title, style = MaterialTheme.typography.bodyLarge)
            val sub = p.reason ?: p.state
            Text(sub, style = MaterialTheme.typography.bodySmall)
        }
    }
}
