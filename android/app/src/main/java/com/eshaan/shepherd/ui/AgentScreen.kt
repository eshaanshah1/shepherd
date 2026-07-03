package com.eshaan.shepherd.ui

import android.graphics.Paint
import android.graphics.Typeface
import android.view.KeyEvent
import android.view.MotionEvent
import kotlin.math.ceil
import kotlin.math.max
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.eshaan.shepherd.terminal.RemoteTerminalSession
import com.eshaan.shepherd.transport.DataStatus
import com.termux.terminal.TerminalSession
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient

/**
 * Renders the remote pane. A Termux [TerminalView] paints the [RemoteTerminalSession]'s emulator
 * (we drive rendering via the view's public `mEmulator` field + `onScreenUpdated()` since we own a
 * bare emulator mirroring a remote PTY, not a local [TerminalSession] with a child process). Extra
 * keys and a text field write raw bytes back through the session. Note: full soft-keyboard/IME +
 * font-metric-based sizing is validated on-device (A6).
 */
private const val TERM_TEXT_SIZE_PX = 28

// Monospace metrics matching TerminalView.setTextSize(TERM_TEXT_SIZE_PX) so our grid math lines up
// with what Termux's renderer actually paints.
private val gridPaint = Paint().apply { typeface = Typeface.MONOSPACE; textSize = TERM_TEXT_SIZE_PX.toFloat() }

/** Size the emulator to the TerminalView's OWN allocated area (not the whole screen): the pixels it
 *  gets between the top bar and the bottom controls, minus padding → exact cols×rows, no cut-off. */
private fun pushGridSize(view: TerminalView, session: RemoteTerminalSession) {
    val w = view.width - view.paddingLeft - view.paddingRight
    val h = view.height - view.paddingTop - view.paddingBottom
    if (w <= 0 || h <= 0) return
    val cellW = gridPaint.measureText("X").coerceAtLeast(1f)
    val lineH = ceil(gridPaint.fontSpacing).toInt().coerceAtLeast(1)
    val cols = max(1, (w / cellW).toInt())
    val rows = max(1, h / lineH)
    if (cols == session.currentCols && rows == session.currentRows) return
    session.onSizeChanged(cols, rows)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentScreen(vm: AgentViewModel, onBack: () -> Unit) {
    val session by vm.terminalSession.collectAsState()
    val status by vm.status.collectAsState()
    val prompt by vm.prompt.collectAsState()
    // Reset when the prompt changes so a new prompt re-shows the panel even after "Use terminal".
    var forceTerminal by remember(prompt) { mutableStateOf(false) }
    LaunchedEffect(Unit) { vm.attach() }
    // The VM is remember-scoped (not ViewModelStore-owned), so onCleared() never fires — detach
    // on leaving composition (Back-nav) to close the socket + coroutines and let the host snap back.
    // Also mark this pane as the visible one so a push for it skips the (redundant) banner.
    DisposableEffect(vm) {
        com.eshaan.shepherd.fcm.AppForeground.visiblePane = vm.paneId
        onDispose {
            if (com.eshaan.shepherd.fcm.AppForeground.visiblePane == vm.paneId)
                com.eshaan.shepherd.fcm.AppForeground.visiblePane = null
            vm.detach()
        }
    }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text(statusLabel(status)) },
            navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
        )
    }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            val s = session
            val p = prompt
            if (s != null && p != null && !forceTerminal) {
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    PromptPanel(p, onAnswer = { s.sendPaced(it) }, onUseTerminal = { forceTerminal = true })
                }
            } else if (s != null) {
                AndroidView(
                    // clipToBounds: a legacy TerminalView won't clip its own drawing to the Compose
                    // layout box, so without this its overflow rows paint over the controls below.
                    modifier = Modifier.weight(1f).fillMaxWidth().clipToBounds(),
                    factory = { ctx ->
                        TerminalView(ctx, null).apply {
                            // Termux's renderer skips painting default-background cells and relies on
                            // the view's own background, so this is what makes the terminal read black.
                            setBackgroundColor(android.graphics.Color.BLACK)
                            setTerminalViewClient(inputClient(s))
                            setTextSize(TERM_TEXT_SIZE_PX)
                            mEmulator = s.emulator
                            s.onScreenUpdated = { post { onScreenUpdated() } }
                            // Size the grid to the view's real pixels so it fits exactly (never cut
                            // off): recompute cols×rows on every layout (rotation, keyboard show/hide)
                            // and drive it as the phone's size — local emulator + host Resize request.
                            addOnLayoutChangeListener { v, _, _, _, _, _, _, _, _ ->
                                pushGridSize(v as TerminalView, s)
                            }
                            onScreenUpdated()
                        }
                    },
                    update = { view ->
                        view.mEmulator = s.emulator
                        s.onScreenUpdated = { view.post { view.onScreenUpdated() } }
                        pushGridSize(view, s)
                        view.onScreenUpdated()
                    },
                )
                Column(Modifier.fillMaxWidth().background(Color.Black)) {
                    ExtraKeysRow(s)
                    InputField(s)
                }
            } else {
                Box(Modifier.weight(1f).fillMaxWidth())
            }
        }
    }
}

