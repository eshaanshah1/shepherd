package com.eshaan.shepherd.protocol

import java.net.URI
import java.net.URLDecoder

/** Parses the QR bootstrap payload minted by the Swift PairingPayload.encode. Byte-pinned. */
object PairingPayload {
    data class Parsed(val host: String?, val ip: String?, val port: Int, val name: String?)

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
        if (host == null && ip == null) return null
        return Parsed(host, ip, port, map["name"]?.ifBlank { null })
    }
}
