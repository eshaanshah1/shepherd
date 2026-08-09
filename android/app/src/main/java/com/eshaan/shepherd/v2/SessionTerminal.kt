package com.eshaan.shepherd.v2

import com.eshaan.shepherd.terminal.RemoteTerminalSession
import com.eshaan.shepherd.util.SLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * One session's terminal, over the link this phone already has.
 *
 * There is no second connection and no data channel. The v1 client opened a
 * dedicated socket per pane with its own handshake and its own message set; here
 * the pty's bytes are frames on the connection that is already open, keyed by
 * session id — so the phone attaches to the SAME server the Mac's own renderer
 * talks to, and gets the same bytes from the same fanout.
 *
 * Two consequences worth stating, because they are the point rather than side
 * effects:
 *
 *   - **Attaching hands over a SCREEN.** The host holds a real terminal emulator
 *     per session, so the first thing that arrives is a serialized screen — alt
 *     screen and all. A phone that opens a task mid-`vim` sees `vim`, not a
 *     stream of escape codes it cannot reconstruct. v1's design listed that as
 *     an accepted limitation.
 *   - **Co-presence is free.** Every viewer gets every byte, including the tty's
 *     own echo of a half-typed line, and input is just `write`. Type on the
 *     laptop and it appears here; press Enter here and it runs there.
 */
