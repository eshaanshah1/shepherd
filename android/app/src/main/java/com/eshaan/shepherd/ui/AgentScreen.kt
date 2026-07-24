package com.eshaan.shepherd.ui

import android.graphics.Paint
import android.graphics.Typeface
import androidx.activity.compose.BackHandler
import android.view.KeyEvent
import android.view.MotionEvent
import kotlin.math.ceil
import kotlin.math.max
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.eshaan.shepherd.model.AgentState
import com.eshaan.shepherd.model.cleanPaneTitle
import com.eshaan.shepherd.terminal.RemoteTerminalSession
import com.eshaan.shepherd.transport.DataStatus
import com.eshaan.shepherd.ui.components.KeyPill
import com.eshaan.shepherd.ui.components.ShepherdTopBar
import com.eshaan.shepherd.ui.components.StatusPill
import com.eshaan.shepherd.ui.components.SwipeNavStrip
import com.eshaan.shepherd.ui.components.Tabler
import com.eshaan.shepherd.ui.components.TablerIcon
import com.eshaan.shepherd.ui.theme.ShepherdPalette
import com.termux.terminal.TerminalSession
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient

/**
 * Renders the remote pane. A Termux [TerminalView] paints the [RemoteTerminalSession]'s emulator
 * (we drive rendering via the view's public `mEmulator` field + `onScreenUpdated()` since we own a
 * bare emulator mirroring a remote PTY, not a local [TerminalSession] with a child process). Extra
 * keys and a text field write raw bytes back through the session.
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

@Composable
fun AgentScreen(vm: AgentViewModel, title: String, onBack: () -> Unit) {
    // System back returns to the Fleet list (without this it bubbles to the Activity and exits).
    BackHandler(onBack = onBack)
    val session by vm.terminalSession.collectAsState()
    val status by vm.status.collectAsState()
    val prompt by vm.prompt.collectAsState()
    // Reset when the prompt changes so a new prompt re-shows the panel even after "Use terminal".
    var forceTerminal by remember(prompt) { mutableStateOf(false) }
    // Create the emulator eagerly so the terminal can render + measure its grid; the data channel is
    // opened later at that measured size (see the BoxWithConstraints below) so the host resizes the
    // PTY before it streams — no first-paint reshape.
    LaunchedEffect(Unit) { vm.prepareSession() }
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

    // Keyboard handling without reshaping the PTY: the terminal keeps a FIXED portrait grid. When
    // the IME opens we shrink only the *visible* viewport (the top bar stays put) and bottom-anchor
    // the full-height terminal inside it, clipping the top scrollback under the pane — so the live
    // bottom rows stay above the keyboard and pushGridSize sees a constant size (no Resize sent).
    val imeBottom = WindowInsets.ime.asPaddingValues().calculateBottomPadding()
    val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val bottomInset = maxOf(imeBottom, navBottom)
    val keyboardExtra = maxOf(0.dp, imeBottom - navBottom)   // height the keyboard steals past the resting nav pad

    Column(Modifier.fillMaxSize().background(Color(ShepherdPalette.ground))) {
        val (dotState, word) = statusPill(status)
        val shownTitle = cleanPaneTitle(title.ifBlank { vm.paneId.take(8) })
        ShepherdTopBar(title = shownTitle, onBack = onBack,
            trailing = { StatusPill(dotState, word) })
        val s = session
        val p = prompt
        if (s != null && p != null && !forceTerminal) {
            // Opened straight into a prompt: the terminal never renders to be measured, so open the
            // channel at the fallback size just so answers can send. (Switching to the terminal
            // resizes it to the real grid.)
            LaunchedEffect(Unit) { vm.attach() }
            Box(Modifier.weight(1f).fillMaxWidth().padding(bottom = bottomInset)) {
                PromptPanel(p, onAnswer = { s.sendPaced(it) }, onUseTerminal = { forceTerminal = true })
            }
        } else if (s != null) {
            // Terminal + controls shrink together when the keyboard opens; the top bar above stays put.
            Column(Modifier.weight(1f).fillMaxWidth().padding(bottom = bottomInset)) {
                // Contained terminal pane: rounded, hairline border, inset from the chrome.
                Box(
                    Modifier.weight(1f).fillMaxWidth().padding(12.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .border(1.dp, Color(ShepherdPalette.hairline), RoundedCornerShape(12.dp))
                        .clipToBounds()
                ) {
                    BoxWithConstraints(Modifier.fillMaxSize()) {
                        // Fixed grid height = resting height + whatever the keyboard stole, so it's
                        // invariant to the IME → the emulator/PTY size never changes on keyboard.
                        val fullHeight = maxHeight + keyboardExtra
                        // Open the data channel at the EXACT grid this pane will render (same math as
                        // pushGridSize) BEFORE the terminal view mounts — so the host resizes the PTY
                        // to the phone's size ahead of streaming, and the first frame isn't reshaped.
                        val density = LocalDensity.current
                        val grid = remember(maxWidth, fullHeight) {
                            with(density) {
                                val cellW = gridPaint.measureText("X").coerceAtLeast(1f)
                                val lineH = ceil(gridPaint.fontSpacing).toInt().coerceAtLeast(1)
                                max(1, (maxWidth.toPx() / cellW).toInt()) to max(1, (fullHeight.toPx().toInt() / lineH))
                            }
                        }
                        LaunchedEffect(grid) { vm.attach(grid.first, grid.second) }
                        AndroidView(
                            modifier = Modifier.fillMaxWidth().height(fullHeight).align(Alignment.BottomStart),
                            factory = { ctx ->
                                TerminalView(ctx, null).apply {
                                    // Termux's renderer skips painting default-background cells and relies on
                                    // the view's own background, so this is what makes the terminal read black.
                                    setBackgroundColor(android.graphics.Color.BLACK)
                                    setTerminalViewClient(inputClient(s))
                                    setTextSize(TERM_TEXT_SIZE_PX)
                                    mEmulator = s.emulator
                                    s.onScreenUpdated = { post { onScreenUpdated() } }
                                    // Recompute cols×rows on every layout (rotation etc.). The height is
                                    // keyboard-invariant (see fullHeight), so the keyboard never resizes it.
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
                    }
                }
                var navShown by remember { mutableStateOf(true) }
                Column(Modifier.fillMaxWidth().background(Color(ShepherdPalette.surface1))) {
                    NavHandle(navShown) { navShown = !navShown }
                    if (navShown) KeyBar(s)
                    InputRow(s)
                }
            }
        } else {
            Box(Modifier.weight(1f).fillMaxWidth())
        }
    }
}

private fun statusPill(status: DataStatus): Pair<AgentState, String> = when (status) {
    is DataStatus.Connecting   -> AgentState.WORKING to "Connecting…"
    is DataStatus.Ready        -> AgentState.IDLE to "Ready"
    is DataStatus.Rejected     -> AgentState.ERROR to "Rejected"
    is DataStatus.Disconnected -> AgentState.SHELL to "Disconnected"
}

/** Slim always-visible handle: taps toggle the key bar so the terminal can take full height. */
@Composable
private fun NavHandle(shown: Boolean, onToggle: () -> Unit) {
    Box(Modifier.fillMaxWidth().height(18.dp).clickable(onClick = onToggle), contentAlignment = Alignment.Center) {
        Text(if (shown) "⌄" else "⌃", style = MaterialTheme.typography.labelSmall,
            color = Color(ShepherdPalette.textDim))
    }
}

