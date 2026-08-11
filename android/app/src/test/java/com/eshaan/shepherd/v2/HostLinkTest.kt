package com.eshaan.shepherd.v2

import com.eshaan.shepherd.transport.Pinning
import kotlin.concurrent.thread
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyStore
import java.security.cert.X509Certificate
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket

/**
 * What this link says, and what it demands back, against a real TLS server.
 *
 * Two things are pinned here and neither can be asserted without a socket. The
 * first is ORDER: the data link once paired, connected and attached while the
 * host answered `not-greeted` to everything, because the session server's own
 * hello had never been sent — both links reported healthy and the terminal
 * painted nothing. The second is the net handshake: the host is a real member
 * here, with a real root key and real signatures, so "the phone verifies the Mac"
 * is exercised rather than asserted.
 */
class HostLinkTest {

    /** The net the fake host belongs to. Real keys, real signatures. */
    private val rootKey = NetCrypto.generateMemberKey()
    private val hostKey = NetCrypto.generateMemberKey()
    private val netId = NetCrypto.netIdOf(rootKey.publicKey)
    private val hostChain by lazy {
        listOf(
            Net.issue(
                netId = netId,
                epoch = 1,
                memberId = "mac-mini",
                name = "Mac mini",
                publicKey = hostKey.publicKey,
                certPin = pin(),
                issuedAt = 0,
                issuer = Net.ROOT,
                privateKey = rootKey.privateKey,
            ),
        )
    }

    /** A membership for this phone, as the Mac would have issued it. */
    private fun membershipFor(key: MemberKey) = Membership(
        netId = netId,
        netName = "Test net",
        rootPublicKey = rootKey.publicKey,
        memberId = "phone",
        memberKey = key,
        chain = listOf(
            Net.issue(
                netId = netId,
                epoch = 1,
                memberId = "phone",
                name = "A phone",
                publicKey = key.publicKey,
                certPin = "",
                issuedAt = 0,
                issuer = "mac-mini",
                privateKey = hostKey.privateKey,
            ),
        ) + hostChain,
    )

    private fun keyStore(): KeyStore {
        val ks = KeyStore.getInstance("PKCS12")
        javaClass.classLoader!!.getResourceAsStream("lan-test-identity.p12").use {
            ks.load(it, "shepherd".toCharArray())
        }
        return ks
    }

    private fun pin(): String {
        val ks = keyStore()
        val alias = ks.aliases().toList().first()
        return Pinning.certHash(ks.getCertificate(alias) as X509Certificate)
            .joinToString("") { "%02x".format(it) }
    }

