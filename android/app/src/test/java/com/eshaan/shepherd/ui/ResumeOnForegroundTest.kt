package com.eshaan.shepherd.ui

import androidx.lifecycle.Lifecycle
import org.junit.Assert.*
import org.junit.Test

/**
 * The wiring, which is the part that rots silently: a screen that stops resuming on foreground
 * compiles, looks right, and just quietly costs an instant reattach on unlock.
 */
class ResumeOnForegroundTest {
    @Test fun firesOnStartOnly() {
        var fired = 0
        val obs = resumeOnForegroundObserver { fired++ }
        obs.onStateChanged(FakeOwner, Lifecycle.Event.ON_CREATE)
        obs.onStateChanged(FakeOwner, Lifecycle.Event.ON_STOP)
        obs.onStateChanged(FakeOwner, Lifecycle.Event.ON_PAUSE)
        assertEquals("only ON_START may resume", 0, fired)
        obs.onStateChanged(FakeOwner, Lifecycle.Event.ON_START)
        assertEquals(1, fired)
        obs.onStateChanged(FakeOwner, Lifecycle.Event.ON_START)   // a second unlock
        assertEquals(2, fired)
    }

    private object FakeOwner : androidx.lifecycle.LifecycleOwner {
        override val lifecycle: Lifecycle get() = throw UnsupportedOperationException("unused")
    }
}
