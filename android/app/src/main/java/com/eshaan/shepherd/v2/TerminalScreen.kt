package com.eshaan.shepherd.v2

import android.view.KeyEvent
import android.view.MotionEvent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.eshaan.shepherd.R
import com.eshaan.shepherd.ui.Key
import com.eshaan.shepherd.ui.components.KeyPill
import com.eshaan.shepherd.ui.components.SwipeNavStrip
import com.eshaan.shepherd.ui.components.ShepherdTopBar
import com.eshaan.shepherd.ui.components.Tabler
import com.eshaan.shepherd.ui.components.TablerIcon
import com.eshaan.shepherd.ui.escBytesFor
import com.eshaan.shepherd.ui.theme.ShepherdPalette
import com.termux.terminal.TerminalSession
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient
import kotlinx.coroutines.CoroutineScope

/** Matches `TerminalView.setTextSize` so the grid maths lines up. */
private const val TERM_TEXT_SIZE_PX = 26

/** Below this a viewer is not reading anything, so a wide session pans instead. */
private const val MIN_TEXT_SIZE_PX = 8

/**
 * One session's terminal.
 *
 * A Termux [TerminalView] painting an emulator the HOST is authoritative for —
 * the phone runs no pty and no shell. Attaching hands over a serialized screen,
 * so opening a task that is mid-`vim` shows vim rather than a redraw.
 *
 * Leaving the screen detaches and **does not end the session**: the agent keeps
 * running on the Mac, which is the rule the whole architecture rests on.
 *
 * **Input is three surfaces, not one**, and each exists because the others
 * cannot do its job on a phone:
 *
 *   - the **view itself**, for a hardware keyboard and the IME's code points;
 *   - the **key bar**, because Esc / Ctrl-C / Tab / Enter are not on a soft
 *     keyboard at all and an agent needs every one of them;
 *   - the **compose row**, because typing a paragraph a character at a time into
 *     a pty over a network is miserable, and Android's IME will happily
 *     autocorrect a half-typed command under you.
 *
 * They all end at the same place — bytes on the session's write frame — so
 * nothing here knows which one a keystroke came from.
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

    var keysShown by remember { mutableStateOf(true) }
    /**
     * Opening a session from the phone TAKES the size, and that is the right
     * default rather than a bold one.
     *
     * Passive-and-scaled is correct in principle — the Mac keeps its grid, the
     * font shrinks to fit — but the arithmetic kills it: 132 columns across a
     * 1080px phone is about eight pixels a cell, so a five-pixel font. Nobody
     * reads that. You opened a terminal because you meant to use it, so the pty
     * is reshaped to a grid you can read and `SIGWINCH` makes the program lay
     * itself out for it. Backing out withdraws the viewport and the Mac springs
     * back — see `detach`.
     */
    var controlling by remember(terminal) { mutableStateOf(true) }
    var viewRef by remember(terminal) { mutableStateOf<TerminalView?>(null) }
    DisposableEffect(terminal) {
        terminal.takeControl(true)
        onDispose { }
    }

    Column(Modifier.fillMaxSize().background(Color(ShepherdPalette.ground))) {
        ShepherdTopBar(title = sessionId.take(8), onBack = onBack)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            AndroidView(
                modifier = Modifier.fillMaxSize().padding(8.dp),
                factory = { context ->
                    TerminalView(context, null).apply {
                        viewRef = this
                        // Termux's renderer skips painting default-background
                        // cells and relies on the view's own background, which is
                        // what makes the terminal read black.
                        setBackgroundColor(android.graphics.Color.BLACK)
                        setTextSize(TERM_TEXT_SIZE_PX)
                        setTerminalViewClient(inputClient(terminal))
                        mEmulator = terminal.session.emulator
                        terminal.session.onScreenUpdated = { post { onScreenUpdated() } }
                        // The host's grid changed — refit the FONT to it. A
                        // passive viewer never reshapes the terminal; it makes
                        // the type small enough to show the whole real screen.
                        terminal.onHostGrid = { cols, _ -> post { applySizing(this, terminal, cols) } }
                        addOnLayoutChangeListener { view, _, _, _, _, _, _, _, _ ->
                            applySizing(view as TerminalView, terminal, terminal.session.currentCols)
                        }
                    }
                },
            )
        }
        Column(
            Modifier.fillMaxWidth()
                .background(Color(ShepherdPalette.surface1))
                .padding(bottom = bottomInset),
        ) {
            KeyBarHandle(keysShown) { keysShown = !keysShown }
            if (keysShown) {
                KeyBar(terminal, controlling) {
                    controlling = !controlling
                    terminal.takeControl(controlling)
                    viewRef?.let { applySizing(it, terminal, terminal.session.currentCols) }
                }
            }
            ComposeRow(terminal)
        }
    }
}

