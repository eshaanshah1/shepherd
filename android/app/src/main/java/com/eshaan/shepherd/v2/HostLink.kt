package com.eshaan.shepherd.v2

import com.eshaan.shepherd.util.SLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.OutputStream
import java.net.Socket
import java.security.MessageDigest
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager
import java.util.concurrent.atomic.AtomicInteger

/**
 * One TLS connection to a Mac, speaking the v2 protocol.
 *
 * The shape it replaces had a control connection AND a data connection per pane,
 * each with its own message vocabulary. Here there is one framing, one decoder
 * and one socket: after the handshake the same connection carries control frames
 * (a device invoking commands) and session frames (attach, write, the pty's
 * bytes back). Fewer sockets is a side effect; the point is that there is one
 * protocol to keep in agreement with the host instead of two.
 *
 * **Trust is a pin, and nothing else.** The host is self-signed, so no CA can
 * vouch for it and the platform's verification would refuse every connection.
 * The trust manager below therefore accepts the chain and the PIN comparison is
 * the real check — which means it has to be written out, not implied by a flag.
 * A mismatch is terminal: it is a statement about identity rather than an
 * outage, so it must never be retried into a loop that keeps offering our secret
 * to whoever is answering. (v1 learned that one the hard way.)
 */
class HostLink(
    private val host: String,
    private val port: Int,
    /** Lowercase hex SHA-256 of the host certificate's DER. */
    private val expectedPin: String,
    private val scope: CoroutineScope,
    /**
     * Whether this link carries the SESSION protocol (the data path), as opposed
     * to only control frames.
     *
     * It exists because the session server refuses everything from a client that
     * has not greeted it — and the remote handshake is not that greeting. The
     * data link paired, connected, attached, and was answered `not-greeted`,
     * which this client dropped on the floor: a terminal that painted nothing,
     * with both links reporting healthy. Two handshakes on one socket is the
     * design; forgetting the second one is the bug.
     */
    private val speaksSessions: Boolean = false,
    private val connect: (String, Int) -> Socket = { h, p -> Socket(h, p) },
) {
    sealed interface State {
        data object Connecting : State
        /** Waiting for a human at the Mac to approve this device. */
        data object PendingApproval : State
        data class Ready(val deviceSecret: String?, val dataPort: Int? = null) : State
        data class Failed(val reason: String, val terminal: Boolean) : State
        data object Disconnected : State
    }

    private val _state = MutableStateFlow<State>(State.Disconnected)
    val state: StateFlow<State> = _state

    private val _frames = MutableSharedFlow<Frames.Frame>(extraBufferCapacity = 256)
    val frames: SharedFlow<Frames.Frame> = _frames

    private val json = Json { ignoreUnknownKeys = true }
    private val seq = AtomicInteger(1)
    private var socket: Socket? = null
    private var out: OutputStream? = null
    private var loop: Job? = null

    fun nextSeq(): Int = seq.getAndIncrement()

    /**
     * Opens the link and runs the handshake.
     *
     * [pairingCode] is for first contact only; [secret] is what a returning
     * device presents, and a device that has one must not send a code — the host
     * resolves a known device BEFORE it looks at any code, so sending both would
     * be harmless but meaningless.
     */
    fun start(deviceId: String, deviceName: String, pairingCode: String?, secret: String?) {
        if (loop != null) return
        loop = scope.launch(Dispatchers.IO) {
            /**
             * Reconnect, because a phone's socket dies constantly and none of it
             * is a fault.
             *
             * Locking the screen, switching from wifi to cellular, or Android
             * simply reclaiming a background socket all end this connection. The
             * previous shape ran the loop ONCE and then sat in
             * `Failed(terminal = false)` — whose UI text reads "— retrying" —
             * while doing nothing at all, so the way back was to force-quit the
             * app. Nothing had to be re-paired even then: the secret is on disk
             * and the host resolves a known device before it looks at a code.
             *
             * Two rules, both of which v1 paid for:
             *
             *   - **A terminal refusal is never retried.** A pin mismatch or a
             *     rejection is a statement about WHO answered, and retrying it
             *     is a loop that keeps offering our secret to whoever is
             *     listening. `break`, and say so.
             *   - **Backoff is capped and it resets on success.** v1 shipped a
             *     reconnect storm that produced perfectly correct states at four
             *     dials a second; its smoke test asserts a dial ceiling for
             *     exactly that reason.
             */
            var backoff = FIRST_RETRY_MS
            while (isActive) {
                val outcome = runOnce(deviceId, deviceName, pairingCode, secret)
                if (outcome == Outcome.TERMINAL) break
                if (!isActive) break
                if (outcome == Outcome.CLEAN) backoff = FIRST_RETRY_MS
                SLog.i(SLog.CONN, "reconnecting to $host:$port in ${backoff}ms")
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(MAX_RETRY_MS)
            }
            loop = null
        }
    }

    private enum class Outcome { CLEAN, RETRYABLE, TERMINAL }

    private suspend fun runOnce(
        deviceId: String,
        deviceName: String,
        pairingCode: String?,
        secret: String?,
    ): Outcome {
        return try {
                _state.value = State.Connecting
                val s = openPinned()
                socket = s
                out = s.getOutputStream()

                send(
                    Frames.json(
                        Frames.REMOTE_HELLO,
                        buildJsonObject {
                            put("deviceId", deviceId)
                            put("deviceName", deviceName)
                            put("protocolVersion", REMOTE_PROTOCOL_VERSION)
                            if (pairingCode != null) put("pairingCode", pairingCode)
                            if (secret != null) put("secret", secret)
                            // We enforced the pin during the handshake rather
                            // than learning it, so the Mac can skip asking a
                            // human to compare digits: a MITM was already
                            // refused, and asking anyway teaches people to
                            // confirm numbers they have not read.
                            put("pinVerified", true)
                        }.toString(),
                    ),
                )

                val input = s.getInputStream()
                val decoder = Frames.Decoder()
                val buffer = ByteArray(16 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read <= 0) break
                    for (frame in decoder.feed(buffer, read)) dispatch(frame)
                }
            // A refusal arrives on a connection that then closes normally, so
            // "the socket ended" is not enough to tell a rejection from a drop.
            val refused = _state.value.let { it is State.Failed && it.terminal }
            if (!refused) _state.value = State.Disconnected
            if (refused) Outcome.TERMINAL else Outcome.CLEAN
        } catch (e: PinMismatch) {
            // Terminal, and deliberately not retried: this is a claim about
            // WHO answered, not a network problem.
            SLog.e(SLog.CONN, "refusing $host:$port — ${e.message}")
            _state.value = State.Failed(e.message ?: "certificate refused", terminal = true)
            Outcome.TERMINAL
        } catch (e: Exception) {
            SLog.w(SLog.CONN, "link to $host:$port ended: ${e.message}")
            _state.value = State.Failed(e.message ?: "connection error", terminal = false)
            Outcome.RETRYABLE
        } finally {
            closeSocket()
        }
    }

    private fun dispatch(frame: Frames.Frame) {
        when (frame.kind) {
            Frames.REMOTE_ACCEPTED -> {
                val body = frame.text?.let { json.parseToJsonElement(it).jsonObject }
                val issued = body?.get("secret")?.jsonPrimitive?.content
                // Told to us on EVERY connect rather than remembered: the port
                // is the Mac's to choose, and a cached one is a terminal that
                // never paints.
                val dataPort = body?.get("dataPort")?.jsonPrimitive?.content?.toIntOrNull()
                SLog.i(SLog.CONN, "accepted by $host:$port (data port $dataPort)")
                // Before Ready, so nothing an observer sends can overtake it —
                // writes on one socket are ordered, and the server answers
                // `not-greeted` to anything that arrives first.
                if (speaksSessions) {
                    sendJson(
                        Frames.REQ_HELLO,
                        buildJsonObject {
                            put("seq", nextSeq())
                            put("version", Frames.SESSION_PROTOCOL_VERSION)
                        },
                    )
                }
                _state.value = State.Ready(issued, dataPort)
            }
            Frames.REMOTE_PENDING -> _state.value = State.PendingApproval
            Frames.REMOTE_REJECTED -> {
                val why = frame.text?.let {
                    json.parseToJsonElement(it).jsonObject["reason"]?.jsonPrimitive?.content
                } ?: "refused"
                // A refusal names ITSELF — "wrong pairing code", "expired",
                // "declined" are three different things to somebody holding a
                // phone, and collapsing them makes all three look like a typo.
                SLog.w(SLog.CONN, "refused by $host:$port — $why")
                _state.value = State.Failed(why, terminal = true)
            }
            // A refusal is not silence. This client used to drop error frames,
            // so the host's "send hello before anything else" arrived, was
            // discarded, and presented as a terminal that never painted.
            Frames.RES_ERR -> {
                SLog.w(SLog.DATA, "host refused a request: ${frame.text}")
                scope.launch { _frames.emit(frame) }
            }
            else -> scope.launch { _frames.emit(frame) }
        }
    }

    /** Invoke a command on the Mac. The answer arrives as a CONTROL_RESULT frame. */
    fun invoke(seqId: Int, command: String, args: JsonObject?) {
        send(
            Frames.json(
                Frames.CONTROL_INVOKE,
                buildJsonObject {
                    put("seq", seqId)
                    put("command", command)
                    if (args != null) put("args", args)
                }.toString(),
            ),
        )
    }

    fun sendJson(kind: Int, body: JsonObject) = send(Frames.json(kind, body.toString()))

    fun sendBytes(kind: Int, sessionId: String, payload: ByteArray) =
        send(Frames.bytes(kind, sessionId, payload))

    @Synchronized
    private fun send(frame: ByteArray) {
        val stream = out ?: return
        try {
            stream.write(frame)
            stream.flush()
        } catch (e: Exception) {
            SLog.w(SLog.CONN, "write failed: ${e.message}")
        }
    }

    /**
     * Test seam: kill the socket the way a screen lock does — from underneath,
     * with no protocol-level goodbye — leaving the retry loop running.
     */
    internal fun dropForTest() {
        closeSocket()
    }

    fun stop() {
        loop?.cancel()
        loop = null
        closeSocket()
        _state.value = State.Disconnected
    }

    private fun closeSocket() {
        runCatching { socket?.close() }
        socket = null
        out = null
    }

    class PinMismatch(message: String) : Exception(message)

    /**
     * TLS with the platform's trust decision replaced by ours.
     *
     * `checkServerTrusted` accepts, because there is no CA and refusing here
     * would refuse everything. The pin comparison after the handshake is the
     * verification, and it happens before a single byte of ours is written.
     */
    private fun openPinned(): Socket {
        val trustAll = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val context = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf(trustAll), java.security.SecureRandom())
        }
        val plain = connect(host, port)
        val tls = context.socketFactory.createSocket(plain, host, port, true) as SSLSocket
        tls.startHandshake()

        val peer = tls.session.peerCertificates.firstOrNull()
            ?: throw PinMismatch("the host presented no certificate")
        val actual = MessageDigest.getInstance("SHA-256").digest(peer.encoded)
            .joinToString("") { "%02x".format(it) }
        if (!actual.equals(expectedPin, ignoreCase = true)) {
            tls.close()
            throw PinMismatch("this is not the Mac we paired with")
        }
        return tls
    }

    companion object {
        /** Bumped on a breaking change; must match the host's. */
        const val REMOTE_PROTOCOL_VERSION = 3

        /** Short enough that unlocking a phone feels instant. */
        const val FIRST_RETRY_MS = 500L

        /** …and capped, so a Mac that is off does not get dialled forever. */
        const val MAX_RETRY_MS = 15_000L
    }
}
