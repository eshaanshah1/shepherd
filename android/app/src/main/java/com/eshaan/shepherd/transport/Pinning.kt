package com.eshaan.shepherd.transport

import java.io.IOException
import java.net.Socket
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager

/**
 * TLS for LAN mode: the host presents a self-signed certificate and we pin it, because there is
 * no CA in this story and nothing on a local network can vouch for anything.
 *
 * The hash is over the WHOLE certificate DER (`cert.encoded`), which is the one representation
 * this and the Swift side (`SecCertificateCopyData`) can produce identically — an SPKI hash would
 * drift between them and the two would show different SAS digits for the same host.
 */
object Pinning {

    /** How a connection judges the certificate it is offered. Mirrors Swift's `LANBridge.Trust`. */
    sealed interface Trust {
        /** Every connection after the first: the hash must match or the handshake fails. */
        data class Pinned(val hash: ByteArray) : Trust {
            override fun equals(other: Any?) =
                other is Pinned && hash.contentEquals(other.hash)
            override fun hashCode() = hash.contentHashCode()
        }
        /**
         * First pairing only. No pin exists yet, so the certificate is accepted and its hash
         * reported — the user then confirms the SAS derived from it on the host's screen, which is
         * what makes this safe. Store the pin only after that confirmation.
         */
        data object Learn : Trust
    }

    /** Thrown when the host's certificate is not the pinned one. Never retry this: it is a
     *  statement about identity, not a transient network fault. */
    class PinMismatch(message: String) : IOException(message)

    fun certHash(cert: X509Certificate): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(cert.encoded)

    /**
     * Six digits derived from the certificate hash, byte-identical to Swift's `sasDigits`:
     * the first four bytes big-endian, mod 1e6, zero-padded. `SasTest` pins the same vector the
     * Swift `LANIdentityTests` does — if these two ever disagree, the comparison the whole
     * pairing rests on is comparing nothing.
     */
    fun sasDigits(certHash: ByteArray): String {
        require(certHash.size >= 4) { "cert hash too short" }
        var n = 0L
        for (i in 0 until 4) n = (n shl 8) or (certHash[i].toLong() and 0xff)
        return "%06d".format(n % 1_000_000L)
    }

    /**
     * A socket factory that enforces `trust`. `onObserved` fires with the hash actually seen,
     * before the verdict, so a first pairing can show its SAS.
     */
    fun socketFactory(trust: Trust, onObserved: (ByteArray) -> Unit = {}): javax.net.ssl.SSLSocketFactory {
        val tm = object : X509TrustManager {
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                val leaf = chain?.firstOrNull()
                    ?: throw CertificateException("no certificate presented")
                val seen = certHash(leaf)
                onObserved(seen)
                when (trust) {
                    is Trust.Pinned ->
                        if (!seen.contentEquals(trust.hash))
                            throw CertificateException("certificate does not match the pinned one")
                    Trust.Learn -> Unit
                }
            }
            // A client certificate is never requested, and this trust manager must never be
            // used to validate one — returning silently would accept anything.
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
                throw CertificateException("client authentication is not used")
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf(tm), null)
        return ctx.socketFactory
    }

    /**
     * The `(host, port) -> Socket` lambda `RemoteConnection` and `DataChannel` already take.
     * `pinB64` null ⇒ a plain socket, i.e. the tailnet path, byte-for-byte unchanged.
     */
    fun connector(pinB64: String?, onObserved: (ByteArray) -> Unit = {}): (String, Int) -> Socket {
        val pin = pinB64?.let { java.util.Base64.getDecoder().decode(it) }
        return { h, p ->
            if (pin == null) Socket(h, p)
            else connect(h, p, Trust.Pinned(pin), onObserved)
        }
    }

    /** A first pairing: learn the certificate and report its hash so its SAS can be shown. */
    fun learningConnector(onObserved: (ByteArray) -> Unit): (String, Int) -> Socket =
        { h, p -> connect(h, p, Trust.Learn, onObserved) }

    fun encodePin(hash: ByteArray): String =
        java.util.Base64.getEncoder().encodeToString(hash)

    /**
     * Connect to `host:port` over TLS 1.3 with `trust` enforced. The handshake is forced here
     * rather than left to the first read, so a mismatch surfaces as a thrown `PinMismatch` at
     * connect time instead of somewhere inside the frame loop.
     */
    fun connect(host: String, port: Int, trust: Trust,
                onObserved: (ByteArray) -> Unit = {}): Socket {
        val sock = socketFactory(trust, onObserved).createSocket(host, port) as SSLSocket
        sock.enabledProtocols = arrayOf("TLSv1.3")
        try {
            sock.startHandshake()
        } catch (e: Exception) {
            runCatching { sock.close() }
            throw PinMismatch(e.message ?: "TLS handshake refused")
        }
        return sock
    }
}
