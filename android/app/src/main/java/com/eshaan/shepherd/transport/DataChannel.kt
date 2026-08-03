package com.eshaan.shepherd.transport

import com.eshaan.shepherd.protocol.DataMessage
import com.eshaan.shepherd.protocol.DataWireCodec
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import java.io.OutputStream
import java.net.Socket
import com.eshaan.shepherd.util.SLog

sealed interface DataStatus {
    data object Connecting : DataStatus
    data class Ready(val cols: Int, val rows: Int) : DataStatus
    data class Rejected(val reason: String) : DataStatus
    data object Disconnected : DataStatus
}

/**
 * Raw-duplex PTY data client. Connects, sends a sized [DataMessage.DataHello], reads exactly the
 * first [DataMessage.DataReady]/[DataMessage.DataRejected] frame, then switches to raw bytes: any
 * tail the decoder left after the ready frame is the first raw output (the ready frame and the
 * first PTY bytes can coalesce in one read). Resize never travels here — it goes on the control
 * channel. Reconnect/backoff + off-thread stop mirror [RemoteConnection]'s discipline.
 */
class DataChannel(
    private val host: String,
    private val port: Int,
    private val sessionNonce: String,
    private val paneId: String,
    private val initialCols: Int,
    private val initialRows: Int,
    private val scope: CoroutineScope,
    private val backoffStartMs: Long = 1_000,
    private val backoffMaxMs: Long = 30_000,
    private val connect: (String, Int) -> Socket = { h, p -> Socket(h, p) },
) {
    private val _status = MutableStateFlow<DataStatus>(DataStatus.Disconnected)
    val status: StateFlow<DataStatus> = _status
    private val _output = MutableSharedFlow<ByteArray>(extraBufferCapacity = 256)
    val output: SharedFlow<ByteArray> = _output

    private var loopJob: Job? = null
    private var writerJob: Job? = null
    private val inputCh = Channel<ByteArray>(Channel.UNLIMITED)
    /** CONFLATED: many kicks while waiting collapse to one retry, and a kick sent while connected
     *  is simply the next wait's head start rather than a queue of reconnects. */
    private val kick = Channel<Unit>(Channel.CONFLATED)
    @Volatile private var socket: Socket? = null
    @Volatile private var out: OutputStream? = null
    @Volatile private var ready = false
    @Volatile private var running = false

    fun start() {
        if (loopJob != null) return
        running = true
        // One writer coroutine drains the input channel in FIFO order — a coroutine per input()
        // call could reorder keystrokes on the wire.
        writerJob = scope.launch(Dispatchers.IO) {
            for (b in inputCh) runCatching { sendRaw(b) }
        }
        loopJob = scope.launch(Dispatchers.IO) {
            var backoff = backoffStartMs
            while (running && isActive) {
                try {
                    // Reset the backoff only for a session that actually WORKED. runSession
                    // returns normally when the host closes before answering the handshake, and
                    // treating that as success reset the backoff to 1s every time — a connection
                    // per second, forever, at a rate that never grew. A host that hangs up on us
                    // is exactly the case backoff exists for.
                    if (runSession()) backoff = backoffStartMs
                    else SLog.w(SLog.DATA, "session ended without a handshake; backoff stays ${backoff}ms")
                } catch (_: CancellationException) {
                    throw CancellationException()
                } catch (e: Exception) {
                    // A transport failure is TRANSIENT and this loop already retries it. It must
                    // not report `Rejected`, which means "the host refused this nonce" and is the
                    // signal the view model rebuilds on — conflating the two turned every dropped
                    // socket into a rebuild, i.e. a new TLS connection to the host every ~250ms.
                    SLog.w(SLog.DATA, "transport error for pane $paneId: ${e.message}")
                    _status.value = DataStatus.Disconnected
                }
                if (!running) break
                _status.value = DataStatus.Disconnected
                // Interruptible: locking the phone kills the socket and the backoff then doubles
                // its way to backoffMaxMs while the screen is off, so on unlock the next attempt
                // could be half a minute away — which read as "streaming is broken until I leave
                // the session and come back". `retryNow()` collapses that wait to nothing.
                SLog.d(SLog.DATA, "retrying pane $paneId in ${backoff}ms")
                if (waitForRetry(backoff)) backoff = backoffStartMs
                else backoff = (backoff * 2).coerceAtMost(backoffMaxMs)
            }
        }
    }

    /** Suspend up to [ms], returning true if [retryNow] woke us instead of the timeout. */
    private suspend fun waitForRetry(ms: Long): Boolean =
        withTimeoutOrNull(ms) { kick.receive(); true } ?: false

    /** Reconnect immediately and reset the backoff — call this when the phone unlocks. Safe to
     *  call when already connected: a queued kick is only consumed while waiting to retry. */
    fun retryNow() { kick.trySend(Unit) }

    /** Returns true only if the handshake completed — i.e. this attempt is evidence the host is
     *  willing to serve us, and the backoff may reset. Every early return is a refusal. */
    private suspend fun runSession(): Boolean {
        _status.value = DataStatus.Connecting
        ready = false
        SLog.i(SLog.DATA, "dialling $host:$port for pane $paneId nonce=${sessionNonce.take(8)}")
        val s = connect(host, port); socket = s; out = s.getOutputStream()
        try {
            sendRaw(DataWireCodec.encode(DataMessage.DataHello(sessionNonce, paneId, initialCols, initialRows)))
            val ins = s.getInputStream(); val buf = ByteArray(8192)
            val dec = DataWireCodec.Decoder()
            // Handshake: decode EXACTLY one frame; its untouched tail is the first raw output (the
            // ready frame and the first PTY bytes routinely coalesce into one read).
            handshake@ while (!ready) {
                val n = ins.read(buf); if (n <= 0) return false   // hung up on before answering
                val (m, tail) = dec.feedOne(buf.copyOf(n))
                if (m == null) continue
                when (m) {
                    is DataMessage.DataReady -> {
                        SLog.i(SLog.DATA, "READY pane $paneId at ${m.cols}x${m.rows}")
                        _status.value = DataStatus.Ready(m.cols, m.rows); ready = true
                        if (tail.isNotEmpty()) _output.emit(tail)
                    }
                    is DataMessage.DataRejected -> {
                        SLog.e(SLog.DATA, "host REFUSED pane $paneId: ${m.reason}")
                        _status.value = DataStatus.Rejected(m.reason); running = false; return false
                    }
                    else -> { _status.value = DataStatus.Rejected("unexpected handshake frame"); return false }
                }
            }
            while (true) {
                val n = ins.read(buf); if (n <= 0) break
                _output.emit(buf.copyOf(n))
            }
            return true
        } finally { closeSocket() }
    }

    /** Raw PTY bytes → host, FIFO via the single writer coroutine. No-op until [DataStatus.Ready]. */
    fun input(bytes: ByteArray) {
        if (!ready) return
        inputCh.trySend(bytes)
    }

    @Synchronized private fun sendRaw(bytes: ByteArray) {
        val o = out ?: return; o.write(bytes); o.flush()
    }

    private fun closeSocket() { runCatching { socket?.close() }; socket = null; out = null; ready = false }

    fun stop() {
        running = false
        loopJob?.cancel(); loopJob = null
        writerJob?.cancel(); writerJob = null
        _status.value = DataStatus.Disconnected
        Thread { closeSocket() }.apply { isDaemon = true; start() }
    }
}
