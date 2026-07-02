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
    private val initialCols: Int = 80,
    private val initialRows: Int = 24,
    private val channelFactory: (nonce: String, scope: CoroutineScope) -> DataChannel =
        { nonce, scope -> DataChannel(host, port, nonce, paneId, initialCols, initialRows, scope) },
) : ViewModel() {
    private val _terminalSession = MutableStateFlow<RemoteTerminalSession?>(null)
    val terminalSession: StateFlow<RemoteTerminalSession?> = _terminalSession
    private val _status = MutableStateFlow<DataStatus>(DataStatus.Disconnected)
    val status: StateFlow<DataStatus> = _status

    private var channel: DataChannel? = null
    private val jobs = mutableListOf<Job>()

    fun attach() {
        if (channel != null) return
        viewModelScope.launch {
            val nonce = (controlConn.status.first { it is ConnStatus.Connected } as ConnStatus.Connected).sessionNonce
            val ch = channelFactory(nonce, viewModelScope)
            channel = ch
            val session = RemoteTerminalSession(
                initialCols, initialRows,
                channelInput = { ch.input(it) },
                resizeSink = { c, r -> controlConn.send(ControlMessage.Resize(paneId, c, r)) },
                scope = viewModelScope,
            )
            _terminalSession.value = session
            jobs += launch { ch.output.collect { session.onOutput(it) } }
            jobs += launch {
                ch.status.collect { st ->
                    _status.value = st
                    // Honor the host-authoritative grid: resize the emulator to what the host
                    // granted (no control-channel Resize echo — the size came from the host).
                    if (st is DataStatus.Ready) session.applyRemoteSize(st.cols, st.rows)
                }
            }
            ch.start()
        }
    }

    fun detach() {
        jobs.forEach { it.cancel() }; jobs.clear()
        channel?.stop(); channel = null
        _terminalSession.value = null
        _status.value = DataStatus.Disconnected
    }

    override fun onCleared() { detach() }
}
