package com.eshaan.shepherd.ui.theme

import androidx.compose.ui.graphics.Color
import com.eshaan.shepherd.model.AgentState

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
