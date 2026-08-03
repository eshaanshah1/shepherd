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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
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
    /** The nonce the current channel was built with, so a rebuild can tell a genuinely new
     *  session from the same one coming back. */
    private var lastNonce: String? = null
    private var graceJob: Job? = null
    private var rebuildJob: Job? = null
    /** How long a drop is held back before the UI shows it. Long enough to cover an unlock
     *  reattach, short enough that a real outage still reports promptly. */
    private val disconnectGraceMs = 900L
    /** How long a rejected channel waits for a DIFFERENT nonce before giving up and
     *  leaving it to the nonce-follower. Never a retry interval — see rebuildAfterRejection. */
    private val rebuildNonceTimeoutMs = 10_000L

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

    /** Build (or rebuild) the data channel for [nonce]. Tearing the old one down first keeps a
     *  revoked channel from double-writing into the same session. */
    private fun openChannel(nonce: String, session: RemoteTerminalSession) {
        channelJobs.forEach { it.cancel() }; channelJobs.clear()
        channel?.stop()
        lastNonce = nonce
        val ch = channelFactory(nonce, attachCols, attachRows, viewModelScope)
        channel = ch
        channelJobs += viewModelScope.launch { ch.output.collect { session.onOutput(it) } }
        channelJobs += viewModelScope.launch { ch.status.collect { publish(it, session) } }
        ch.start()
    }

    /**
     * Surface the channel's status, with two departures from passing it straight through.
     *
     * A brief drop is held back for [disconnectGraceMs] before it reaches the UI, because a
     * reattach that completes inside that window should look continuous rather than flash
     * "disconnected" — that flicker is the jitter, not a state worth rendering.
     *
     * And a channel that died terminally is rebuilt rather than left dead: `Rejected` stops
     * DataChannel's own retry loop for good (a revoked nonce is not worth retrying), so before
     * this the pane recovered only when the CONTROL connection produced a *different* nonce. When
     * the control session survived the lock, the nonce never changed, nothing rebuilt the dead
     * channel, and the only way back was leaving the session and re-entering it.
     */
    private fun publish(st: DataStatus, session: RemoteTerminalSession) {
        graceJob?.cancel(); graceJob = null
        when (st) {
            is DataStatus.Ready -> _status.value = st
            is DataStatus.Connecting ->
                // Don't advertise "connecting" over a live stream mid-reattach either.
                if (_status.value !is DataStatus.Ready) _status.value = st
            is DataStatus.Disconnected, is DataStatus.Rejected -> {
                graceJob = viewModelScope.launch {
                    delay(disconnectGraceMs)
                    _status.value = st
                }
                if (st is DataStatus.Rejected) rebuildAfterRejection(session)
            }
        }
    }

    /**
     * A rejected channel will never retry itself, so re-dial — but ONLY with a nonce we have not
     * already tried. A rejection means the host refused *that* nonce, so re-dialing the same one
     * just gets refused again, and rebuilding on a timer turned that into a connection attempt per
     * 250ms against the host (visible in its log as a TLS client every second). The recovery we
     * actually want is: wait for the control channel to produce a DIFFERENT nonce, then rebuild
     * once.
     */
    private fun rebuildAfterRejection(session: RemoteTerminalSession) {
        rebuildJob?.cancel()
        rebuildJob = viewModelScope.launch {
            controlConn.retryNow()   // no-op if the control session is live
            val fresh = withTimeoutOrNull(rebuildNonceTimeoutMs) {
                controlConn.status
                    .filterIsInstance<ConnStatus.Connected>()
                    .map { it.sessionNonce }
                    .first { it != lastNonce }
            } ?: return@launch        // nothing new to try; the nonce-follower will catch a later one
            openChannel(fresh, session)
        }
    }

    /**
     * The phone came back. Kick both channels instead of waiting out their backoff — this is what
     * makes unlocking resume immediately rather than up to `backoffMaxMs` later.
     */
    fun resume() {
        // Kick the DATA channel, which is what carries the stream, and leave the control channel
        // alone if it is up: its nonce is still valid to the host, so re-dialing data with the
        // same nonce restores streaming without a re-handshake. `retryNow` is a no-op on a live
        // control session by design — dropping it would revoke the nonce we are about to use.
        controlConn.retryNow()
        channel?.retryNow()
        val session = _terminalSession.value ?: return
        // A channel that was rejected will not retry itself, so it needs an explicit rebuild.
        if (channel == null || _status.value is DataStatus.Rejected) rebuildAfterRejection(session)
    }

    fun detach() {
        jobs.forEach { it.cancel() }; jobs.clear()
        channelJobs.forEach { it.cancel() }; channelJobs.clear()
        graceJob?.cancel(); graceJob = null
        rebuildJob?.cancel(); rebuildJob = null
        channel?.stop(); channel = null
        _terminalSession.value = null
        _status.value = DataStatus.Disconnected
        _prompt.value = null
        opened = false
    }

    override fun onCleared() { detach() }
}
