package com.eshaan.shepherd.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.eshaan.shepherd.model.Inbox
import com.eshaan.shepherd.ui.components.*
import com.eshaan.shepherd.ui.theme.ShepherdPalette
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetScreen(vm: FleetViewModel) {
    val fleet by vm.fleet.collectAsState()
    val connected by vm.connected.collectAsState()
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { vm.connect() }
    // Clear the spinner once we reconnect (or after a short ceiling so it never hangs).
    LaunchedEffect(connected) { if (connected) refreshing = false }
    LaunchedEffect(refreshing) { if (refreshing) { delay(4000); refreshing = false } }

    val part = Inbox.partition(fleet.panes)
    val needCount = part.attention.size

    Column(Modifier.fillMaxSize().background(Color(ShepherdPalette.ground))) {
        ShepherdTopBar(title = "Agents", trailing = { ConnectionChip(connected, reconnecting = refreshing && !connected) })
        if (needCount > 0) {
            Text("$needCount need you", style = MaterialTheme.typography.bodySmall, color = Color(0xFFE5A23D),
                modifier = Modifier.padding(16.dp, 0.dp, 16.dp, 8.dp))
        }
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = { refreshing = true; vm.refresh() },
            modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                fleet.panes.isEmpty() && connected -> EmptyState()
                fleet.panes.isEmpty() -> SkeletonList()
                else -> LazyColumn(Modifier.fillMaxSize().navigationBarsPadding(),
                    contentPadding = PaddingValues(12.dp, 4.dp, 12.dp, 16.dp)) {
                    // Attention cards carry their own 8dp gap; thin rows stay dense (no gap).
                    items(part.attention, key = { it.paneId }) {
                        AttentionCard(it) { vm.openAgent(it.paneId) }
                        Spacer(Modifier.height(8.dp))
                    }
                    if (part.attention.isNotEmpty() && part.other.isNotEmpty()) item { Spacer(Modifier.height(8.dp)) }
                    items(part.other, key = { it.paneId }) { AgentRow(it) { vm.openAgent(it.paneId) } }
                }
            }
        }
    }
}

@Composable
private fun EmptyState() {
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally) {
        Text("No agents running", style = MaterialTheme.typography.titleMedium, color = Color(ShepherdPalette.textSecondary))
        Spacer(Modifier.height(6.dp))
        Text("Start `claude` in a Shepherd pane on your Mac — it'll show up here.",
            style = MaterialTheme.typography.bodyMedium, color = Color(ShepherdPalette.textDim), textAlign = TextAlign.Center)
    }
}

@Composable
private fun SkeletonList() {
    Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        repeat(4) {
            Box(Modifier.fillMaxWidth().height(64.dp)
                .background(Color(ShepherdPalette.surface1), androidx.compose.foundation.shape.RoundedCornerShape(14.dp)))
        }
    }
}
