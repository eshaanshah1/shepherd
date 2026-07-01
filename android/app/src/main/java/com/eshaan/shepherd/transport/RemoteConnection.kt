package com.eshaan.shepherd.transport

import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.protocol.WireCodec
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import java.net.Socket
import java.io.OutputStream

sealed interface ConnStatus {
    data object Connecting : ConnStatus
    data object Pending : ConnStatus
    data class Connected(val sessionNonce: String) : ConnStatus
    data class Failed(val reason: String) : ConnStatus
    data object Disconnected : ConnStatus
}

class RemoteConnection(
    private val host: String,
    private val port: Int,
    private val helloFactory: () -> ControlMessage.Hello,
    private val scope: CoroutineScope,
    private val pingIntervalMs: Long = 20_000,
    private val backoffStartMs: Long = 1_000,
    private val backoffMaxMs: Long = 30_000,
    private val connect: (String, Int) -> Socket = { h, p -> Socket(h, p) },
) {
    private val _status = MutableStateFlow<ConnStatus>(ConnStatus.Disconnected)
    val status: StateFlow<ConnStatus> = _status
    private val _inbound = MutableSharedFlow<ControlMessage>(extraBufferCapacity = 64)
    val inbound: SharedFlow<ControlMessage> = _inbound

    private var loopJob: Job? = null
    @Volatile private var socket: Socket? = null
    @Volatile private var out: OutputStream? = null
    @Volatile private var running = false

    fun start() {
        if (loopJob != null) return
        running = true
        loopJob = scope.launch(Dispatchers.IO) {
            var backoff = backoffStartMs
            while (running && isActive) {
                try {
                    runSession()
                    backoff = backoffStartMs            // a clean session resets backoff
                } catch (_: CancellationException) {
                    throw CancellationException()
                } catch (e: Exception) {
                    _status.value = ConnStatus.Failed(e.message ?: "connection error")
                }
                if (!running) break
                _status.value = ConnStatus.Disconnected
                delay(backoff); backoff = (backoff * 2).coerceAtMost(backoffMaxMs)
            }
        }
    }

    private suspend fun runSession() = coroutineScope {
        _status.value = ConnStatus.Connecting
        val s = connect(host, port); socket = s; out = s.getOutputStream()
        try {
            sendRaw(helloFactory())
            val heartbeat = launch { while (isActive) { delay(pingIntervalMs); runCatching { sendRaw(ControlMessage.Ping) } } }
            val ins = s.getInputStream(); val dec = WireCodec.Decoder(); val buf = ByteArray(8192)
            while (isActive) {
                val n = ins.read(buf); if (n <= 0) break
                for (m in dec.feed(buf.copyOf(n))) {
                    when (m) {
                        is ControlMessage.PendingApproval -> _status.value = ConnStatus.Pending
                        is ControlMessage.Accepted -> _status.value = ConnStatus.Connected(m.sessionNonce)
                        is ControlMessage.Rejected -> { _status.value = ConnStatus.Failed(m.reason); running = false }
                        else -> {}
                    }
                    _inbound.emit(m)
                }
            }
            heartbeat.cancel()
        } finally { closeSocket() }
    }

    /** Enqueue any message; serialized on the IO dispatcher. */
    fun send(msg: ControlMessage) { scope.launch(Dispatchers.IO) { runCatching { sendRaw(msg) } } }

    @Synchronized private fun sendRaw(msg: ControlMessage) {
        val o = out ?: return; o.write(WireCodec.encode(msg)); o.flush()
    }

    private fun closeSocket() { runCatching { socket?.close() }; socket = null; out = null }

    fun stop() {
        running = false
        loopJob?.cancel(); loopJob = null
        _status.value = ConnStatus.Disconnected
        // Best-effort graceful Detach + close, off the caller's thread: java.net.Socket has
        // no write timeout, so a stalled/dead peer must never block a UI thread here (real
        // call sites are FleetViewModel.disconnect()/refresh() and onCleared, both on main).
        Thread {
            runCatching { sendRaw(ControlMessage.Detach) }
            closeSocket()
        }.apply { isDaemon = true; start() }
    }
}
