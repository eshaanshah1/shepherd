package com.eshaan.shepherd.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.terminal.RemoteTerminalSession
import com.eshaan.shepherd.transport.ConnStatus
import com.eshaan.shepherd.transport.DataChannel
import com.eshaan.shepherd.transport.Pinning
import com.eshaan.shepherd.transport.DataStatus
import com.eshaan.shepherd.transport.RemoteConnection
import com.eshaan.shepherd.util.SLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.map
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
    /** Base64 cert pin when this host was paired over the LAN; null on the tailnet. The data
     *  channel carries PTY bytes — keystrokes — so it must be pinned exactly like the control one. */
    private val lanPin: String? = null,
    val initialCols: Int = 80,
    val initialRows: Int = 24,
    private val channelFactory: (nonce: String, cols: Int, rows: Int, scope: CoroutineScope) -> DataChannel =
        { nonce, cols, rows, scope ->
            DataChannel(host, port, nonce, paneId, cols, rows, scope,
                        connect = Pinning.connector(lanPin))
        },
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
    /** Collectors owned by the CURRENT data channel — cancelled and rebuilt on every new nonce,
     *  separately from [jobs] so a rebuild doesn't tear down the prompt collector. */
    private val channelJobs = mutableListOf<Job>()
    /** The measured grid [attach] opened at; a rebuilt channel reuses it so a reconnect doesn't
     *  reshape the pane back to the 80×24 default. */
    private var attachCols = initialCols
    private var attachRows = initialRows
    @Volatile private var opened = false
    private var graceJob: Job? = null
    /** How long a drop is held back before the UI shows it. Long enough to cover an unlock
     *  reattach, short enough that a real outage still reports promptly. */
    private val disconnectGraceMs = 900L

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
        attachCols = cols; attachRows = rows
        val session = _terminalSession.value!!
        // FOLLOW the control connection's nonce rather than taking the first one. A nonce dies
        // with its control session, and locking the phone kills that socket; on unlock the
        // control channel reconnects and the host mints a new nonce while revoking the old. A
        // DataChannel still holding the old one is answered with dataRejected, which stops its
        // retry loop for good — the pane then stays dead until the screen is rebuilt.
        jobs += viewModelScope.launch {
            controlConn.status
                .filterIsInstance<ConnStatus.Connected>()
                .map { it.sessionNonce }
                .distinctUntilChanged()
                .collect { nonce -> openChannel(nonce, session) }
        }
    }

    /**
     * THE only place a data channel is created, and reconnection's single owner. Callers state a
     * fact — "this nonce is live now" — and never an action; within one nonce, retrying is
     * [DataChannel]'s own business. Two components both deciding when to dial is what turned a
     * dropped socket into a reconnect storm.
     *
     * Tearing the old one down first keeps a revoked channel from double-writing into the session.
     */
    private fun openChannel(nonce: String, session: RemoteTerminalSession) {
        channelJobs.forEach { it.cancel() }; channelJobs.clear()
        channel?.stop()
        val ch = channelFactory(nonce, attachCols, attachRows, viewModelScope)
        channel = ch
        channelJobs += viewModelScope.launch { ch.output.collect { session.onOutput(it) } }
        channelJobs += viewModelScope.launch { ch.status.collect { publish(it) } }
        ch.start()
    }

    /**
     * Surface the channel's status. The only departure from passing it straight through: a brief
     * drop is held back for [disconnectGraceMs], because a reattach that completes inside that
     * window should look continuous rather than flash "disconnected" — that flicker is the jitter,
     * not a state worth rendering.
     *
     * Deliberately does NOT reconnect. Reconnection has exactly one owner (see [openChannel]).
     */
    private fun publish(st: DataStatus) {
        graceJob?.cancel(); graceJob = null
        when (st) {
            is DataStatus.Ready -> _status.value = st
            // Don't advertise "connecting" over a live stream mid-reattach either.
            is DataStatus.Connecting -> if (_status.value !is DataStatus.Ready) _status.value = st
            is DataStatus.Disconnected, is DataStatus.Rejected ->
                graceJob = viewModelScope.launch { delay(disconnectGraceMs); _status.value = st }
        }
    }

    /**
     * The phone came back. A HINT, not a second connection path: it resets the channel's backoff
     * so a reattach happens now instead of up to `backoffMaxMs` later, and asks the control
     * connection to reconnect only if it is actually down (`retryNow` no-ops on a live session —
     * dropping it would revoke the nonce the data channel is using).
     *
     * It must never dial or rebuild. A second retry path composing with the channel's own loop is
     * what produced a connection to the host every ~250ms.
     */
    fun resume() {
        SLog.i(SLog.VM, "resume (foreground) pane $paneId status=${_status.value}")
        controlConn.retryNow()
        channel?.retryNow()
    }

    fun detach() {
        jobs.forEach { it.cancel() }; jobs.clear()
        channelJobs.forEach { it.cancel() }; channelJobs.clear()
        graceJob?.cancel(); graceJob = null
        channel?.stop(); channel = null
        _terminalSession.value = null
        _status.value = DataStatus.Disconnected
        _prompt.value = null
        opened = false
    }

    override fun onCleared() { detach() }
}
