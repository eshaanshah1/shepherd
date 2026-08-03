package com.eshaan.shepherd.ui

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver

/**
 * The lifecycle→resume mapping, extracted so it can be tested without an Activity.
 *
 * The wiring is the part that rots: a screen that stops calling [AgentViewModel.resume] on
 * foreground looks perfectly correct, compiles, and silently costs you an instant reattach on
 * unlock. Testing it through `ActivityScenario` would need Robolectric and the whole Compose host;
 * this is the same guarantee for the price of one function.
 *
 * ON_START, not ON_RESUME: unlocking and returning to the app both pass through START, and
 * `addObserver` replays the current state, so registering while already started fires it too —
 * which makes this the initial connect as well.
 */
fun resumeOnForegroundObserver(onForeground: () -> Unit) = LifecycleEventObserver { _, event ->
    if (event == Lifecycle.Event.ON_START) onForeground()
}
