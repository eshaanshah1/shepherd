package com.eshaan.shepherd.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.eshaan.shepherd.model.AgentState

/** App-wide dark theme with a true-black background so the terminal reads like a real terminal. */
private val ShepherdDarkColors = darkColorScheme(
    background = Color(0xFF000000),
    surface = Color(0xFF000000),
    surfaceContainer = Color(0xFF0A0A0A),
    onBackground = Color(0xFFE6E6E6),
    onSurface = Color(0xFFE6E6E6),
    primary = Color(0xFF8AB4F8),
)

@Composable
fun ShepherdTheme(content: @Composable () -> Unit) =
    MaterialTheme(colorScheme = ShepherdDarkColors, content = content)

object ShepherdColors {
    fun dot(state: AgentState): Color = when (state) {
        AgentState.WORKING -> Color(0xFFE0A458)
        AgentState.BLOCKED -> Color(0xFFE0683C)
        AgentState.NEEDS_CHECK -> Color(0xFF5B9BD5)
        AgentState.IDLE -> Color(0xFF6FBF8B)
        AgentState.ERROR -> Color(0xFFD9483B)
        AgentState.SHELL, AgentState.UNKNOWN -> Color(0xFF6B6B6B)
    }
}