@Composable
private fun KeyBar(session: RemoteTerminalSession) {
    Row(
        Modifier.fillMaxWidth().padding(8.dp, 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        KeyPill("Esc") { session.sendInput(escBytesFor(Key.Esc)) }
        KeyPill("^C") { session.sendInput(escBytesFor(Key.CtrlC)) }
        KeyPill("Tab") { session.sendInput(escBytesFor(Key.Tab)) }
        KeyPill(Tabler.cornerDownLeft) { session.sendInput(escBytesFor(Key.Enter)) }
        Spacer(Modifier.weight(1f))
        SwipeNavStrip { key -> session.sendInput(escBytesFor(key)) }
    }
}

@Composable
private fun InputRow(session: RemoteTerminalSession) {
    var text by remember { mutableStateOf("") }
    val send = { if (text.isNotEmpty()) { session.sendInput((text + "\r").toByteArray()); text = "" } }
    Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = text, onValueChange = { text = it }, modifier = Modifier.weight(1f), singleLine = true,
            shape = RoundedCornerShape(10.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = Color(ShepherdPalette.surface2), unfocusedContainerColor = Color(ShepherdPalette.surface2),
                focusedBorderColor = Color(0xFF5B9DF8), unfocusedBorderColor = Color(ShepherdPalette.hairline)),
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSend = { send() }),
        )
        Box(Modifier.size(48.dp).clip(CircleShape).background(Color(0xFF5B9DF8))
            .clickable { send() }, contentAlignment = Alignment.Center) {
            TablerIcon(Tabler.send, Color(0xFF0F0F11), size = 20.dp)
        }
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
