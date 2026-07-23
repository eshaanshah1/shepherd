package com.eshaan.shepherd.ui.theme

import com.eshaan.shepherd.model.AgentState

/** Authoritative dark palette, ported verbatim from the Mac Theme.swift dark tokens.
 *  Surfaces separate by tint (no borders/shadows). ARGB Longs (0xAARRGGBB). */
object ShepherdPalette {
    const val ground        = 0xFF0F0F11L
    const val surface1      = 0xFF141417L
    const val surface2      = 0xFF1A1A1EL
    const val surface3      = 0xFF212127L
    const val hairline      = 0xFF232327L
    const val textPrimary   = 0xFFEDEDEDL
    const val textSecondary = 0xFF8C8C92L
    const val textDim       = 0xFF5F5F66L

    fun stateColorHex(state: AgentState): Long = when (state) {
        AgentState.WORKING     -> 0xFF5B9DF8L
        AgentState.NEEDS_CHECK -> 0xFF43C988L
        AgentState.BLOCKED     -> 0xFFE5A23DL
        AgentState.ERROR       -> 0xFFE5645DL
        AgentState.IDLE        -> 0xFF8C8C92L
        AgentState.SHELL, AgentState.UNKNOWN -> 0xFF5F5F66L
    }
}
