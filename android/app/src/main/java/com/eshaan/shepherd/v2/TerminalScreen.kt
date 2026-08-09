package com.eshaan.shepherd.v2

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.eshaan.shepherd.ui.components.ShepherdTopBar
import com.eshaan.shepherd.ui.theme.ShepherdPalette
import com.termux.terminal.TerminalSession
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient
import kotlinx.coroutines.CoroutineScope

/** Matches `TerminalView.setTextSize` so the grid maths lines up. */
private const val TERM_TEXT_SIZE_PX = 26

/**
 * One session's terminal.
 *
 * A Termux [TerminalView] painting an emulator the HOST is authoritative for —
 * the phone runs no pty and no shell. Attaching hands over a serialized screen,
 * so opening a task that is mid-`vim` shows vim rather than a redraw.
 *
 * Leaving the screen detaches and **does not end the session**: the agent keeps
 * running on the Mac, which is the rule the whole architecture rests on.
 */
@Composable
fun TerminalScreen(
    sessionId: String,
    link: HostLink,
    scope: CoroutineScope,
    onBack: () -> Unit,
) {
    val terminal = remember(sessionId) { SessionTerminal(sessionId, link, scope) }

    DisposableEffect(terminal) {
        terminal.attach()
        onDispose { terminal.detach() }
    }

    // The keyboard shrinks the VISIBLE viewport without reshaping the grid: the
    // pty's size is a viewport the host arbitrates, and re-sending it every time
    // the IME opens would reflow a program under whoever else is watching.
    val imeBottom = WindowInsets.ime.asPaddingValues().calculateBottomPadding()
    val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val bottomInset = maxOf(imeBottom, navBottom)

    Column(Modifier.fillMaxSize().background(Color(ShepherdPalette.ground))) {
        ShepherdTopBar(title = sessionId.take(8), onBack = onBack)
        Box(Modifier.weight(1f).fillMaxWidth().padding(bottom = bottomInset)) {
            AndroidView(
                modifier = Modifier.fillMaxSize().padding(8.dp),
                factory = { context ->
                    TerminalView(context, null).apply {
                        // Termux's renderer skips painting default-background
                        // cells and relies on the view's own background, which is
                        // what makes the terminal read black.
                        setBackgroundColor(android.graphics.Color.BLACK)
                        setTextSize(TERM_TEXT_SIZE_PX)
                        setTerminalViewClient(client())
                        mEmulator = terminal.session.emulator
                        terminal.session.onScreenUpdated = { post { onScreenUpdated() } }
                        addOnLayoutChangeListener { view, _, _, _, _, _, _, _, _ ->
                            pushGrid(view as TerminalView, terminal)
                        }
                    }
                },
            )
        }
    }
}

/**
 * Size the emulator to the view's OWN allocated area, not the whole screen.
 *
 * And declare it as a VIEWPORT rather than resizing: one pty has one size, the
 * host arbitrates between everyone watching, and a client that resized directly
 * would reshape the terminal under the person at the Mac.
 */
private fun pushGrid(view: TerminalView, terminal: SessionTerminal) {
    val renderer = view.mRenderer ?: return
    val cols = ((view.width - view.paddingLeft - view.paddingRight) / renderer.fontWidth).toInt()
    val rows = (view.height - view.paddingTop - view.paddingBottom) / renderer.fontLineSpacing
    if (cols < 2 || rows < 2) return
    if (cols == terminal.session.currentCols && rows == terminal.session.currentRows) return
    terminal.session.onSizeChanged(cols, rows)
}

/** Keystrokes out; everything else is the host's business. */
private fun client(): TerminalViewClient = object : TerminalViewClient {
    override fun onScale(scale: Float): Float = 1f
    override fun onSingleTapUp(e: android.view.MotionEvent?) = Unit
    override fun shouldBackButtonBeMappedToEscape(): Boolean = false
    override fun shouldEnforceCharBasedInput(): Boolean = true
    override fun shouldUseCtrlSpaceWorkaround(): Boolean = false
    override fun isTerminalViewSelected(): Boolean = true
    override fun copyModeChanged(copyMode: Boolean) = Unit
    override fun onKeyDown(keyCode: Int, e: android.view.KeyEvent?, session: TerminalSession?): Boolean = false
    override fun onKeyUp(keyCode: Int, e: android.view.KeyEvent?): Boolean = false
    override fun onLongPress(event: android.view.MotionEvent?): Boolean = false
    override fun readControlKey(): Boolean = false
    override fun readAltKey(): Boolean = false
    override fun readShiftKey(): Boolean = false
    override fun readFnKey(): Boolean = false
    override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session: TerminalSession?): Boolean = false
    override fun onEmulatorSet() = Unit
    override fun logError(tag: String?, message: String?) = Unit
    override fun logWarn(tag: String?, message: String?) = Unit
    override fun logInfo(tag: String?, message: String?) = Unit
    override fun logDebug(tag: String?, message: String?) = Unit
    override fun logVerbose(tag: String?, message: String?) = Unit
    override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) = Unit
    override fun logStackTrace(tag: String?, e: Exception?) = Unit
}
