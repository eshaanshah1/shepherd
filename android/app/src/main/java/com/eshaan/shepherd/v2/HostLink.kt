package com.eshaan.shepherd.v2

import com.eshaan.shepherd.util.SLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
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
import org.json.JSONArray
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
 * **Trust has two layers now, and both are written out.** The transport layer is
 * still a pin: the host is self-signed, so no CA can vouch for it and the
 * platform's verification would refuse every connection — the trust manager
 * below accepts the chain and the PIN COMPARISON is the real check. On top of
 * that sits the net: the host returns its own credential chain and a signature
 * over the nonce this phone chose, so "I reached a member of my net" is proven
 * rather than assumed from an address. A failure of either is terminal — it is a
 * statement about WHO answered rather than an outage, and retrying it is a loop
 * that keeps talking to whoever is listening. (v1 learned that one the hard way.)
 */
class HostLink(
    private val host: String,
    private val port: Int,
    /**
     * Lowercase hex SHA-256 of the host certificate's DER, when it is known.
     *
     * **Null is the ordinary case for a member dialled out of the roster**, and
     * it is not a weaker check — it is a different one. A join link carries a pin
     * because there is no membership yet to reason about. Afterwards the net
     * answers the question: the Mac returns its own credential, that credential
     * NAMES the certificate it serves on, and this phone compares it to the one
     * actually presented. So the certificate is still bound; the binding is just
     * signed by the net instead of copied off a QR.
     */
    private val expectedPin: String?,
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
        /**
         * Admitted. [issued] is present only on a JOIN — a returning member
         * already holds its chain and would gain nothing from a copy.
         */
        data class Ready(
            val issued: Membership? = null,
            val dataPort: Int? = null,
            /**
             * Everyone else in the net, as this Mac knows them.
             *
             * Sent on EVERY connect, which is what makes "you never scan twice"
             * true: a second Mac is a row in this list, not another QR.
             */
            val roster: List<RosterEntry> = emptyList(),
        ) : State
        data class Failed(val reason: String, val terminal: Boolean) : State
        data object Disconnected : State
    }

    private val _state = MutableStateFlow<State>(State.Disconnected)
    val state: StateFlow<State> = _state

    private val _frames = MutableSharedFlow<Frames.Frame>(extraBufferCapacity = 256)
    val frames: SharedFlow<Frames.Frame> = _frames

    private val json = Json { ignoreUnknownKeys = true }
    private val seq = AtomicInteger(1)

    /**
     * The key pair a JOIN will be issued over, minted once and kept for the life
     * of this link.
     *
     * Not per attempt: the Mac issues a credential describing whatever key the
     * hello carried, so minting a second one between the hello and the accept
     * would leave a membership for a key this phone no longer has — and the
     * symptom is every Mac refusing a phone that believes it just joined.
     */
    private var pendingKey: MemberKey? = null

    /** The nonce this phone sent, which the host must sign back. */
    private var lastNonce: String? = null

    /** `(netId, rootPublicKey)` for the net this attempt is about. */
    private var netContext: Pair<String, String>? = null

    /** The certificate this connection actually presented, as a pin. */
    private var observedPin: String = ""

    private var socket: Socket? = null
    private var out: OutputStream? = null
    private var loop: Job? = null

    fun nextSeq(): Int = seq.getAndIncrement()

    /**
     * Opens the link and runs the handshake.
     *
     * [joining] carries the facts from a join link and is for FIRST CONTACT only;
     * [membership] is what a member presents every time after. A device that has
     * a membership must not send a code — the host resolves a member BEFORE it
     * looks at any code, so sending both would be harmless but meaningless.
     */
    fun start(
        deviceId: String,
        deviceName: String,
        joining: JoinFacts?,
        membership: Membership?,
    ) {
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
                val outcome = runOnce(deviceId, deviceName, joining, membership)
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
        joining: JoinFacts?,
        membership: Membership?,
    ): Outcome {
        return try {
                _state.value = State.Connecting
                val s = openPinned()
                socket = s
                out = s.getOutputStream()

                /**
                 * The key this phone signs with.
                 *
                 * A member uses the one its chain names — using any other would
                 * make the chain unprovable. A joiner mints one, and it is minted
                 * ONCE per attempt and kept in [pendingKey] so the credential the
                 * Mac issues describes the key we still hold; minting per frame
                 * would produce a membership for a key thrown away moments later.
                 */
                val key = membership?.memberKey ?: pendingKey ?: NetCrypto.generateMemberKey().also {
                    pendingKey = it
                }
                val nonce = newNonce()
                lastNonce = nonce
                netContext = membership?.let { it.netId to it.rootPublicKey }
                    ?: joining?.let { it.netId to it.rootPublicKey }

                send(
                    Frames.json(
                        Frames.REMOTE_HELLO,
                        buildJsonObject {
                            put("deviceId", deviceId)
                            put("deviceName", deviceName)
                            put("protocolVersion", REMOTE_PROTOCOL_VERSION)
                            put("publicKey", key.publicKey)
                            // This phone serves nothing, so it has no certificate
                            // for anybody to reach it by. Said explicitly rather
                            // than omitted: a member that serves DOES carry one,
                            // and the empty string is the honest value here.
                            put("certPin", "")
                            put("nonce", nonce)
                            if (membership != null) {
                                put("chain", json.parseToJsonElement(
                                    Credential.listToJson(membership.chain).toString(),
                                ))
                                /**
                                 * Possession of the key the chain names. The chain
                                 * itself is public — it reaches every member — so
                                 * without this, presenting a copy of somebody
                                 * else's would be enough.
                                 */
                                val at = System.currentTimeMillis()
                                put("proof", buildJsonObject {
                                    put("at", at)
                                    put(
                                        "signature",
                                        NetCrypto.sign(
                                            key.privateKey,
                                            Net.proofBytes(membership.netId, observedPin, at),
                                        ),
                                    )
                                })
                            } else if (joining?.code != null) {
                                put("pairingCode", joining.code)
                            }
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
                // Told to us on EVERY connect rather than remembered: the port
                // is the Mac's to choose, and a cached one is a terminal that
                // never paints.
                val dataPort = body?.get("dataPort")?.jsonPrimitive?.content?.toIntOrNull()

                /**
                 * The Mac has to prove itself too, and this is where.
                 *
                 * Under a net the pin alone no longer answers "is this the right
                 * Mac" — it answers "is this the certificate I was handed", which
                 * says nothing about membership. So the host returns its own
                 * chain and a signature over the nonce we just sent, and a
                 * failure here is TERMINAL: something answered on that address
                 * holding a certificate we were told to expect and could not
                 * prove it belongs to the net. That is not an outage.
                 */
                val refusal = body?.let { checkHost(it) }
                if (refusal != null) {
                    SLog.e(SLog.CONN, "refusing $host:$port — $refusal")
                    _state.value = State.Failed(refusal, terminal = true)
                    closeSocket()
                    return
                }
                val issued = body?.let { adopt(it) }
                val roster = body?.get("roster")?.let {
                    runCatching { RosterEntry.listFromJson(JSONArray(it.toString())) }.getOrNull()
                } ?: emptyList()
                SLog.i(SLog.CONN, "accepted by $host:$port (data port $dataPort, ${roster.size} members)")
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
                _state.value = State.Ready(issued, dataPort, roster)
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

    /**
     * Did a member of the right net answer, holding the key its chain names?
     *
     * Returns the refusal, or null when the host checks out — so a caller cannot
     * read "no reason" as "no answer". Every branch here is terminal: an address
     * that answers with an unprovable membership is not a network problem.
     */
    private fun checkHost(body: JsonObject): String? {
        val netId = body["netId"]?.jsonPrimitive?.content ?: return "the Mac named no net"
        val root = body["rootPublicKey"]?.jsonPrimitive?.content
            ?: return "the Mac sent no root key for its net"

        // The id and the key check each other, so neither can be swapped alone.
        if (!NetCrypto.netIdOf(root).equals(netId, ignoreCase = true)) {
            return "that net's id does not match the key it was sent with"
        }
        // A member must not be talked into another net by the Mac it dialled.
        netContext?.let { (expectedNet, expectedRoot) ->
            if (!netId.equals(expectedNet, ignoreCase = true) || root != expectedRoot) {
                return "that Mac belongs to a different net"
            }
        }

        val hostChain = body["hostChain"]?.let {
            runCatching { Credential.listFromJson(JSONArray(it.toString())) }.getOrNull()
        } ?: return "the Mac sent no membership of its own"
        Net.verifyChain(hostChain, netId, root, emptySet())?.let { return it }

        val nonce = lastNonce ?: return "no nonce was sent for the Mac to sign"
        val proof = body["proof"]?.jsonPrimitive?.content
            ?: return "the Mac did not prove it holds its own key"
        val leaf = hostChain.first()
        if (!NetCrypto.verify(leaf.publicKey, Net.hostProofBytes(netId, nonce), proof)) {
            return "the Mac could not prove it holds the key its membership names"
        }

        /**
         * The credential names the certificate this member serves on, so it must
         * be the one we just negotiated.
         *
         * This is what makes dialling out of the roster safe with no pin in hand:
         * without it, anything that answered on that address and held a valid
         * member chain could serve us under its own certificate. A member that
         * serves nothing carries an empty pin and cannot be dialled anyway.
         */
        if (leaf.certPin.isNotEmpty() && !leaf.certPin.equals(observedPin, ignoreCase = true)) {
            return "that Mac's certificate is not the one its membership names"
        }
        return null
    }

    /**
     * A membership the Mac just issued — present only on a join.
     *
     * Adopted over the key minted for THIS link, and verified before it is kept:
     * a chain that does not check out is not a membership, and storing one would
     * mean a phone that believes it joined and is refused everywhere.
     */
    private fun adopt(body: JsonObject): Membership? {
        val chainJson = body["chain"] ?: return null
        val chain = runCatching { Credential.listFromJson(JSONArray(chainJson.toString())) }
            .getOrNull() ?: return null
        val key = pendingKey ?: return null
        val netId = body["netId"]?.jsonPrimitive?.content ?: return null
        val root = body["rootPublicKey"]?.jsonPrimitive?.content ?: return null

        if (Net.verifyChain(chain, netId, root, emptySet()) != null) {
            SLog.e(SLog.PAIR, "the Mac issued a membership that does not check out")
            return null
        }
        if (chain.first().publicKey != key.publicKey) {
            // It describes a key we do not hold, so it could never be proven.
            SLog.e(SLog.PAIR, "the Mac issued a membership for another key")
            return null
        }
        return Membership(
            netId = netId,
            netName = body["netName"]?.jsonPrimitive?.content ?: "",
            rootPublicKey = root,
            memberId = chain.first().memberId,
            memberKey = key,
            chain = chain,
        )
    }

    /** Random, and the host signs it back — so its answer cannot be a recording. */
    private fun newNonce(): String {
        val bytes = ByteArray(16)
        java.security.SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
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

    /**
     * Frames out, on the IO thread, in order.
     *
     * **Android throws `NetworkOnMainThreadException` for a socket write from
     * the UI thread**, and every write this client makes originates there: a
     * keystroke, the compose row, a viewport when the screen mounts. Writing
     * directly cost the terminal all of its input — the exception was caught,
     * logged as `write failed: null` (most socket failures carry no message),
     * and the terminal simply did nothing, which reads like a dead connection
     * rather than a threading rule.
     *
     * A queue rather than a coroutine per frame, because ORDER is the whole
     * contract on this path: keystrokes must arrive in the sequence they were
     * typed, and `launch` per write hands that to the scheduler. One consumer,
     * one socket, one order.
     */
    private val outbox = Channel<ByteArray>(capacity = Channel.UNLIMITED)

    private val pump = scope.launch(Dispatchers.IO) {
        for (frame in outbox) {
            val stream = out
            if (stream == null) {
                // Said out loud rather than dropped in silence: a frame written
                // before the socket exists is how an attach went missing once.
                SLog.w(SLog.CONN, "dropped a frame for $host:$port — not connected")
                continue
            }
            try {
                stream.write(frame)
                stream.flush()
            } catch (e: Exception) {
                // The CLASS, not just the message: `Exception.message` is null
                // for most socket failures, so logging it alone names nothing.
                SLog.w(SLog.CONN, "write to $host:$port failed: ${e.javaClass.simpleName}: ${e.message}")
            }
        }
    }

    private fun send(frame: ByteArray) {
        outbox.trySend(frame)
    }

    /**
     * Test seam: kill the socket the way a screen lock does — from underneath,
     * with no protocol-level goodbye — leaving the retry loop running.
     */
    internal fun dropForTest() {
        closeSocket()
    }

    fun stop() {
        pump.cancel()
        outbox.close()
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
        val pinned = expectedPin
        if (pinned != null && !actual.equals(pinned, ignoreCase = true)) {
            tls.close()
            throw PinMismatch("this is not the Mac we paired with")
        }
        // Learned, not trusted: `checkHost` refuses unless the Mac's own
        // credential names this very certificate.
        observedPin = actual
        return tls
    }

    companion object {
        /**
         * Bumped on a breaking change; must match the host's.
         *
         * 4 is shep-nets: the handshake carries a membership chain and a proof
         * rather than a host-issued secret. A Mac on 3 and a phone on 4 refuse
         * each other by NAME — both versions in one message — rather than
         * failing somewhere further in.
         */
        const val REMOTE_PROTOCOL_VERSION = 4

        /** Short enough that unlocking a phone feels instant. */
        const val FIRST_RETRY_MS = 500L

        /** …and capped, so a Mac that is off does not get dialled forever. */
        const val MAX_RETRY_MS = 15_000L
    }
}
