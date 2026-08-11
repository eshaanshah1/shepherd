package com.eshaan.shepherd.v2

import java.net.URLDecoder

/**
 * Everything needed to join a net, as one string — the phone's half of the Mac's
 * `payload.ts`.
 *
 * **Why this exists at all.** Joining means carrying a host, a port, a
 * 64-character certificate pin and an 88-character root key from a Mac to a
 * phone. Typed by hand that happens once and never again, which is how a feature
 * ends up unused rather than unbuilt. One string is a QR to point a camera at, or
 * a line to paste out of a message — same payload either way, so there is one
 * parser to be right rather than one per surface.
 *
 * **It checks itself.** The net id is the SHA-256 of the root key the link
 * carries, so a truncated or edited link is refused here. What it cannot tell you
 * is that the link came from a Mac you trust — that is the join ceremony's job (a
 * code, and digits a human compares).
 */
data class JoinFacts(
    val host: String,
    val port: Int,
    /** 0 when the Mac reported none: this phone can browse but not open a terminal. */
    val dataPort: Int,
    val pin: String,
    val code: String?,
    val netId: String,
    val netName: String,
    val rootPublicKey: String,
)

object JoinLink {
    const val SCHEME = "shepherd://join"

    /** Null for anything this build cannot act on — every refusal is explainable. */
    fun parse(raw: String): JoinFacts? {
        val text = raw.trim()
        if (!text.startsWith("$SCHEME?")) return null

        val fields = mutableMapOf<String, String>()
        for (pair in text.removePrefix("$SCHEME?").split('&')) {
            val at = pair.indexOf('=')
            if (at <= 0) continue
            fields[pair.substring(0, at)] = runCatching {
                URLDecoder.decode(pair.substring(at + 1), "UTF-8")
            }.getOrElse { return null }
        }

        val host = fields["host"] ?: return null
        val pin = fields["pin"] ?: return null
        val netId = fields["net"] ?: return null
        val root = fields["root"] ?: return null

        // A version mismatch caught here can name both versions. Reached over the
        // wire instead, it arrives as a refusal the user cannot act on.
        if (fields["v"]?.toIntOrNull() != HostLink.REMOTE_PROTOCOL_VERSION) return null

        val port = fields["port"]?.toIntOrNull() ?: return null
        if (port <= 0) return null
        val dataPort = fields["data"]?.let { it.toIntOrNull() ?: return null } ?: 0

        val derived = runCatching { NetCrypto.netIdOf(root) }.getOrNull() ?: return null
        if (!derived.equals(netId, ignoreCase = true)) return null

        return JoinFacts(
            host = host,
            port = port,
            dataPort = dataPort,
            pin = pin,
            code = fields["code"],
            netId = netId,
            netName = fields["name"] ?: "",
            rootPublicKey = root,
        )
    }
}
