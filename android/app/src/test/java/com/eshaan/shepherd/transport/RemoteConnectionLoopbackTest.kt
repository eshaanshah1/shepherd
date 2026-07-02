package com.eshaan.shepherd.transport

import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.protocol.PaneInfo
import com.eshaan.shepherd.protocol.WireCodec
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Semaphore
import kotlin.system.measureTimeMillis

class RemoteConnectionLoopbackTest {
    /** Minimal host: read one hello, reply accepted+snapshot, then a state delta. */
    private fun fakeHost(server: ServerSocket, onHello: (ControlMessage.Hello) -> Unit) = Thread {
        val s = server.accept()
        val ins = DataInputStream(s.getInputStream())
        val dec = WireCodec.Decoder()
        val buf = ByteArray(4096)
        loop@ while (true) {
            val n = ins.read(buf); if (n <= 0) return@Thread
            for (m in dec.feed(buf.copyOf(n))) if (m is ControlMessage.Hello) { onHello(m); break@loop }
        }
        val out = s.getOutputStream()
        out.write(WireCodec.encode(ControlMessage.Accepted("nonce-xyz")))
        out.write(WireCodec.encode(ControlMessage.Snapshot(listOf(PaneInfo("p1","t","W","idle",null)))))
        out.write(WireCodec.encode(ControlMessage.StateMsg("p1","blocked","approve Bash")))
        out.flush()
        Thread.sleep(200); s.close()
    }.apply { isDaemon = true; start() }

    @Test fun handshakeThenSnapshotThenDelta() = runBlocking {
        val server = ServerSocket(0)
        var seenHello: ControlMessage.Hello? = null
        fakeHost(server) { seenHello = it }
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val conn = RemoteConnection(
            host = "127.0.0.1", port = server.localPort,
            helloFactory = { ControlMessage.Hello("dev-1","Test", "0042", "secret", "tok", 1) },
            scope = scope,
            connect = { h, p -> Socket(h, p) },
        )
        // Copy-on-write: the collector coroutine appends while the assertions below iterate,
        // so a plain ArrayList races into ConcurrentModificationException.
        val received = java.util.concurrent.CopyOnWriteArrayList<ControlMessage>()
        val job = scope.launch { conn.inbound.toList(received) }
        conn.start()
        val connected = withTimeout(3000) { conn.status.first { it is ConnStatus.Connected } } as ConnStatus.Connected
        assertEquals("nonce-xyz", connected.sessionNonce)
        withTimeout(3000) { while (received.none { it is ControlMessage.StateMsg }) delay(20) }
        assertTrue(received.any { it is ControlMessage.Snapshot })
        assertTrue(received.any { it is ControlMessage.StateMsg })
        assertNotNull(seenHello); assertEquals("0042", seenHello!!.pairingCode)
        job.cancel(); conn.stop(); scope.cancel(); server.close()
    }

    @Test fun pendingThenAcceptedTransitions() = runBlocking {
        val server = ServerSocket(0)
        Thread {
            val s = server.accept(); val ins = DataInputStream(s.getInputStream())
            val dec = WireCodec.Decoder(); val buf = ByteArray(4096)
            loop@ while (true) { val n = ins.read(buf); if (n <= 0) return@Thread
                for (m in dec.feed(buf.copyOf(n))) if (m is ControlMessage.Hello) break@loop }
            val out = s.getOutputStream()
            out.write(WireCodec.encode(ControlMessage.PendingApproval)); out.flush(); Thread.sleep(150)
            out.write(WireCodec.encode(ControlMessage.Accepted("n2")))
            out.write(WireCodec.encode(ControlMessage.Snapshot(emptyList()))); out.flush(); Thread.sleep(150); s.close()
        }.apply { isDaemon = true; start() }
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val conn = RemoteConnection("127.0.0.1", server.localPort,
            { ControlMessage.Hello("d","n",null,"sec","tok",1) }, scope)
        conn.start()
        withTimeout(3000) { conn.status.first { it is ConnStatus.Pending } }
        withTimeout(3000) { conn.status.first { it is ConnStatus.Connected } }
        conn.stop(); scope.cancel(); server.close()
    }

    @Test fun stopReturnsPromptlyEvenWhenSocketWriteIsStuck() = runBlocking {
        // A write() that blocks forever (never-released semaphore) simulates a stalled/dead
        // peer — java.net.Socket has no write timeout, so stop() must not wait on it.
        val neverReleases = Semaphore(0)
        val blockingOut = object : OutputStream() {
            override fun write(b: Int) { neverReleases.acquire() }
            override fun write(b: ByteArray, off: Int, len: Int) { neverReleases.acquire() }
        }
        val emptyIn = ByteArrayInputStream(ByteArray(0))
        val fakeSocket = object : Socket() {
            override fun getOutputStream(): OutputStream = blockingOut
            override fun getInputStream() = emptyIn
        }
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val conn = RemoteConnection("h", 1, { ControlMessage.Hello("d", "n", null, "s", null, 1) }, scope,
            connect = { _, _ -> fakeSocket })
        conn.start()
        withTimeout(2000) { conn.status.first { it is ConnStatus.Connecting } }
        delay(50)   // let runSession reach the blocking hello write
        val elapsed = measureTimeMillis { conn.stop() }
        assertTrue("stop() must not block on a stalled socket write (took ${elapsed}ms)", elapsed < 300)
        scope.cancel()
    }
}
