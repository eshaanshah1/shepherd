package com.eshaan.shepherd.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.eshaan.shepherd.model.AgentState

private val ShepherdDarkColors = darkColorScheme(
    background        = Color(ShepherdPalette.ground),
    surface           = Color(ShepherdPalette.ground),
    surfaceContainer  = Color(ShepherdPalette.surface1),
    onBackground      = Color(ShepherdPalette.textPrimary),
    onSurface         = Color(ShepherdPalette.textPrimary),
    primary           = Color(0xFF5B9DF8),
    error             = Color(0xFFE5645D),
)

@Composable
fun ShepherdTheme(content: @Composable () -> Unit) =
    MaterialTheme(colorScheme = ShepherdDarkColors, typography = ShepherdTypography, content = content)

object ShepherdColors {
    fun dot(state: AgentState): Color = Color(ShepherdPalette.stateColorHex(state))
}
