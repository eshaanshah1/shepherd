package com.eshaan.shepherd.ui.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.eshaan.shepherd.model.AgentState
import com.eshaan.shepherd.model.cleanPaneTitle
import com.eshaan.shepherd.protocol.PaneInfo
import com.eshaan.shepherd.ui.theme.ShepherdColors
import com.eshaan.shepherd.ui.theme.ShepherdPalette

@Composable
fun StateDot(state: AgentState, size: Dp = 10.dp, pulse: Boolean = false) {
    val a = if (pulse && state == AgentState.WORKING) {
        val t = rememberInfiniteTransition(label = "pulse")
        t.animateFloat(0.45f, 1f,
            infiniteRepeatable(tween(1100, easing = FastOutSlowInEasing), RepeatMode.Reverse),
            label = "pulseAlpha").value
    } else 1f
    Box(Modifier.size(size).alpha(a).clip(CircleShape).background(ShepherdColors.dot(state)))
}

@Composable
fun StatusPill(state: AgentState, label: String) {
    Row(
        Modifier.clip(RoundedCornerShape(999.dp)).background(Color(ShepherdPalette.surface2))
            .padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        StateDot(state, 8.dp)
        Text(label, style = MaterialTheme.typography.labelLarge, color = Color(ShepherdPalette.textPrimary))
    }
}

@Composable
fun ConnectionChip(connected: Boolean, reconnecting: Boolean) {
    val (color, label) = when {
        connected -> Color(0xFF43C988) to "Connected"
        reconnecting -> Color(0xFFE5A23D) to "Reconnecting…"
        else -> Color(0xFF5F5F66) to "Offline"
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(color))
        Text(label, style = MaterialTheme.typography.bodySmall, color = Color(ShepherdPalette.textSecondary))
    }
}

@Composable
fun ShepherdTopBar(title: String, onBack: (() -> Unit)? = null, trailing: @Composable RowScope.() -> Unit = {}) {
    Row(
        Modifier.fillMaxWidth().background(Color(ShepherdPalette.surface1)).statusBarsPadding().padding(16.dp, 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            Text("‹", style = MaterialTheme.typography.titleLarge, color = Color(ShepherdPalette.textSecondary),
                modifier = Modifier.clip(CircleShape).clickable(onClick = onBack).padding(horizontal = 10.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(title, style = MaterialTheme.typography.titleLarge, color = Color(ShepherdPalette.textPrimary),
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(12.dp))
        trailing()
    }
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(
        onClick = onClick, enabled = enabled, modifier = modifier,
        shape = RoundedCornerShape(10.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = Color(0xFF5B9DF8), contentColor = Color(0xFF0F0F11),
            disabledContainerColor = Color(ShepherdPalette.surface3), disabledContentColor = Color(ShepherdPalette.textDim)),
    ) { Text(text, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold) }
}

@Composable
fun KeyPill(label: String, onClick: () -> Unit) {
    KeyPillBox(onClick) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = Color(ShepherdPalette.textPrimary))
    }
}

/** Icon variant — renders a Tabler glyph (e.g. return) instead of a text label. */
@Composable
fun KeyPill(icon: List<String>, onClick: () -> Unit) {
    KeyPillBox(onClick) { TablerIcon(icon, Color(ShepherdPalette.textPrimary), size = 17.dp) }
}

@Composable
private fun KeyPillBox(onClick: () -> Unit, content: @Composable () -> Unit) {
    Box(
        Modifier.clip(RoundedCornerShape(8.dp)).background(Color(ShepherdPalette.surface2))
            .clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) { content() }
}

@Composable
fun AttentionCard(p: PaneInfo, onClick: () -> Unit) {
    val state = AgentState.fromRaw(p.state)
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Color(ShepherdPalette.surface1))
            .clickable(onClick = onClick).padding(16.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        StateDot(state, 12.dp, pulse = false)
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(cleanPaneTitle(p.title), style = MaterialTheme.typography.bodyLarge, color = Color(ShepherdPalette.textPrimary))
            Text(p.workspace, style = MaterialTheme.typography.bodySmall, color = Color(ShepherdPalette.textDim))
            Text(p.reason ?: p.state, style = MaterialTheme.typography.bodyMedium,
                color = ShepherdColors.dot(state))
        }
    }
}

@Composable
fun AgentRow(p: PaneInfo, onClick: () -> Unit) {
    val state = AgentState.fromRaw(p.state)
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        StateDot(state, 7.dp, pulse = true)
        Text(cleanPaneTitle(p.title), style = MaterialTheme.typography.bodyMedium, color = Color(ShepherdPalette.textPrimary),
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text(p.workspace, style = MaterialTheme.typography.labelSmall, color = Color(ShepherdPalette.textDim), maxLines = 1)
        Text("›", style = MaterialTheme.typography.bodyMedium, color = Color(ShepherdPalette.textDim))
    }
}

@Composable
fun OptionCard(label: String, selected: Boolean, multi: Boolean, onClick: () -> Unit) {
    val bg = if (selected) Color(0x225B9DF8) else Color(ShepherdPalette.surface2)
    val bar = if (selected) Color(0xFF5B9DF8) else Color.Transparent
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(bg)
            .clickable(onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(4.dp).height(52.dp).background(bar))
        Text(label, style = MaterialTheme.typography.bodyLarge, color = Color(ShepherdPalette.textPrimary),
            modifier = Modifier.weight(1f).padding(14.dp))
        if (selected) Text(if (multi) "☑" else "✓", color = Color(0xFF5B9DF8),
            modifier = Modifier.padding(end = 14.dp), style = MaterialTheme.typography.titleMedium)
    }
}
