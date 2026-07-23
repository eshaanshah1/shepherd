package com.eshaan.shepherd.ui.theme

import com.eshaan.shepherd.model.AgentState
import org.junit.Assert.assertEquals
import org.junit.Test

class PaletteTest {
    @Test fun stateColorsMatchMacSemantics() {
        assertEquals(0xFF5B9DF8L, ShepherdPalette.stateColorHex(AgentState.WORKING))    // blue
        assertEquals(0xFF43C988L, ShepherdPalette.stateColorHex(AgentState.NEEDS_CHECK)) // green
        assertEquals(0xFFE5A23DL, ShepherdPalette.stateColorHex(AgentState.BLOCKED))     // amber
        assertEquals(0xFFE5645DL, ShepherdPalette.stateColorHex(AgentState.ERROR))       // red
        assertEquals(0xFF8C8C92L, ShepherdPalette.stateColorHex(AgentState.IDLE))        // gray
        assertEquals(0xFF5F5F66L, ShepherdPalette.stateColorHex(AgentState.SHELL))       // dim
        assertEquals(0xFF5F5F66L, ShepherdPalette.stateColorHex(AgentState.UNKNOWN))     // dim
    }
}