class SessionTerminal(
    private val sessionId: String,
    private val link: HostLink,
    private val scope: CoroutineScope,
    cols: Int = 80,
    rows: Int = 24,
) {
    val session = RemoteTerminalSession(
        cols = cols,
        rows = rows,
        // Keystrokes go out as a BYTE frame — never JSON. base64 would inflate
        // the one path where latency is felt, and the host opens the pty with no
        // encoding precisely so a multi-byte sequence is never re-decoded.
        channelInput = { bytes -> link.sendBytes(Frames.REQ_WRITE, sessionId, bytes) },
        resizeSink = { c, r ->
            /**
             * A viewport, not a resize — and only while this phone holds control.
             *
             * One pty has one size and several clients may be watching, so a
             * client declares what it can display and the HOST arbitrates,
             * smallest wins. Declaring one therefore SHRINKS the Mac, which is
             * why it is not the default: a phone glancing at a session must not
             * cost the person at the desk eighty columns. See [takeControl].
             */
            if (controlling) sendViewport(c, r)
        },
        scope = scope,
    )

    private var attached = false

    /**
     * Whether this phone is driving the size, as opposed to watching.
     *
     * The two modes exist because only ONE of them can ever be correct at a
     * time, and which one depends on a human rather than on anything the code
     * can see. Passive: keep the host's grid, scale the font, leave the Mac
     * alone. Controlling: declare a viewport, the pty is reshaped, `SIGWINCH`
     * makes the program **re-do its own layout** at the phone's size — which is
     * the only mechanism that ever yields a genuinely correct small screen,
     * because only the application knows what to drop.
     */
    var controlling: Boolean = false
        private set

    private var lastGrid: Pair<Int, Int>? = null

    /**
     * Take or hand back the size.
     *
     * Handing it back WITHDRAWS the viewport rather than restoring a remembered
     * number: the host re-arbitrates from whoever is left, so the Mac returns to
     * its own size without this phone having to know what that was.
     */
    fun takeControl(on: Boolean) {
        if (controlling == on) return
        controlling = on
        val grid = lastGrid
        if (on && grid != null) sendViewport(grid.first, grid.second) else withdrawViewport()
    }

    /**
     * Not before the link is up.
     *
     * The screen mounts — and so takes control — while the data link is still
     * shaking hands, and a frame written then goes to a socket that does not
     * exist yet. It presented as `write failed: null` and a terminal stuck at
     * the Mac's grid: the viewport was never delivered, and nothing reported a
     * fault because the retry never happened. `attach` flushes it once Ready.
     */
    @Volatile
    private var linkReady = false

    private fun sendViewport(cols: Int, rows: Int) {
        lastGrid = cols to rows
        if (!linkReady) return
        link.sendJson(
            Frames.REQ_SET_VIEWPORT,
            buildJsonObject {
                put("seq", link.nextSeq())
                put("sessionId", sessionId)
                put("viewerId", VIEWER_ID)
                put("viewport", buildJsonObject { put("cols", cols); put("rows", rows) })
            },
        )
    }

    /** No `viewport` field at all — the host reads that as "I have no opinion". */
    private fun withdrawViewport() {
        if (!linkReady) return
        link.sendJson(
            Frames.REQ_SET_VIEWPORT,
            buildJsonObject {
                put("seq", link.nextSeq())
                put("sessionId", sessionId)
                put("viewerId", VIEWER_ID)
            },
        )
    }

    /** What the local view can display, whether or not we act on it. */
    fun reportGrid(cols: Int, rows: Int) {
        lastGrid = cols to rows
        if (controlling) sendViewport(cols, rows)
    }

    /** The host's grid changed; follow it. Never sends anything back. */
    private fun adoptHostSize(cols: Int, rows: Int) {
        session.adoptHostSize(cols, rows)
        onHostGrid?.invoke(cols, rows)
    }

    /** Set by the view so it can rescale its font to the host's columns. */
    var onHostGrid: ((Int, Int) -> Unit)? = null

    fun attach() {
        if (attached) return
        attached = true
        scope.launch {
            link.frames.collect { frame ->
                // Bytes for OTHER sessions ride the same connection; this phone
                // may be showing one while the Mac streams several.
                if (frame.sessionId != sessionId) return@collect
                when (frame.kind) {
                    // A snapshot and live output are both just bytes to an
                    // emulator — the distinction exists so the HOST can route a
                    // late viewer's screen to it alone, not so a client has to
                    // treat them differently.
                    Frames.RES_DATA, Frames.RES_SNAPSHOT -> frame.payload?.let { session.onOutput(it) }
                    // Ahead of the snapshot the host sends right behind it, so
                    // the screen is parsed into a grid that is already the right
                    // shape rather than reflowed after the fact.
                    Frames.RES_RESIZED -> frame.text?.let { body ->
                        val json = Json.parseToJsonElement(body).jsonObject
                        val cols = json["cols"]?.jsonPrimitive?.content?.toIntOrNull()
                        val rows = json["rows"]?.jsonPrimitive?.content?.toIntOrNull()
                        if (cols != null && rows != null) adoptHostSize(cols, rows)
                    }
                    Frames.RES_EXIT -> SLog.i(SLog.DATA, "session ${sessionId.take(8)} exited")
                }
            }
        }
        scope.launch {
            /**
             * Wait for READY before asking for anything.
             *
             * The screen mounts the moment a row is tapped, which can be while
             * the data link is still shaking hands — and a frame written then is
             * dropped by a socket that does not exist yet. It presented as
             * `write failed: null` and a terminal that never painted: the attach
             * was never sent, and nothing reported a fault because nothing had
             * failed.
             */
            link.state.first { it is HostLink.State.Ready }
            linkReady = true
            /**
             * The viewport goes FIRST, before the attach.
             *
             * Attaching hands back a screen serialized at the pty's CURRENT
             * size, so asking for it before declaring what we can display means
             * the first thing painted was drawn for somebody else's grid — and
             * the reshape that follows arrives too late to have prevented it.
             */
            lastGrid?.let { (cols, rows) -> if (controlling) sendViewport(cols, rows) }
            link.sendJson(
                Frames.REQ_ATTACH,
                buildJsonObject { put("seq", link.nextSeq()); put("sessionId", sessionId) },
            )
            SLog.i(SLog.DATA, "attached to ${sessionId.take(8)}")
        }
    }

    /**
     * Stop watching. **It does not end the session** — that is the rule the whole
     * architecture rests on, and it is why closing the phone screen leaves your
     * agent running on the Mac.
     */
    fun detach() {
        if (!attached) return
        attached = false
        controlling = false
        link.sendJson(
            Frames.REQ_DETACH,
            buildJsonObject { put("seq", link.nextSeq()); put("sessionId", sessionId) },
        )
        // …and withdraw our opinion about size, so the Mac stops being
        // letterboxed to a phone that is no longer looking.
        //
        // BEFORE `linkReady` is cleared, because that flag gates the send:
        // clearing it first swallowed the withdrawal and left the Mac shrunk to
        // a phone that had walked away, with nothing to undo it.
        withdrawViewport()
        linkReady = false
    }

    private companion object {
        /** Stable per phone: the host keys its viewport table by this. */
        const val VIEWER_ID = "phone"
    }
}
