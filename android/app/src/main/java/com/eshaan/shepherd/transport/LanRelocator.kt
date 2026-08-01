package com.eshaan.shepherd.transport

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.delay

/**
 * Finds a paired Mac again after its address changes.
 *
 * A LAN pairing is stored under `host:port`, but DHCP moves the host — and then every attempt
 * dials an address nothing answers, which reads as the app being broken. The certificate pin is
 * the Mac's real identity and does NOT move, so the way back is to browse `_shepherd._tcp` and
 * keep the candidate whose certificate matches the pin we already confirmed.
 *
 * That check is the same one the transport makes, so relocating grants nothing a normal
 * connection would not: an impostor advertising the service fails the handshake and is skipped.
 */
class LanRelocator(private val context: Context) {

    /** The address now serving the certificate behind [pinB64], or null if it isn't on this link. */
    suspend fun relocate(pinB64: String, timeoutMs: Long = 6_000): Pair<String, Int>? =
        withContext(Dispatchers.IO) {
            val pin = runCatching { java.util.Base64.getDecoder().decode(pinB64) }.getOrNull()
                ?: return@withContext null
            val hosts = browse(timeoutMs) ?: return@withContext null
            hosts.firstNotNullOfOrNull { h ->
                // Pinned, so only the Mac holding that certificate can answer for it.
                runCatching {
                    Pinning.connect(h.host, h.port, Pinning.Trust.Pinned(pin)).close()
                    h.host to h.port
                }.getOrNull()
            }
        }

    /** Collect whatever the link advertises, up to [timeoutMs]. */
    private suspend fun browse(timeoutMs: Long): List<LanHost>? {
        val discovery = LanDiscovery(context)
        var seen: List<LanHost> = emptyList()
        return try {
            withTimeoutOrNull(timeoutMs) {
                discovery.start { seen = it }
                // Resolution trickles in; keep waiting until it settles rather than taking the
                // first result, so a slow-resolving host is not skipped.
                var stable = 0
                var last = 0
                while (stable < 3) {
                    delay(400)
                    if (seen.size == last && seen.isNotEmpty()) stable++ else stable = 0
                    last = seen.size
                }
            }
            seen.ifEmpty { null }
        } finally {
            discovery.stop()
        }
    }
}