private fun statusLabel(status: DataStatus): String = when (status) {
    is DataStatus.Connecting -> "Connecting…"
    is DataStatus.Ready -> "Agent"
    is DataStatus.Rejected -> "Rejected: ${status.reason}"
    is DataStatus.Disconnected -> "Disconnected"
}

@Composable
private fun ExtraKeysRow(session: RemoteTerminalSession) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(8.dp, 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        keyButton("Esc", session, Key.Esc)
        keyButton("Ctrl-C", session, Key.CtrlC)
        keyButton("Tab", session, Key.Tab)
        keyButton("←", session, Key.Left)
        keyButton("↓", session, Key.Down)
        keyButton("↑", session, Key.Up)
        keyButton("→", session, Key.Right)
        keyButton("Enter", session, Key.Enter)
    }
}

@Composable
private fun keyButton(label: String, session: RemoteTerminalSession, key: Key) {
    OutlinedButton(onClick = { session.sendInput(escBytesFor(key)) }, contentPadding = PaddingValues(10.dp, 4.dp)) {
        Text(label)
    }
}

@Composable
private fun InputField(session: RemoteTerminalSession) {
    var text by remember { mutableStateOf("") }
    Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        OutlinedTextField(
            value = text, onValueChange = { text = it },
            modifier = Modifier.weight(1f),
            singleLine = true,
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSend = {
                session.sendInput((text + "\r").toByteArray()); text = ""
            }),
        )
        Spacer(Modifier.width(8.dp))
        Button(onClick = { session.sendInput((text + "\r").toByteArray()); text = "" }) { Text("Send") }
    }
}

/** Minimal [TerminalViewClient]: forwards typed code points + hardware keys to the remote PTY. */
private fun inputClient(session: RemoteTerminalSession) = object : TerminalViewClient {
    override fun onScale(scale: Float): Float = scale
    override fun onSingleTapUp(e: MotionEvent?) {}
    override fun shouldBackButtonBeMappedToEscape(): Boolean = false
    override fun shouldEnforceCharBasedInput(): Boolean = true
    override fun shouldUseCtrlSpaceWorkaround(): Boolean = false
    override fun isTerminalViewSelected(): Boolean = true
    override fun copyModeChanged(copyMode: Boolean) {}
    override fun onKeyDown(keyCode: Int, e: KeyEvent?, session0: TerminalSession?): Boolean {
        val bytes = when (keyCode) {
            KeyEvent.KEYCODE_ENTER -> escBytesFor(Key.Enter)
            KeyEvent.KEYCODE_DEL -> byteArrayOf(0x7f)
            KeyEvent.KEYCODE_ESCAPE -> escBytesFor(Key.Esc)
            KeyEvent.KEYCODE_TAB -> escBytesFor(Key.Tab)
            KeyEvent.KEYCODE_DPAD_UP -> escBytesFor(Key.Up)
            KeyEvent.KEYCODE_DPAD_DOWN -> escBytesFor(Key.Down)
            KeyEvent.KEYCODE_DPAD_LEFT -> escBytesFor(Key.Left)
            KeyEvent.KEYCODE_DPAD_RIGHT -> escBytesFor(Key.Right)
            else -> null
        }
        if (bytes != null) { session.sendInput(bytes); return true }
        return false
    }
    override fun onKeyUp(keyCode: Int, e: KeyEvent?): Boolean = false
    override fun onLongPress(e: MotionEvent?): Boolean = false
    override fun readControlKey(): Boolean = false
    override fun readAltKey(): Boolean = false
    override fun readShiftKey(): Boolean = false
    override fun readFnKey(): Boolean = false
    override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session0: TerminalSession?): Boolean {
        session.sendInput(String(Character.toChars(codePoint)).toByteArray())
        return true
    }
    override fun onEmulatorSet() {}
    override fun logError(tag: String?, message: String?) {}
    override fun logWarn(tag: String?, message: String?) {}
    override fun logInfo(tag: String?, message: String?) {}
    override fun logDebug(tag: String?, message: String?) {}
    override fun logVerbose(tag: String?, message: String?) {}
    override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {}
    override fun logStackTrace(tag: String?, e: Exception?) {}
}
