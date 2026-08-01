package com.eshaan.shepherd.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.eshaan.shepherd.data.Pairing
import com.eshaan.shepherd.data.PairingStore
import com.eshaan.shepherd.data.SettingsStore
import com.eshaan.shepherd.data.hostID
import com.eshaan.shepherd.ui.components.ShepherdTopBar
import com.eshaan.shepherd.ui.components.Tabler
import com.eshaan.shepherd.ui.components.TablerIcon
import com.eshaan.shepherd.ui.theme.ShepherdPalette

@Composable
fun SettingsScreen(
    settings: SettingsStore,
    pairings: PairingStore? = null,
    onSwitchHost: () -> Unit = {},
    onPairAnother: () -> Unit = {},
    onBack: () -> Unit,
) {
    var ignoreSilent by remember { mutableStateOf(settings.ignoreSilent) }
    var hosts by remember { mutableStateOf(pairings?.loadAll() ?: emptyList()) }
    var selected by remember { mutableStateOf(pairings?.load()?.hostID) }

    Column(Modifier.fillMaxSize().background(Color(ShepherdPalette.ground))) {
        ShepherdTopBar(title = "Settings", onBack = onBack)
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            SectionLabel("Alerts")
            ToggleRow(
                icon = Tabler.bell,
                title = "Sound alerts on silent",
                subtitle = "Play a chime through the alarm volume when an agent needs you — even if your phone is on silent or vibrate.",
                checked = ignoreSilent,
                onCheckedChange = { ignoreSilent = it; settings.ignoreSilent = it },
            )

            if (pairings != null) {
                Spacer(Modifier.height(6.dp))
                SectionLabel("Macs")
                hosts.forEach { p ->
                    HostRow(
                        pairing = p,
                        isSelected = p.hostID == selected,
                        onSelect = {
                            pairings.select(p.hostID)
                            selected = p.hostID
                            onSwitchHost()
                        },
                        onForget = {
                            pairings.forget(p.hostID)
                            hosts = pairings.loadAll()
                            selected = pairings.load()?.hostID
                            onSwitchHost()
                        },
                    )
                }
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                    .background(Color(ShepherdPalette.surface2)).padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Text("Pair another Mac", color = Color(ShepherdPalette.textPrimary),
                         style = MaterialTheme.typography.bodyMedium,
                         modifier = Modifier.weight(1f))
                    Text("Add", color = Color(ShepherdPalette.textPrimary),
                         style = MaterialTheme.typography.bodyMedium,
                         modifier = Modifier.clickable { onPairAnother() })
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(text.uppercase(), style = MaterialTheme.typography.labelSmall,
        color = Color(ShepherdPalette.textDim), modifier = Modifier.padding(4.dp, 4.dp, 0.dp, 2.dp))
}

@Composable
private fun ToggleRow(
    icon: List<String>,
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp))
            .background(Color(ShepherdPalette.surface1)).padding(16.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TablerIcon(icon, Color(ShepherdPalette.textSecondary), size = 22.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = Color(ShepherdPalette.textPrimary))
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = Color(ShepherdPalette.textDim))
        }
        Switch(
            checked = checked, onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color(0xFF0F0F11),
                checkedTrackColor = Color(0xFF5B9DF8),
                uncheckedThumbColor = Color(ShepherdPalette.textSecondary),
                uncheckedTrackColor = Color(ShepherdPalette.surface3),
                uncheckedBorderColor = Color(ShepherdPalette.hairline),
            ),
        )
    }
}


/** One paired Mac: tap to show it, Forget to drop it. */
@Composable
private fun HostRow(pairing: Pairing, isSelected: Boolean,
                    onSelect: () -> Unit, onForget: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
            .background(Color(ShepherdPalette.surface2))
            .clickable(enabled = !isSelected) { onSelect() }
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(pairing.host, color = Color(ShepherdPalette.textPrimary),
                 style = MaterialTheme.typography.bodyMedium)
            Text(
                buildString {
                    append(if (pairing.lanPin != null) "local network" else "tailnet")
                    if (isSelected) append(" · showing")
                },
                color = Color(ShepherdPalette.textDim),
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Text("Forget", color = Color(0xFFE5645D),
             style = MaterialTheme.typography.bodySmall,
             modifier = Modifier.clickable { onForget() })
    }
}
