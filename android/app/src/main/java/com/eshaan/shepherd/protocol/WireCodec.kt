package com.eshaan.shepherd.protocol

import kotlinx.serialization.json.*

object WireCodec {
    private const val MAX_FRAME = 8 * 1024 * 1024

    private fun paneJson(p: PaneInfo): JsonObject = buildJsonObject {
        put("paneID", p.paneId); put("title", p.title); put("workspace", p.workspace); put("state", p.state)
        if (p.reason != null) put("reason", p.reason)
    }

    private fun bodyJson(msg: ControlMessage): JsonObject = buildJsonObject {
        when (msg) {
            is ControlMessage.Hello -> putJsonObject("hello") {
                put("protocolVersion", msg.protocolVersion)
                if (msg.pairingCode != null) put("pairingCode", msg.pairingCode)
                if (msg.secret != null) put("secret", msg.secret)
                if (msg.fcmToken != null) put("fcmToken", msg.fcmToken)
                put("deviceID", msg.deviceId); put("deviceName", msg.deviceName)
            }
            is ControlMessage.RefreshFcmToken -> putJsonObject("refreshFCMToken") { put("token", msg.token) }
            is ControlMessage.Accepted -> putJsonObject("accepted") { put("sessionNonce", msg.sessionNonce) }
            is ControlMessage.Rejected -> putJsonObject("rejected") { put("reason", msg.reason) }
            ControlMessage.PendingApproval -> putJsonObject("pendingApproval") {}
            is ControlMessage.Snapshot -> putJsonObject("snapshot") {
                put("panes", buildJsonArray { msg.panes.forEach { add(paneJson(it)) } })
            }
            is ControlMessage.StateMsg -> putJsonObject("state") {
                put("paneID", msg.paneId); put("state", msg.state); if (msg.reason != null) put("reason", msg.reason)
            }
            is ControlMessage.PaneAdded -> putJsonObject("paneAdded") { put("_0", paneJson(msg.pane)) }
            is ControlMessage.PaneRemoved -> putJsonObject("paneRemoved") { put("paneID", msg.paneId) }
            is ControlMessage.PaneRenamed -> putJsonObject("paneRenamed") { put("paneID", msg.paneId); put("title", msg.title) }
            is ControlMessage.Resize -> putJsonObject("resize") { put("paneID", msg.paneId); put("cols", msg.cols); put("rows", msg.rows) }
            ControlMessage.Detach -> putJsonObject("detach") {}
            ControlMessage.Ping -> putJsonObject("ping") {}
            ControlMessage.Pong -> putJsonObject("pong") {}
        }
    }

    fun encode(msg: ControlMessage): ByteArray {
        val json = bodyJson(msg).toString().toByteArray(Charsets.UTF_8)
        val out = ByteArray(4 + json.size)
        out[0] = (json.size ushr 24).toByte(); out[1] = (json.size ushr 16).toByte()
        out[2] = (json.size ushr 8).toByte(); out[3] = json.size.toByte()
        json.copyInto(out, 4)
        return out
    }

    private fun pane(o: JsonObject): PaneInfo = PaneInfo(
        paneId = o.getValue("paneID").jsonPrimitive.content,
        title = o.getValue("title").jsonPrimitive.content,
        workspace = o.getValue("workspace").jsonPrimitive.content,
        state = o.getValue("state").jsonPrimitive.content,
        reason = o["reason"]?.jsonPrimitive?.contentOrNull,
    )

    private fun parse(json: String): ControlMessage? {
        val root = Json.parseToJsonElement(json).jsonObject
        val key = root.keys.firstOrNull() ?: return null
        val b = root.getValue(key).jsonObject
        return when (key) {
            "accepted" -> ControlMessage.Accepted(b.getValue("sessionNonce").jsonPrimitive.content)
            "rejected" -> ControlMessage.Rejected(b.getValue("reason").jsonPrimitive.content)
            "pendingApproval" -> ControlMessage.PendingApproval
            "snapshot" -> ControlMessage.Snapshot(b.getValue("panes").jsonArray.map { pane(it.jsonObject) })
            "state" -> ControlMessage.StateMsg(b.getValue("paneID").jsonPrimitive.content,
                b.getValue("state").jsonPrimitive.content, b["reason"]?.jsonPrimitive?.contentOrNull)
            "paneAdded" -> ControlMessage.PaneAdded(pane(b.getValue("_0").jsonObject))
            "paneRemoved" -> ControlMessage.PaneRemoved(b.getValue("paneID").jsonPrimitive.content)
            "paneRenamed" -> ControlMessage.PaneRenamed(b.getValue("paneID").jsonPrimitive.content,
                b.getValue("title").jsonPrimitive.content)
            "resize" -> ControlMessage.Resize(b.getValue("paneID").jsonPrimitive.content,
                b.getValue("cols").jsonPrimitive.int, b.getValue("rows").jsonPrimitive.int)
            "pong" -> ControlMessage.Pong
            "ping" -> ControlMessage.Ping
            "detach" -> ControlMessage.Detach
            "hello" -> ControlMessage.Hello(b.getValue("deviceID").jsonPrimitive.content,
                b.getValue("deviceName").jsonPrimitive.content, b["pairingCode"]?.jsonPrimitive?.contentOrNull,
                b["secret"]?.jsonPrimitive?.contentOrNull, b["fcmToken"]?.jsonPrimitive?.contentOrNull,
                b["protocolVersion"]?.jsonPrimitive?.int ?: 1)
            "refreshFCMToken" -> ControlMessage.RefreshFcmToken(b.getValue("token").jsonPrimitive.content)
            else -> null
        }
    }

    class Decoder {
        private var buf = ByteArray(0)
        fun feed(data: ByteArray): List<ControlMessage> {
            buf += data
            val out = ArrayList<ControlMessage>()
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
    }
}