/** Slim always-visible handle: taps fold the key bar so the terminal can take the height. */
@Composable
private fun KeyBarHandle(shown: Boolean, onToggle: () -> Unit) {
    Box(
        Modifier.fillMaxWidth().height(18.dp).clickable(onClick = onToggle),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            if (shown) "⌄" else "⌃",
            style = MaterialTheme.typography.labelSmall,
            color = Color(ShepherdPalette.textDim),
        )
    }
}

/**
 * The keys a soft keyboard does not have.
 *
 * Esc, Ctrl-C, Tab and Enter are not garnish — they are how you dismiss a menu,
 * interrupt a runaway command, complete a path, and answer a prompt. Without
 * them a phone can watch an agent but not drive one.
 */
@Composable
private fun KeyBar(terminal: SessionTerminal, controlling: Boolean, onToggleControl: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(8.dp, 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        val press = { key: Key -> terminal.session.sendInput(escBytesFor(key)) }
        KeyPill("Esc") { press(Key.Esc) }
        KeyPill("^C") { press(Key.CtrlC) }
        KeyPill("Tab") { press(Key.Tab) }
        KeyPill(Tabler.cornerDownLeft) { press(Key.Enter) }
        Spacer(Modifier.weight(1f))
        /**
         * Take the size, explicitly.
         *
         * Off (the default) this phone is a VIEWER: the Mac keeps its grid and
         * the font here shrinks to fit it, so glancing at a session costs the
         * person at the desk nothing. On, the pty is reshaped to this phone —
         * `SIGWINCH` makes the program redo its own layout, which is the only
         * way a small screen is ever genuinely right — and the Mac letterboxes
         * until control is handed back.
         */
        KeyPill(if (controlling) "◉ ctrl" else "○ ctrl", onToggleControl)
        // Arrows as a trackpad rather than four targets: a d-pad of 38dp pills
        // eats the bar, and stepping through a menu is a drag, not four taps.
        SwipeNavStrip { key -> press(key) }
    }
}

/** A whole line at a time, submitted with Enter — the way you send a prompt. */
@Composable
private fun ComposeRow(terminal: SessionTerminal) {
    var text by remember { mutableStateOf("") }
    val send = {
        if (text.isNotEmpty()) {
            // `\r`, not `\n`: a pty in canonical mode ends a line on carriage
            // return, and a newline here types a literal one instead of
            // pressing Enter — a command that echoes and never runs.
            terminal.session.sendInput((text + "\r").toByteArray())
            text = ""
        }
    }
    Row(
        Modifier.fillMaxWidth().padding(8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.weight(1f),
            singleLine = true,
            shape = RoundedCornerShape(10.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = Color(ShepherdPalette.surface2),
                unfocusedContainerColor = Color(ShepherdPalette.surface2),
                focusedBorderColor = Color(0xFF5B9DF8),
                unfocusedBorderColor = Color(ShepherdPalette.hairline),
            ),
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSend = { send() }),
        )
        Box(
            Modifier.size(48.dp).clip(CircleShape).background(Color(0xFF5B9DF8)).clickable { send() },
            contentAlignment = Alignment.Center,
        ) {
            TablerIcon(Tabler.send, Color(0xFF0F0F11), size = 20.dp)
        }
    }
}

/**
 * The two modes are two different answers to one question, and they must not
 * both run — which they did, and they cancelled each other out.
 *
 * `fitFontTo` shrank the type so the Mac's 78 columns fit; `reportGrid` then
 * measured that tiny type and declared "78 columns is what I can display", so
 * taking control asked for exactly the grid it already had. The terminal never
 * got smaller and the font never got bigger.
 *
 * Controlling: keep a READABLE font and report however few columns that yields —
 * the pty reshapes to it and the program lays itself out. Passive: keep the
 * host's grid untouched and shrink the type instead.
 */
private fun applySizing(view: TerminalView, terminal: SessionTerminal, hostCols: Int) {
    if (terminal.controlling) {
        view.setTextSize(TERM_TEXT_SIZE_PX)
        view.setTag(R.id.shepherd_text_size, TERM_TEXT_SIZE_PX)
        reportGrid(view, terminal)
    } else {
        fitFontTo(view, hostCols)
    }
}

/**
 * Shrink the type until the HOST's columns fit this screen.
 *
 * This is the passive half of the hybrid, and it is the only correct one for a
 * viewer: the pty's grid is what the running program drew for, so the honest
 * thing to change is the font, not the terminal. `fontWidth` scales linearly
 * with text size, so one measurement gives the ratio; it is clamped so the
 * result stays legible and cannot collapse to nothing on a silly-wide session.
 */
