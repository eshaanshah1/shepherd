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
 * What this link says after it is let in — against a real TLS server, because the
 * bug it pins lived entirely in the ORDER of two handshakes on one socket.
 *
 * The data link paired, connected and attached, and the host answered
 * `not-greeted` to every request because the session server's own hello had
 * never been sent. Both links reported healthy and the terminal painted nothing.
 * A test that only asserted "the link reaches Ready" would still pass today.
 */
class HostLinkTest {

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
     * protocol, which is the whole thing under test.
     */
    private fun startHost(received: MutableList<Frames.Frame>): SSLServerSocket {
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
                                        Frames.json(Frames.REMOTE_ACCEPTED, """{"secret":"s","dataPort":"7"}"""),
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
            link.start("device-1", "phone", pairingCode = null, secret = "s")
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

    @Test
    fun `a control link does not, because that socket carries no sessions`() {
        val received = mutableListOf<Frames.Frame>()
        val server = startHost(received)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val link = HostLink("127.0.0.1", server.localPort, pin(), scope)
        try {
            link.start("device-1", "phone", pairingCode = null, secret = "s")
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
}
