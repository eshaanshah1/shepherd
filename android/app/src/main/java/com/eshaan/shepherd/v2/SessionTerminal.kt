package com.eshaan.shepherd.v2

import com.eshaan.shepherd.terminal.RemoteTerminalSession
import com.eshaan.shepherd.util.SLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
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
             * A viewport, not a resize.
             *
             * One pty has one size and several clients may be watching, so the
             * phone declares what it can display and the HOST arbitrates —
             * smallest wins. A client that resized directly would reshape the
             * pty under whoever else is looking at it.
             */
            link.sendJson(
                Frames.REQ_SET_VIEWPORT,
                buildJsonObject {
                    put("seq", link.nextSeq())
                    put("sessionId", sessionId)
                    put("viewerId", "phone")
                    put("viewport", buildJsonObject { put("cols", c); put("rows", r) })
                },
            )
        },
        scope = scope,
    )

    private var attached = false

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
        link.sendJson(
            Frames.REQ_DETACH,
            buildJsonObject { put("seq", link.nextSeq()); put("sessionId", sessionId) },
        )
        // …and withdraw our opinion about size, so the Mac stops being
        // letterboxed to a phone that is no longer looking.
        link.sendJson(
            Frames.REQ_SET_VIEWPORT,
            buildJsonObject {
                put("seq", link.nextSeq())
                put("sessionId", sessionId)
                put("viewerId", "phone")
            },
        )
    }
}
