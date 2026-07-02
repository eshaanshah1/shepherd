package com.eshaan.shepherd.transport

import com.eshaan.shepherd.protocol.DataMessage
import com.eshaan.shepherd.protocol.DataWireCodec
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import java.io.OutputStream
import java.net.Socket

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
                    runSession()
                    backoff = backoffStartMs
                } catch (_: CancellationException) {
                    throw CancellationException()
                } catch (e: Exception) {
                    _status.value = DataStatus.Rejected(e.message ?: "data channel error")
                }
                if (!running) break
                _status.value = DataStatus.Disconnected
                delay(backoff); backoff = (backoff * 2).coerceAtMost(backoffMaxMs)
            }
        }
    }

    private suspend fun runSession() {
        _status.value = DataStatus.Connecting
        ready = false
        val s = connect(host, port); socket = s; out = s.getOutputStream()
        try {
            sendRaw(DataWireCodec.encode(DataMessage.DataHello(sessionNonce, paneId, initialCols, initialRows)))
            val ins = s.getInputStream(); val buf = ByteArray(8192)
            val dec = DataWireCodec.Decoder()
            // Handshake: decode EXACTLY one frame; its untouched tail is the first raw output (the
            // ready frame and the first PTY bytes routinely coalesce into one read).
            handshake@ while (!ready) {
                val n = ins.read(buf); if (n <= 0) return
                val (m, tail) = dec.feedOne(buf.copyOf(n))
                if (m == null) continue
                when (m) {
                    is DataMessage.DataReady -> {
                        _status.value = DataStatus.Ready(m.cols, m.rows); ready = true
                        if (tail.isNotEmpty()) _output.emit(tail)
                    }
                    is DataMessage.DataRejected -> { _status.value = DataStatus.Rejected(m.reason); running = false; return }
                    else -> { _status.value = DataStatus.Rejected("unexpected handshake frame"); return }
                }
            }
            while (true) {
                val n = ins.read(buf); if (n <= 0) break
                _output.emit(buf.copyOf(n))
            }
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
