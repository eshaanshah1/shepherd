package com.eshaan.shepherd.transport

import kotlin.concurrent.thread
import org.junit.Assert.*
import org.junit.Test
import java.security.KeyStore
import java.security.cert.X509Certificate
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket

/**
 * A real TLS handshake against a real self-signed server, because the claim under test is that a
 * wrong certificate is refused — and only a handshake can settle that.
 */
class PinningTest {

    private fun serverKeyStore(): KeyStore {
        val ks = KeyStore.getInstance("PKCS12")
        javaClass.classLoader!!.getResourceAsStream("lan-test-identity.p12").use {
            ks.load(it, "shepherd".toCharArray())
        }
        return ks
    }

    private fun serverCertHash(): ByteArray {
        val ks = serverKeyStore()
        val alias = ks.aliases().toList().first()
        return Pinning.certHash(ks.getCertificate(alias) as X509Certificate)
    }

    /** A TLS server that echoes one line. Returns its port; `received` collects what arrived. */
    private fun startServer(received: MutableList<String>): SSLServerSocket {
        val ks = serverKeyStore()
        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
        kmf.init(ks, "shepherd".toCharArray())
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(kmf.keyManagers, null, null)
        val server = ctx.serverSocketFactory.createServerSocket(0) as SSLServerSocket
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val s = try { server.accept() } catch (_: Exception) { break }
                thread(isDaemon = true) {
                    runCatching {
                        val line = s.getInputStream().bufferedReader().readLine()
                        if (line != null) synchronized(received) { received.add(line) }
                    }
                    runCatching { s.close() }
                }
            }
        }
        return server
    }

    @Test
    fun `matching pin connects and carries bytes`() {
        val received = mutableListOf<String>()
        val server = startServer(received)
        try {
            var observed: ByteArray? = null
            val sock = Pinning.connect("127.0.0.1", server.localPort,
                Pinning.Trust.Pinned(serverCertHash()), onObserved = { observed = it })
            sock.getOutputStream().write("HELLO\n".toByteArray())
            sock.getOutputStream().flush()
            Thread.sleep(300)
            sock.close()
            assertArrayEquals("the observed hash is what the SAS is derived from",
                serverCertHash(), observed)
            synchronized(received) { assertEquals(listOf("HELLO"), received) }
        } finally { server.close() }
    }

    @Test
    fun `mismatched pin throws and delivers nothing`() {
        val received = mutableListOf<String>()
        val server = startServer(received)
        try {
            assertThrows(Pinning.PinMismatch::class.java) {
                Pinning.connect("127.0.0.1", server.localPort,
                    Pinning.Trust.Pinned(ByteArray(32) { 0xAB.toByte() }))
            }
            Thread.sleep(300)
            synchronized(received) { assertTrue("no bytes may reach a host we refused", received.isEmpty()) }
        } finally { server.close() }
    }

    /**
     * A dead address must NOT look like a certificate rejection. Conflating them made one moved
     * DHCP lease permanent: the reconnect loop treats PinMismatch as a decision and stops, so the
     * app read "offline" and refresh could not recover it.
     */
    @Test
    fun `an unreachable host is transient, not a pin mismatch`() {
        val e = try {
            // Port 1 on localhost: nothing listens, so the connect fails before any handshake.
            Pinning.connect("127.0.0.1", 1, Pinning.Trust.Pinned(ByteArray(32)))
            null
        } catch (t: Throwable) { t }
        assertNotNull("expected a failure", e)
        assertFalse("a refused connection is not a certificate rejection",
                    e is Pinning.PinMismatch)
        assertTrue("and it must stay an IOException the retry loop understands",
                   e is java.io.IOException)
    }

    @Test
    fun `learn accepts and reports the hash so a first pairing can show its SAS`() {
        val received = mutableListOf<String>()
        val server = startServer(received)
        try {
            var observed: ByteArray? = null
            val sock = Pinning.connect("127.0.0.1", server.localPort,
                Pinning.Trust.Learn, onObserved = { observed = it })
            sock.close()
            assertArrayEquals(serverCertHash(), observed)
        } finally { server.close() }
    }
}
