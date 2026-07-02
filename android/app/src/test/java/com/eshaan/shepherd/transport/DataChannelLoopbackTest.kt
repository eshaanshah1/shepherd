package com.eshaan.shepherd.transport

import com.eshaan.shepherd.protocol.DataMessage
import com.eshaan.shepherd.protocol.DataWireCodec
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Test
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.net.ServerSocket
import java.net.Socket

class DataChannelLoopbackTest {
    @Test fun handshakeThenRawDuplex() = runBlocking {
        val server = ServerSocket(0)
        var seenHello: DataMessage.DataHello? = null
        val serverReadHi = ArrayList<Byte>()
        val serverThread = Thread {
            val s = server.accept()
            val ins = DataInputStream(s.getInputStream())
            val dec = DataWireCodec.Decoder()
            val buf = ByteArray(4096)
            // read the DataHello handshake frame
            loop@ while (true) {
                val n = ins.read(buf); if (n <= 0) return@Thread
                for (m in dec.feed(buf.copyOf(n))) if (m is DataMessage.DataHello) { seenHello = m; break@loop }
            }
            val out = s.getOutputStream()
            out.write(DataWireCodec.encode(DataMessage.DataReady(40, 30)))
            out.write("screen".toByteArray())
            out.flush()
            // then read the raw "hi" the client sends back
            val n = ins.read(buf)
            if (n > 0) for (i in 0 until n) serverReadHi.add(buf[i])
            Thread.sleep(150); s.close()
        }.apply { isDaemon = true; start() }

        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val channel = DataChannel(
            host = "127.0.0.1", port = server.localPort,
            sessionNonce = "n1", paneId = "p1", initialCols = 40, initialRows = 30, scope = scope,
            connect = { h, p -> Socket(h, p) },
        )
        val outputs = ArrayList<ByteArray>()
        val collectJob = scope.launch { channel.output.collect { outputs.add(it) } }
        channel.start()

        val ready = withTimeout(3000) { channel.status.first { it is DataStatus.Ready } } as DataStatus.Ready
        assertEquals(40, ready.cols); assertEquals(30, ready.rows)
        assertNotNull(seenHello)
        assertEquals("n1", seenHello!!.sessionNonce); assertEquals("p1", seenHello!!.paneId)
        assertEquals(40, seenHello!!.cols); assertEquals(30, seenHello!!.rows)

        withTimeout(3000) { while (outputs.sumOf { it.size } < 6) delay(20) }
        assertEquals("screen", outputs.flatMap { it.toList() }.toByteArray().toString(Charsets.UTF_8))

        channel.input("hi".toByteArray())
        withTimeout(3000) { while (serverReadHi.size < 2) delay(20) }
        assertEquals("hi", serverReadHi.toByteArray().toString(Charsets.UTF_8))

        collectJob.cancel(); channel.stop(); scope.cancel(); server.close()
    }

    /** Regression for C1: the `DataReady` frame and the first raw PTY bytes arrive in ONE read.
     *  The handshake must decode exactly the ready frame and surface the coalesced tail as output. */
    @Test fun readyFrameCoalescedWithRawBytes() = runBlocking {
        val server = ServerSocket(0)
        val serverThread = Thread {
            val s = server.accept()
            val ins = DataInputStream(s.getInputStream())
            val dec = DataWireCodec.Decoder()
            val buf = ByteArray(4096)
            loop@ while (true) {
                val n = ins.read(buf); if (n <= 0) return@Thread
                for (m in dec.feed(buf.copyOf(n))) if (m is DataMessage.DataHello) break@loop
            }
            // ONE buffered payload, single flush: ready frame + raw bytes land in one client read().
            val out = BufferedOutputStream(s.getOutputStream())
            out.write(DataWireCodec.encode(DataMessage.DataReady(40, 30)))
            out.write("hello".toByteArray())
            out.flush()
            Thread.sleep(150); s.close()
        }.apply { isDaemon = true; start() }

        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val channel = DataChannel(
            host = "127.0.0.1", port = server.localPort,
            sessionNonce = "n1", paneId = "p1", initialCols = 40, initialRows = 30, scope = scope,
            connect = { h, p -> Socket(h, p) },
        )
        val outputs = ArrayList<ByteArray>()
        val collectJob = scope.launch { channel.output.collect { outputs.add(it) } }
        channel.start()

        val ready = withTimeout(3000) { channel.status.first { it is DataStatus.Ready } } as DataStatus.Ready
        assertEquals(40, ready.cols); assertEquals(30, ready.rows)
        withTimeout(3000) { while (outputs.sumOf { it.size } < 5) delay(20) }
        assertEquals("hello", outputs.flatMap { it.toList() }.toByteArray().toString(Charsets.UTF_8))

        collectJob.cancel(); channel.stop(); scope.cancel(); server.close()
    }
}
