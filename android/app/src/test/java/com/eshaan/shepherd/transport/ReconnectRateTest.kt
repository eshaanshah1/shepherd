package com.eshaan.shepherd.transport

import com.eshaan.shepherd.protocol.ControlMessage
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicInteger

/**
 * Ceilings on how OFTEN a component may dial, which is the class of bug state assertions cannot
 * see. The storm that broke the phone produced entirely correct states — `Disconnected`, then
 * `Connecting`, then `Disconnected` — arriving four times a second forever. Every retrying
 * component gets a test here.
 */
class ReconnectRateTest {

    /** A server that accepts and immediately hangs up, counting attempts. */
    private class SlammingHost {
        val server = ServerSocket(0)
        val attempts = AtomicInteger(0)
        val thread = Thread {
            while (!server.isClosed) {
                try { server.accept().close(); attempts.incrementAndGet() } catch (_: Exception) { return@Thread }
            }
        }.apply { isDaemon = true; start() }
        fun close() { server.close() }
    }

    @Test fun dataChannelBacksOffInsteadOfHammering() = runBlocking {
        val host = SlammingHost()
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val ch = DataChannel("127.0.0.1", host.server.localPort, "nonce", "p1", 80, 24, scope)
        ch.start()
        delay(3_000)
        val n = host.attempts.get()
        ch.stop(); scope.cancel(); host.close()
        // 1s + 2s of backoff inside 3s ⇒ a handful at most. The storm was ~12.
        assertTrue("DataChannel dialled $n times in 3s — backoff is not bounding it", n <= 4)
        assertTrue("it should still be retrying at all, got $n", n >= 1)
    }

    @Test fun controlConnectionBacksOffInsteadOfHammering() = runBlocking {
        val host = SlammingHost()
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val conn = RemoteConnection("127.0.0.1", host.server.localPort,
            { ControlMessage.Hello("d", "n", null, "s", null, 2) }, scope)
        conn.start()
        delay(3_000)
        val n = host.attempts.get()
        conn.stop(); scope.cancel(); host.close()
        assertTrue("RemoteConnection dialled $n times in 3s", n <= 4)
    }

    /**
     * Foregrounding repeatedly must not multiply connections. This is the shape of the original
     * defect: every ON_START tore down a live session, and every teardown stranded a data channel.
     */
    @Test fun repeatedResumeHintsDoNotMultiplyConnections() = runBlocking {
        val host = SlammingHost()
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val ch = DataChannel("127.0.0.1", host.server.localPort, "nonce", "p1", 80, 24, scope)
        ch.start()
        delay(300)
        val before = host.attempts.get()
        repeat(20) { ch.retryNow() }     // 20 unlocks in a row
        delay(1_500)
        val added = host.attempts.get() - before
        ch.stop(); scope.cancel(); host.close()
        // A kick collapses to at most one retry per wait — not one dial per call.
        assertTrue("20 resume hints caused $added dials", added <= 3)
    }

    /**
     * The path the first rate test missed, and the one that actually happened: the host ACCEPTS,
     * reads the hello, and hangs up without answering. That returns from runSession normally, and
     * treating a normal return as success reset the backoff every time — a connection per second
     * forever, at a rate that never grew, which is precisely what the host log showed. A dead port
     * exercises the exception path instead, so it could not catch this.
     */
    @Test fun aHostThatHangsUpWithoutAnsweringDoesNotGetHammered() = runBlocking {
        val server = ServerSocket(0)
        val attempts = AtomicInteger(0)
        Thread {
            while (!server.isClosed) {
                try {
                    val s = server.accept()
                    attempts.incrementAndGet()
                    s.getInputStream().read(ByteArray(4096))   // consume the hello, answer nothing
                    s.close()
                } catch (_: Exception) { return@Thread }
            }
        }.apply { isDaemon = true; start() }

        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val ch = DataChannel("127.0.0.1", server.localPort, "nonce", "p1", 80, 24, scope)
        ch.start()
        delay(4_000)
        val n = attempts.get()
        ch.stop(); scope.cancel(); server.close()
        assertTrue("host hung up each time and we dialled $n times in 4s", n <= 4)
        assertTrue("should still retry at all, got $n", n >= 1)
    }
}