private fun fitFontTo(view: TerminalView, hostCols: Int) {
    if (hostCols < 2) return
    val renderer = view.mRenderer ?: return
    val usable = view.width - view.paddingLeft - view.paddingRight
    if (usable <= 0 || renderer.fontWidth <= 0f) return
    // The renderer's own text size is package-private, so the CURRENT size is
    // tracked here instead of read back. Same number either way — this view is
    // the only thing that ever sets it.
    val current = view.getTag(R.id.shepherd_text_size) as? Int ?: TERM_TEXT_SIZE_PX
    val wanted = (current * usable / (renderer.fontWidth * hostCols)).toInt()
    val clamped = wanted.coerceIn(MIN_TEXT_SIZE_PX, TERM_TEXT_SIZE_PX)
    if (clamped == current) return
    view.setTextSize(clamped)
    view.setTag(R.id.shepherd_text_size, clamped)
}

/**
 * Tell the session what this view could display — acted on only while it holds
 * control, so a layout change never silently reshapes somebody else's terminal.
 */
private fun reportGrid(view: TerminalView, terminal: SessionTerminal) {
    val renderer = view.mRenderer ?: return
    val cols = ((view.width - view.paddingLeft - view.paddingRight) / renderer.fontWidth).toInt()
    val rows = (view.height - view.paddingTop - view.paddingBottom) / renderer.fontLineSpacing
    if (cols < 2 || rows < 2) return
    terminal.reportGrid(cols, rows)
}

/**
 * Keystrokes out; everything else is the host's business.
 *
 * This used to return `false` from every method — including `onCodePoint` — so
 * the view swallowed every character and the terminal was strictly read-only.
 * Nothing said so: the screen painted, the cursor blinked, and typing did
 * nothing at all.
 */
private fun inputClient(terminal: SessionTerminal): TerminalViewClient = object : TerminalViewClient {
    private fun send(bytes: ByteArray) = terminal.session.sendInput(bytes)

    /**
     * Pinch to zoom, which is what makes the passive mode usable at all: a
     * viewer that is not reshaping the pty is looking at somebody else's grid,
     * and its only honest controls are the size of the type and where it is
     * panned.
     */
    override fun onScale(scale: Float): Float = scale
    override fun onSingleTapUp(e: MotionEvent?) = Unit
    override fun shouldBackButtonBeMappedToEscape(): Boolean = false
    override fun shouldEnforceCharBasedInput(): Boolean = true
    override fun shouldUseCtrlSpaceWorkaround(): Boolean = false
    override fun isTerminalViewSelected(): Boolean = true
    override fun copyModeChanged(copyMode: Boolean) = Unit

    override fun onKeyDown(keyCode: Int, e: KeyEvent?, session: TerminalSession?): Boolean {
        val bytes = when (keyCode) {
            KeyEvent.KEYCODE_ENTER -> escBytesFor(Key.Enter)
            // 0x7f (DEL), not 0x08: readline and every TUI on the far side
            // expect erase-to-the-left as DEL.
            KeyEvent.KEYCODE_DEL -> byteArrayOf(0x7f)
            KeyEvent.KEYCODE_ESCAPE -> escBytesFor(Key.Esc)
            KeyEvent.KEYCODE_TAB -> escBytesFor(Key.Tab)
            KeyEvent.KEYCODE_DPAD_UP -> escBytesFor(Key.Up)
            KeyEvent.KEYCODE_DPAD_DOWN -> escBytesFor(Key.Down)
            KeyEvent.KEYCODE_DPAD_LEFT -> escBytesFor(Key.Left)
            KeyEvent.KEYCODE_DPAD_RIGHT -> escBytesFor(Key.Right)
            else -> null
        }
        if (bytes == null) return false
        send(bytes)
        return true
    }

    override fun onKeyUp(keyCode: Int, e: KeyEvent?): Boolean = false
    override fun onLongPress(event: MotionEvent?): Boolean = false
    override fun readControlKey(): Boolean = false
    override fun readAltKey(): Boolean = false
    override fun readShiftKey(): Boolean = false
    override fun readFnKey(): Boolean = false

    override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session: TerminalSession?): Boolean {
        // UTF-8 out, always: the host opens the pty with no encoding so a
        // multi-byte character is never re-decoded on the way through.
        send(String(Character.toChars(codePoint)).toByteArray())
        return true
    }

    override fun onEmulatorSet() = Unit
    override fun logError(tag: String?, message: String?) = Unit
    override fun logWarn(tag: String?, message: String?) = Unit
    override fun logInfo(tag: String?, message: String?) = Unit
    override fun logDebug(tag: String?, message: String?) = Unit
    override fun logVerbose(tag: String?, message: String?) = Unit
    override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) = Unit
    override fun logStackTrace(tag: String?, e: Exception?) = Unit
}
