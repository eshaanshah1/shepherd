package com.eshaan.shepherd.protocol

import java.net.URI
import java.net.URLDecoder

/** Parses the QR bootstrap payload minted by the Swift PairingPayload.encode. Byte-pinned. */
object PairingPayload {
    /**
     * `lan`/`pin`/`code` are present when the Mac is serving on the local network. They let a
     * phone with no Tailscale pair by scanning alone, and the pin arriving over the QR — a visual
     * channel an attacker on the wifi is not on — binds the certificate more strongly than the
     * typed-code flow's compare-the-digits step, which a user can skip.
     */
    data class Parsed(
        val host: String?, val ip: String?, val port: Int, val name: String?,
        val lanHost: String? = null, val lanPort: Int? = null,
        val pin: String? = null, val code: String? = null,
    ) {
        val hasLan: Boolean get() = lanHost != null && lanPort != null && pin != null
    }

    fun parse(s: String): Parsed? {
        val uri = try { URI(s.trim()) } catch (e: Exception) { return null }
        if (uri.scheme != "shepherd") return null
        val q = uri.rawQuery ?: return null
        val map = q.split("&").mapNotNull {
            val i = it.indexOf('=')
            if (i < 0) null
            else URLDecoder.decode(it.substring(0, i), "UTF-8") to URLDecoder.decode(it.substring(i + 1), "UTF-8")
        }.toMap()
        val port = map["port"]?.toIntOrNull() ?: return null
        val host = map["host"]?.ifBlank { null }
        val ip = map["ip"]?.ifBlank { null }
        // lan is "ip:port"; anything malformed is simply treated as absent rather than failing
        // the whole scan — the tailnet fields alone are still a usable pairing.
        val lan = map["lan"]?.ifBlank { null }
        val lanHost = lan?.substringBeforeLast(':', "")?.ifBlank { null }
        val lanPort = lan?.substringAfterLast(':', "")?.toIntOrNull()
        // A Mac with Tailscale down emits a LAN-only QR, and that is a complete pairing — so
        // requiring a tailnet address here would reject exactly the case LAN mode is for.
        if (host == null && ip == null && lanHost == null) return null
        return Parsed(host, ip, port, map["name"]?.ifBlank { null },
                      lanHost = if (lanPort != null) lanHost else null,
                      lanPort = if (lanHost != null) lanPort else null,
                      pin = map["pin"]?.ifBlank { null },
                      code = map["code"]?.ifBlank { null })
    }
}