    /**
     * A host that admits anybody and records the frames it is sent.
     *
     * It answers `REMOTE_ACCEPTED` to the first frame and then just listens —
     * enough to reach the state where a real client starts speaking the session
     * protocol, which is the whole thing under test. [proves] is what a
     * misbehaving Mac looks like: everything else identical, no signature over
     * the phone's nonce.
     */
    private fun startHost(
        received: MutableList<Frames.Frame>,
        proves: Boolean = true,
    ): SSLServerSocket {
        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
        kmf.init(keyStore(), "shepherd".toCharArray())
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(kmf.keyManagers, null, null)
        val server = ctx.serverSocketFactory.createServerSocket(0) as SSLServerSocket
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (_: Exception) { break }
                thread(isDaemon = true) {
                    runCatching {
                        val decoder = Frames.Decoder()
                        val input = socket.getInputStream()
                        val buffer = ByteArray(8 * 1024)
                        var admitted = false
                        while (true) {
                            val read = input.read(buffer)
                            if (read <= 0) break
                            for (frame in decoder.feed(buffer, read)) {
                                synchronized(received) { received.add(frame) }
                                if (!admitted) {
                                    admitted = true
                                    socket.getOutputStream().write(
                                        Frames.json(Frames.REMOTE_ACCEPTED, accept(frame, proves)),
                                    )
                                    socket.getOutputStream().flush()
                                }
                            }
                        }
                    }
                    runCatching { socket.close() }
                }
            }
        }
        return server
    }

    /**
     * The accept, built the way the Mac builds it: the net's facts, the host's
     * own chain, a signature over the nonce the phone chose, and — for a phone
     * with no membership — a credential over the key it presented.
     */
    private fun accept(hello: Frames.Frame, proves: Boolean): String {
        val body = Json.parseToJsonElement(hello.text ?: "{}").jsonObject
        val nonce = body["nonce"]?.jsonPrimitive?.content ?: ""
        val publicKey = body["publicKey"]?.jsonPrimitive?.content ?: ""
        val joining = body["chain"] == null

        val json = org.json.JSONObject()
            .put("netId", netId)
            .put("netName", "Test net")
            .put("rootPublicKey", rootKey.publicKey)
            .put("memberId", "phone")
            .put("hostChain", Credential.listToJson(hostChain))
            .put("dataPort", 7)
        if (proves) {
            json.put("proof", NetCrypto.sign(hostKey.privateKey, Net.hostProofBytes(netId, nonce)))
        }
        if (joining && publicKey.isNotEmpty()) {
            val issued = Net.issue(
                netId = netId,
                epoch = 1,
                memberId = "phone",
                name = "A phone",
                publicKey = publicKey,
                certPin = "",
                issuedAt = 0,
                issuer = "mac-mini",
                privateKey = hostKey.privateKey,
            )
            json.put("chain", Credential.listToJson(listOf(issued) + hostChain))
        }
        return json.toString()
    }

    private fun await(what: String, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!predicate()) {
            if (System.currentTimeMillis() > deadline) throw AssertionError("timed out waiting for $what")
            Thread.sleep(10)
        }
    }

    @Test
    fun `a session link greets the session server once it is admitted`() {
        val received = mutableListOf<Frames.Frame>()
        val server = startHost(received)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val link = HostLink("127.0.0.1", server.localPort, pin(), scope, speaksSessions = true)
        try {
            link.start("device-1", "phone", joining = null, membership = membershipFor(NetCrypto.generateMemberKey()))
            await("the session hello") {
                synchronized(received) { received.any { it.kind == Frames.REQ_HELLO } }
            }
            val frames = synchronized(received) { received.toList() }
            // Order matters: the host refuses everything before its own hello,
            // so the remote handshake has to come first and the session one
            // immediately after — not on the first attach, which is too late.
            assertEquals(Frames.REMOTE_HELLO, frames.first().kind)
            val hello = frames.first { it.kind == Frames.REQ_HELLO }
            val version = Json.parseToJsonElement(hello.text!!).jsonObject["version"]!!.jsonPrimitive.int
            assertEquals(Frames.SESSION_PROTOCOL_VERSION, version)
        } finally {
            link.stop()
            server.close()
        }
    }

    /**
     * A phone's socket dies constantly and almost none of it is a fault — a
     * lock, a wifi-to-cellular hop, Android reclaiming a background socket.
     * Before this the link ran ONCE and then sat in a state whose UI says
     * "retrying" while doing nothing, so the way back was force-quitting.
     */
    @Test
    fun `a dropped link dials again by itself`() {
        val received = mutableListOf<Frames.Frame>()
        val server = startHost(received)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val link = HostLink("127.0.0.1", server.localPort, pin(), scope)
        try {
            link.start("device-1", "phone", joining = null, membership = membershipFor(NetCrypto.generateMemberKey()))
            await("the first handshake") {
                synchronized(received) { received.count { it.kind == Frames.REMOTE_HELLO } >= 1 }
            }
            // Kill it the way a screen lock does — from underneath, with no
            // protocol-level goodbye.
            link.dropForTest()
            await("a second handshake, unaided") {
                synchronized(received) { received.count { it.kind == Frames.REMOTE_HELLO } >= 2 }
            }
        } finally {
            link.stop()
            server.close()
        }
    }

    @Test
    fun `a control link does not, because that socket carries no sessions`() {
        val received = mutableListOf<Frames.Frame>()
        val server = startHost(received)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val link = HostLink("127.0.0.1", server.localPort, pin(), scope)
        try {
            link.start("device-1", "phone", joining = null, membership = membershipFor(NetCrypto.generateMemberKey()))
            await("the remote handshake") {
                synchronized(received) { received.any { it.kind == Frames.REMOTE_HELLO } }
            }
            Thread.sleep(200)
            assertTrue(
                "a control link must not greet a session server it is not talking to",
                synchronized(received) { received.none { it.kind == Frames.REQ_HELLO } },
            )
        } finally {
            link.stop()
            server.close()
        }
    }

    /**
     * Joining: the phone arrives with a code and a fresh key, and leaves holding
     * a membership every Mac in the net will accept — including Macs it has
     * never dialled. That is the whole point of the rewrite.
     */
    @Test
    fun `a joining phone keeps the membership the Mac issues`() {
        val received = mutableListOf<Frames.Frame>()
        val server = startHost(received)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val link = HostLink("127.0.0.1", server.localPort, pin(), scope)
        val facts = JoinFacts(
            host = "127.0.0.1",
            port = server.localPort,
            dataPort = 0,
            pin = pin(),
            code = "424242",
            netId = netId,
            netName = "Test net",
            rootPublicKey = rootKey.publicKey,
        )
        try {
            link.start("device-1", "phone", joining = facts, membership = null)
            await("the membership") { link.state.value is HostLink.State.Ready }
            val ready = link.state.value as HostLink.State.Ready
            val issued = ready.issued!!

            // It checks out against the net's root…
            assertEquals(null, Net.verifyChain(issued.chain, netId, rootKey.publicKey, emptySet()))
            // …and it describes the key this phone actually holds, or it could
            // never be proven to anybody.
            assertEquals(issued.memberKey.publicKey, issued.chain.first().publicKey)

            // The code went with the first hello and a key came with it.
            val hello = Json.parseToJsonElement(
                synchronized(received) { received.first { it.kind == Frames.REMOTE_HELLO } }.text!!,
            ).jsonObject
            assertEquals("424242", hello["pairingCode"]!!.jsonPrimitive.content)
            assertTrue(hello["publicKey"]!!.jsonPrimitive.content.isNotEmpty())
        } finally {
            link.stop()
            server.close()
        }
    }

    /** A member presents its chain and a proof — and no code, having spent it. */
    @Test
    fun `a returning member presents a chain and a proof, not a code`() {
        val received = mutableListOf<Frames.Frame>()
        val server = startHost(received)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val link = HostLink("127.0.0.1", server.localPort, pin(), scope)
        val membership = membershipFor(NetCrypto.generateMemberKey())
        try {
            link.start("device-1", "phone", joining = null, membership = membership)
            await("the handshake") {
                synchronized(received) { received.any { it.kind == Frames.REMOTE_HELLO } }
            }
            val hello = Json.parseToJsonElement(
                synchronized(received) { received.first { it.kind == Frames.REMOTE_HELLO } }.text!!,
            ).jsonObject
            assertTrue(hello["chain"] != null)
            assertTrue(hello["pairingCode"] == null)

            // The proof is over THIS host's pin: one captured elsewhere is
            // useless here, which is the property that makes a public chain safe
            // to present.
            val proof = hello["proof"]!!.jsonObject
            val at = proof["at"]!!.jsonPrimitive.content.toLong()
            assertTrue(
                NetCrypto.verify(
                    membership.memberKey.publicKey,
                    Net.proofBytes(netId, pin(), at),
                    proof["signature"]!!.jsonPrimitive.content,
                ),
            )
        } finally {
            link.stop()
            server.close()
        }
    }

    /**
     * A Mac that cannot prove its membership is REFUSED, terminally.
     *
     * Under a net the certificate pin no longer answers "is this the right Mac" —
     * it answers "is this the certificate I was handed". Something holding that
     * certificate and unable to prove it belongs to the net is not an outage, so
     * retrying it would be a loop that keeps talking to whoever is listening.
     */
    @Test
    fun `a Mac that does not prove its membership is refused and not retried`() {
        val received = mutableListOf<Frames.Frame>()
        val server = startHost(received, proves = false)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val link = HostLink("127.0.0.1", server.localPort, pin(), scope)
        try {
            link.start("device-1", "phone", joining = null, membership = membershipFor(NetCrypto.generateMemberKey()))
            await("the refusal") {
                (link.state.value as? HostLink.State.Failed)?.terminal == true
            }
            val failed = link.state.value as HostLink.State.Failed
            assertTrue(failed.reason, failed.reason.contains("prove"))

            // Terminal means terminal: no second dial.
            val dials = synchronized(received) { received.count { it.kind == Frames.REMOTE_HELLO } }
            Thread.sleep(300)
            assertEquals(dials, synchronized(received) { received.count { it.kind == Frames.REMOTE_HELLO } })
        } finally {
            link.stop()
            server.close()
        }
    }
}
