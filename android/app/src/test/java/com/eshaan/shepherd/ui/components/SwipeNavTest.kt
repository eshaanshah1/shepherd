package com.eshaan.shepherd.ui.components

import com.eshaan.shepherd.ui.Key
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SwipeNavTest {
    @Test fun horizontalDominant() {
        assertEquals(Key.Right, swipeDirection(40f, 5f, 20f))
        assertEquals(Key.Left, swipeDirection(-40f, -5f, 20f))
    }
    @Test fun verticalDominant() {
        assertEquals(Key.Down, swipeDirection(5f, 40f, 20f))   // screen y grows downward
        assertEquals(Key.Up, swipeDirection(-5f, -40f, 20f))
    }
    @Test fun belowThresholdIsNull() {
        assertNull(swipeDirection(8f, 8f, 20f))
    }
}
