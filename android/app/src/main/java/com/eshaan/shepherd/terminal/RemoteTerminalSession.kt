package com.eshaan.shepherd.terminal

import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TerminalOutput
import com.termux.terminal.TerminalSessionClient
import kotlinx.coroutines.*

/**
 * Bridges a raw PTY byte stream to a Termux [TerminalEmulator]: host bytes feed [onOutput] →
 * `emulator.append`; the emulator's own writebacks (terminal query responses) and UI key events
 * feed [sendInput] → the host (via [channelInput]). [onSizeChanged] resizes the local emulator
 * immediately and debounces a [resizeSink] callback (wired to the control-channel `Resize` in A4).
 *
 * [channelInput] is a seam over `DataChannel.input` (kept a lambda so this is unit-testable without
 * a live socket). Emulator mutations (`append`/`resize`) must be called on a single thread by the
 * owner — the ViewModel collects on the main dispatcher (A4).
 */
class RemoteTerminalSession(
    cols: Int,
    rows: Int,
    private val channelInput: (ByteArray) -> Unit,
    private val resizeSink: (Int, Int) -> Unit,
    private val scope: CoroutineScope,
    private val debounceMs: Long = 100,
) {
    private val output = object : TerminalOutput() {
        override fun write(data: ByteArray, offset: Int, count: Int) {
            channelInput(data.copyOfRange(offset, offset + count))
        }
        override fun titleChanged(oldTitle: String?, newTitle: String?) {}
        override fun onCopyTextToClipboard(text: String?) {}
        override fun onPasteTextFromClipboard() {}
        override fun onBell() {}
        override fun onColorsChanged() {}
    }

    val emulator: TerminalEmulator =
        TerminalEmulator(output, cols, rows, TerminalEmulator.DEFAULT_TERMINAL_TRANSCRIPT_ROWS, NoopClient)

    /** The emulator's current grid — so the view can skip redundant resizes on identical layouts. */
    var currentCols: Int = cols; private set
    var currentRows: Int = rows; private set

    /** Set by the view to repaint after the emulator screen mutates (UI-thread callback). */
    var onScreenUpdated: (() -> Unit)? = null

    private val kittyFilter = KittyKeyboardFilter()

    /** Raw PTY bytes from the host → the emulator screen. Kitty keyboard sequences are stripped
     *  so Claude falls back to legacy key encoding (Termux's emulator leaks `u`s otherwise). */
    fun onOutput(bytes: ByteArray) {
        val clean = kittyFilter.filter(bytes)
        emulator.append(clean, clean.size)
        onScreenUpdated?.invoke()
    }

    /** Raw bytes → the host PTY (UI key events / extra keys / submitted text). */
    fun sendInput(bytes: ByteArray) {
        channelInput(bytes)
    }

    /** Send answer keystrokes for a prompt, paced so the TUI keeps up: [keyGapMs] after every
     *  individual keystroke, [questionGapMs] between questions. [perQuestion]`[q]` is the ordered
     *  keystrokes for question q. */
    fun sendPaced(perQuestion: List<List<ByteArray>>, keyGapMs: Long = 50, questionGapMs: Long = 250) {
        scope.launch {
            perQuestion.forEachIndexed { qi, keys ->
                if (qi > 0) delay(questionGapMs)
                for (k in keys) { channelInput(k); delay(keyGapMs) }
            }
        }
    }

    private var resizeJob: Job? = null

    /** Termux `resize(columns, rows)` (verified against v0.118.0 bytecode) + a debounced resizeSink. */
    fun onSizeChanged(cols: Int, rows: Int) {
        emulator.resize(cols, rows)
        currentCols = cols; currentRows = rows
        resizeJob?.cancel()
        resizeJob = scope.launch {
            delay(debounceMs)
            resizeSink(cols, rows)
        }
    }

    /** Resize the local emulator to the host-authoritative grid WITHOUT echoing a [resizeSink]
     *  callback — the size came FROM the host (`DataReady`), so re-sending it would loop. */
    fun applyRemoteSize(cols: Int, rows: Int) {
        emulator.resize(cols, rows)
        currentCols = cols; currentRows = rows
        onScreenUpdated?.invoke()
    }

    /** Test seam: the current screen transcript. */
    fun screenText(): String = emulator.screen.transcriptText

    private object NoopClient : TerminalSessionClient {
        override fun onTextChanged(changedSession: com.termux.terminal.TerminalSession) {}
        override fun onTitleChanged(changedSession: com.termux.terminal.TerminalSession) {}
        override fun onSessionFinished(finishedSession: com.termux.terminal.TerminalSession) {}
        override fun onCopyTextToClipboard(session: com.termux.terminal.TerminalSession, text: String?) {}
        override fun onPasteTextFromClipboard(session: com.termux.terminal.TerminalSession?) {}
        override fun onBell(session: com.termux.terminal.TerminalSession) {}
        override fun onColorsChanged(session: com.termux.terminal.TerminalSession) {}
        override fun onTerminalCursorStateChange(state: Boolean) {}
        override fun getTerminalCursorStyle(): Int? = null
        override fun logError(tag: String?, message: String?) {}
        override fun logWarn(tag: String?, message: String?) {}
        override fun logInfo(tag: String?, message: String?) {}
        override fun logDebug(tag: String?, message: String?) {}
        override fun logVerbose(tag: String?, message: String?) {}
        override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {}
        override fun logStackTrace(tag: String?, e: Exception?) {}
    }
}
