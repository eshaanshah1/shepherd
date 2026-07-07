package com.eshaan.shepherd.protocol

import kotlinx.serialization.json.*

object WireCodec {
    private const val MAX_FRAME = 8 * 1024 * 1024

    private fun paneJson(p: PaneInfo): JsonObject = buildJsonObject {
        put("paneID", p.paneId); put("title", p.title); put("workspace", p.workspace); put("state", p.state)
        if (p.reason != null) put("reason", p.reason)
    }

    private fun treeJson(t: WorkspaceTree): JsonObject = buildJsonObject {
        put("workspaceID", t.workspaceId); put("name", t.name)
        if (t.selectedTabId != null) put("selectedTabID", t.selectedTabId)
        put("tabs", buildJsonArray { t.tabs.forEach { add(tabJson(it)) } })
    }
    private fun tabJson(tab: RemoteTab): JsonObject = buildJsonObject {
        put("tabID", tab.tabId); put("root", nodeJson(tab.root))
        if (tab.focusedPaneId != null) put("focusedPaneID", tab.focusedPaneId)
        if (tab.zoomedPaneId != null) put("zoomedPaneID", tab.zoomedPaneId)
    }
    private fun nodeJson(n: RemoteNode): JsonObject = buildJsonObject {
        when (n) {
            is RemoteNode.Leaf -> { put("kind", "leaf"); put("pane", remotePaneJson(n.pane)) }
            is RemoteNode.Split -> {
                put("kind", "split"); put("axis", n.axis); put("ratio", n.ratio)
                put("first", nodeJson(n.first)); put("second", nodeJson(n.second))
            }
        }
    }
    private fun remotePaneJson(p: RemotePane): JsonObject = buildJsonObject {
        put("paneID", p.paneId); put("title", p.title); put("state", p.state)
        if (p.cwd != null) put("cwd", p.cwd)
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
            // Host→client in production; encode is kept symmetric so tests can mint host frames.
            is ControlMessage.WorkspaceTreeMsg -> putJsonObject("workspaceTree") { put("_0", treeJson(msg.tree)) }
            is ControlMessage.WorkspaceList -> putJsonObject("workspaceList") {
                put("ids", buildJsonArray { msg.ids.forEach { add(it) } })
            }
            is ControlMessage.WorkspaceRemoved -> putJsonObject("workspaceRemoved") { put("workspaceID", msg.workspaceId) }
            is ControlMessage.StateMsg -> putJsonObject("state") {
                put("paneID", msg.paneId); put("state", msg.state); if (msg.reason != null) put("reason", msg.reason)
            }
            is ControlMessage.PaneAdded -> putJsonObject("paneAdded") { put("_0", paneJson(msg.pane)) }
            is ControlMessage.PaneRemoved -> putJsonObject("paneRemoved") { put("paneID", msg.paneId) }
            is ControlMessage.PaneRenamed -> putJsonObject("paneRenamed") { put("paneID", msg.paneId); put("title", msg.title) }
            is ControlMessage.Resize -> putJsonObject("resize") { put("paneID", msg.paneId); put("cols", msg.cols); put("rows", msg.rows) }
            is ControlMessage.Prompt -> putJsonObject("prompt") {
                put("paneID", msg.paneId); put("kind", msg.kind)
                if (msg.detail != null) put("detail", msg.detail)
                if (msg.questions != null) put("questions", buildJsonArray {
                    msg.questions.forEach { q -> add(buildJsonObject {
                        put("prompt", q.prompt); put("header", q.header)
                        put("options", buildJsonArray { q.options.forEach { add(it) } }); put("multiSelect", q.multiSelect)
                    }) }
                })
            }
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

    private fun parseTree(o: JsonObject): WorkspaceTree = WorkspaceTree(
        workspaceId = o.getValue("workspaceID").jsonPrimitive.content,
        name = o.getValue("name").jsonPrimitive.content,
        selectedTabId = o["selectedTabID"]?.jsonPrimitive?.contentOrNull,
        tabs = o.getValue("tabs").jsonArray.map { te ->
            val t = te.jsonObject
            RemoteTab(
                tabId = t.getValue("tabID").jsonPrimitive.content,
                root = parseNode(t.getValue("root").jsonObject),
                focusedPaneId = t["focusedPaneID"]?.jsonPrimitive?.contentOrNull,
                zoomedPaneId = t["zoomedPaneID"]?.jsonPrimitive?.contentOrNull)
        })

    private fun parseNode(o: JsonObject): RemoteNode =
        when (o.getValue("kind").jsonPrimitive.content) {
            "leaf" -> RemoteNode.Leaf(parseRemotePane(o.getValue("pane").jsonObject))
            else -> RemoteNode.Split(
                o.getValue("axis").jsonPrimitive.content, o.getValue("ratio").jsonPrimitive.double,
                parseNode(o.getValue("first").jsonObject), parseNode(o.getValue("second").jsonObject))
        }

    private fun parseRemotePane(o: JsonObject): RemotePane = RemotePane(
        paneId = o.getValue("paneID").jsonPrimitive.content,
        title = o.getValue("title").jsonPrimitive.content,
        cwd = o["cwd"]?.jsonPrimitive?.contentOrNull,
        state = o.getValue("state").jsonPrimitive.content,
        reason = o["reason"]?.jsonPrimitive?.contentOrNull)

    private fun parse(json: String): ControlMessage? {
        val root = Json.parseToJsonElement(json).jsonObject
        val key = root.keys.firstOrNull() ?: return null
        val b = root.getValue(key).jsonObject
        return when (key) {
            "accepted" -> ControlMessage.Accepted(b.getValue("sessionNonce").jsonPrimitive.content)
            "rejected" -> ControlMessage.Rejected(b.getValue("reason").jsonPrimitive.content)
            "pendingApproval" -> ControlMessage.PendingApproval
            "workspaceTree" -> ControlMessage.WorkspaceTreeMsg(parseTree(b.getValue("_0").jsonObject))
            "workspaceList" -> ControlMessage.WorkspaceList(b.getValue("ids").jsonArray.map { it.jsonPrimitive.content })
            "workspaceRemoved" -> ControlMessage.WorkspaceRemoved(b.getValue("workspaceID").jsonPrimitive.content)
            "state" -> ControlMessage.StateMsg(b.getValue("paneID").jsonPrimitive.content,
                b.getValue("state").jsonPrimitive.content, b["reason"]?.jsonPrimitive?.contentOrNull)
            "paneAdded" -> ControlMessage.PaneAdded(pane(b.getValue("_0").jsonObject))
            "paneRemoved" -> ControlMessage.PaneRemoved(b.getValue("paneID").jsonPrimitive.content)
            "paneRenamed" -> ControlMessage.PaneRenamed(b.getValue("paneID").jsonPrimitive.content,
                b.getValue("title").jsonPrimitive.content)
            "resize" -> ControlMessage.Resize(b.getValue("paneID").jsonPrimitive.content,
                b.getValue("cols").jsonPrimitive.int, b.getValue("rows").jsonPrimitive.int)
            "prompt" -> ControlMessage.Prompt(
                b.getValue("paneID").jsonPrimitive.content,
                b.getValue("kind").jsonPrimitive.content,
                b["detail"]?.jsonPrimitive?.contentOrNull,
                b["questions"]?.jsonArray?.map { qe ->
                    val o = qe.jsonObject
                    PromptQuestion(o.getValue("prompt").jsonPrimitive.content, o.getValue("header").jsonPrimitive.content,
                        o.getValue("options").jsonArray.map { it.jsonPrimitive.content }, o.getValue("multiSelect").jsonPrimitive.boolean)
                })
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
