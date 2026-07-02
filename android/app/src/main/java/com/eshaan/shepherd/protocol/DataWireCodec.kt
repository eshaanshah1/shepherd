package com.eshaan.shepherd.protocol

import kotlinx.serialization.json.*

/** Mirrors [WireCodec] for the phone↔app PTY data channel handshake frames. Same
 *  `[u32 BE len][json]` framing, single-key object keyed by case name, `paneID`/`sessionNonce` keys. */
object DataWireCodec {
    private const val MAX_FRAME = 8 * 1024 * 1024

    private fun body(m: DataMessage): JsonObject = buildJsonObject {
        when (m) {
            is DataMessage.DataHello -> putJsonObject("dataHello") {
                put("sessionNonce", m.sessionNonce); put("paneID", m.paneId); put("cols", m.cols); put("rows", m.rows)
            }
            is DataMessage.DataReady -> putJsonObject("dataReady") { put("cols", m.cols); put("rows", m.rows) }
            is DataMessage.DataRejected -> putJsonObject("dataRejected") { put("reason", m.reason) }
            is DataMessage.PtyHello -> putJsonObject("ptyHello") { put("paneID", m.paneId); put("cols", m.cols); put("rows", m.rows) }
        }
    }

    fun encode(m: DataMessage): ByteArray {
        val json = body(m).toString().toByteArray(Charsets.UTF_8)
        val out = ByteArray(4 + json.size)
        out[0] = (json.size ushr 24).toByte(); out[1] = (json.size ushr 16).toByte()
        out[2] = (json.size ushr 8).toByte(); out[3] = json.size.toByte()
        json.copyInto(out, 4)
        return out
    }

    private fun parse(json: String): DataMessage? {
        val root = Json.parseToJsonElement(json).jsonObject
        val k = root.keys.firstOrNull() ?: return null
        val b = root.getValue(k).jsonObject
        return when (k) {
            "dataReady" -> DataMessage.DataReady(b.getValue("cols").jsonPrimitive.int, b.getValue("rows").jsonPrimitive.int)
            "dataRejected" -> DataMessage.DataRejected(b.getValue("reason").jsonPrimitive.content)
            "dataHello" -> DataMessage.DataHello(b.getValue("sessionNonce").jsonPrimitive.content,
                b.getValue("paneID").jsonPrimitive.content, b.getValue("cols").jsonPrimitive.int, b.getValue("rows").jsonPrimitive.int)
            "ptyHello" -> DataMessage.PtyHello(b.getValue("paneID").jsonPrimitive.content,
                b.getValue("cols").jsonPrimitive.int, b.getValue("rows").jsonPrimitive.int)
            else -> null
        }
    }

    class Decoder {
        private var buf = ByteArray(0)
        fun feed(data: ByteArray): List<DataMessage> {
            buf += data
            val out = ArrayList<DataMessage>()
            while (buf.size >= 4) {
                val len = ((buf[0].toInt() and 0xff) shl 24) or ((buf[1].toInt() and 0xff) shl 16) or
                          ((buf[2].toInt() and 0xff) shl 8) or (buf[3].toInt() and 0xff)
                if (len < 0 || len > MAX_FRAME) throw IllegalStateException("frame too large: $len")
                if (buf.size < 4 + len) break
                val json = String(buf, 4, len, Charsets.UTF_8)
                buf = buf.copyOfRange(4 + len, buf.size)
                parse(json)?.let { out.add(it) }
            }
            return out
        }

        /**
         * Parse AT MOST one frame from the accumulated buffer. Returns the decoded message (or
         * null if a full frame isn't buffered yet) and the untouched bytes that follow that one
         * frame. Used only during the data-channel handshake: once the first frame decodes,
         * everything after it is raw PTY bytes and must NOT be length-decoded (they routinely
         * coalesce into the same read as the ready frame).
         */
        fun feedOne(data: ByteArray): Pair<DataMessage?, ByteArray> {
            buf += data
            if (buf.size < 4) return null to ByteArray(0)
            val len = ((buf[0].toInt() and 0xff) shl 24) or ((buf[1].toInt() and 0xff) shl 16) or
                      ((buf[2].toInt() and 0xff) shl 8) or (buf[3].toInt() and 0xff)
            if (len < 0 || len > MAX_FRAME) throw IllegalStateException("frame too large: $len")
            if (buf.size < 4 + len) return null to ByteArray(0)
            val json = String(buf, 4, len, Charsets.UTF_8)
            val tail = buf.copyOfRange(4 + len, buf.size)
            buf = ByteArray(0)
            return parse(json) to tail
        }

        /** Bytes buffered but not yet consumed as a full frame — the raw tail after the last decoded message. */
        fun remainder(): ByteArray = buf.copyOf()
    }
}
