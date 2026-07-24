package com.eshaan.shepherd.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.terminal.RemoteTerminalSession
import com.eshaan.shepherd.transport.ConnStatus
import com.eshaan.shepherd.transport.DataChannel
import com.eshaan.shepherd.transport.DataStatus
import com.eshaan.shepherd.transport.RemoteConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** Extra-key / hardware-key logical keys the terminal input row emits. */
enum class Key { Esc, Tab, Enter, Up, Down, Left, Right, CtrlC }

/** Pure map from a logical key to the raw bytes written to the PTY (xterm sequences). */
fun escBytesFor(key: Key): ByteArray = when (key) {
    Key.Esc -> byteArrayOf(0x1b)
    Key.Tab -> byteArrayOf(0x09)
    Key.Enter -> byteArrayOf(0x0d)
    Key.Up -> byteArrayOf(0x1b, '['.code.toByte(), 'A'.code.toByte())
    Key.Down -> byteArrayOf(0x1b, '['.code.toByte(), 'B'.code.toByte())
    Key.Right -> byteArrayOf(0x1b, '['.code.toByte(), 'C'.code.toByte())
    Key.Left -> byteArrayOf(0x1b, '['.code.toByte(), 'D'.code.toByte())
    Key.CtrlC -> byteArrayOf(0x03)
}

/**
 * Owns the [DataChannel] + [RemoteTerminalSession] for one pane. [attach] reads the live
 * `sessionNonce` off the control connection (already `Connected`), opens the data channel, and
 * fans channel output into the emulator; resize deltas go back out on the control channel.
 */
class AgentViewModel(
    val paneId: String,
    private val host: String,
    private val port: Int,
    private val controlConn: RemoteConnection,
    val initialCols: Int = 80,
    val initialRows: Int = 24,
    private val channelFactory: (nonce: String, cols: Int, rows: Int, scope: CoroutineScope) -> DataChannel =
        { nonce, cols, rows, scope -> DataChannel(host, port, nonce, paneId, cols, rows, scope) },
) : ViewModel() {
    private val _terminalSession = MutableStateFlow<RemoteTerminalSession?>(null)
    val terminalSession: StateFlow<RemoteTerminalSession?> = _terminalSession
    private val _status = MutableStateFlow<DataStatus>(DataStatus.Disconnected)
    val status: StateFlow<DataStatus> = _status
    // The pane's active blocking prompt (AskUserQuestion / permission / plan), or null. Set when a
    // Prompt for this pane arrives; cleared when the pane leaves the blocked state.
    private val _prompt = MutableStateFlow<ControlMessage.Prompt?>(null)
    val prompt: StateFlow<ControlMessage.Prompt?> = _prompt

    private var channel: DataChannel? = null
    private val jobs = mutableListOf<Job>()
    @Volatile private var opened = false

    /** Create the terminal emulator/session eagerly — WITHOUT opening the data channel — so the
     *  view can render and measure its grid first. [attach] then opens the channel at that measured
     *  size, so the host resizes the PTY before it streams (no first-paint reshape). Idempotent. */
    fun prepareSession() {
        if (_terminalSession.value != null) return
        // Mirror this pane's current prompt from the store (populated by FleetViewModel's always-on
        // collector) — gives the current value immediately + live updates, with no missed-prompt race.
        jobs += viewModelScope.launch { PromptStore.flow(paneId).collect { _prompt.value = it } }
        _terminalSession.value = RemoteTerminalSession(
            initialCols, initialRows,
            channelInput = { channel?.input(it) },   // no-op until the channel opens
            resizeSink = { c, r -> controlConn.send(ControlMessage.Resize(paneId, c, r)) },
            scope = viewModelScope,
        )
    }

    /** Open the data channel sized to (cols,rows): the host resizes the PTY to this BEFORE the ring
     *  replay + live stream, so the first frame is already correctly sized. Idempotent — the first
     *  call wins; later size changes ride the session's control-channel Resize. The no-arg form
     *  (initial 80×24) is the fallback for a pane opened straight into a prompt, where the terminal
     *  never renders to be measured. */
    fun attach(cols: Int = initialCols, rows: Int = initialRows) {
        prepareSession()
        if (opened) return
        opened = true
        val session = _terminalSession.value!!
        viewModelScope.launch {
            val nonce = (controlConn.status.first { it is ConnStatus.Connected } as ConnStatus.Connected).sessionNonce
            val ch = channelFactory(nonce, cols, rows, viewModelScope)
            channel = ch
            jobs += launch { ch.output.collect { session.onOutput(it) } }
            jobs += launch { ch.status.collect { _status.value = it } }
            ch.start()
        }
    }

    fun detach() {
        jobs.forEach { it.cancel() }; jobs.clear()
        channel?.stop(); channel = null
        _terminalSession.value = null
        _status.value = DataStatus.Disconnected
        _prompt.value = null
        opened = false
    }

    override fun onCleared() { detach() }
}
