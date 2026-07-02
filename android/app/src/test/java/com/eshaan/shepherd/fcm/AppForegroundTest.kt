package com.eshaan.shepherd.fcm

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppForegroundTest {
    @Test fun viewingRequiresResumedAndMatchingPane() {
        AppForeground.resumed = false
        AppForeground.visiblePane = "p1"
        assertFalse("backgrounded → don't suppress", AppForeground.isViewing("p1"))

        AppForeground.resumed = true
        assertTrue("foreground on this pane → suppress", AppForeground.isViewing("p1"))
        assertFalse("different pane → still notify", AppForeground.isViewing("p2"))

        AppForeground.visiblePane = null
        assertFalse("no visible pane → notify", AppForeground.isViewing("p1"))
        AppForeground.resumed = false
    }
}
