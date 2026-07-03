package com.eshaan.shepherd.ui

import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.protocol.PromptQuestion
import com.eshaan.shepherd.protocol.DataMessage
import com.eshaan.shepherd.protocol.DataWireCodec
import com.eshaan.shepherd.protocol.WireCodec
import com.eshaan.shepherd.transport.ConnStatus
import com.eshaan.shepherd.transport.DataChannel
import com.eshaan.shepherd.transport.DataStatus
import com.eshaan.shepherd.transport.RemoteConnection
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.DataInputStream
import java.net.ServerSocket

@OptIn(ExperimentalCoroutinesApi::class)
class AgentViewModelTest {
    @Before fun setUp() { Dispatchers.setMain(Dispatchers.IO) }
    @After fun tearDown() { Dispatchers.resetMain() }

    @Test fun escBytesForKnownKeys() {
        assertArrayEquals(byteArrayOf(0x1b, '['.code.toByte(), 'A'.code.toByte()), escBytesFor(Key.Up))
        assertArrayEquals(byteArrayOf(0x1b, '['.code.toByte(), 'B'.code.toByte()), escBytesFor(Key.Down))
        assertArrayEquals(byteArrayOf(0x1b, '['.code.toByte(), 'C'.code.toByte()), escBytesFor(Key.Right))
        assertArrayEquals(byteArrayOf(0x1b, '['.code.toByte(), 'D'.code.toByte()), escBytesFor(Key.Left))
        assertArrayEquals(byteArrayOf(0x1b), escBytesFor(Key.Esc))
        assertArrayEquals(byteArrayOf(0x03), escBytesFor(Key.CtrlC))
    }

    /** Control loopback: accept the hello, reply Accepted(nonce). */
    private fun controlHost(server: ServerSocket, nonce: String) = Thread {
        val s = server.accept(); val ins = DataInputStream(s.getInputStream())
        val dec = WireCodec.Decoder(); val buf = ByteArray(4096)
        loop@ while (true) { val n = ins.read(buf); if (n <= 0) return@Thread
            for (m in dec.feed(buf.copyOf(n))) if (m is ControlMessage.Hello) break@loop }
        s.getOutputStream().apply { write(WireCodec.encode(ControlMessage.Accepted(nonce))); flush() }
        Thread.sleep(300); s.close()
    }.apply { isDaemon = true; start() }

    /** Data loopback: read the DataHello, reply DataReady(40,30). */
    private fun dataHost(server: ServerSocket, seen: (DataMessage.DataHello) -> Unit) = Thread {
        val s = server.accept(); val ins = DataInputStream(s.getInputStream())
        val dec = DataWireCodec.Decoder(); val buf = ByteArray(4096)
        loop@ while (true) { val n = ins.read(buf); if (n <= 0) return@Thread
            for (m in dec.feed(buf.copyOf(n))) if (m is DataMessage.DataHello) { seen(m); break@loop } }
        s.getOutputStream().apply { write(DataWireCodec.encode(DataMessage.DataReady(40, 30))); flush() }
        Thread.sleep(300); s.close()
    }.apply { isDaemon = true; start() }

    @Test fun attachUsesLiveNonceAndPaneIdAndMirrorsStatus() = runBlocking {
        val controlServer = ServerSocket(0)
        controlHost(controlServer, "nonce-1")
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val controlConn = RemoteConnection("127.0.0.1", controlServer.localPort,
            { ControlMessage.Hello("d", "n", null, "sec", null, 1) }, scope)
        controlConn.start()
        withTimeout(5000) { controlConn.status.first { it is ConnStatus.Connected } }

        val dataServer = ServerSocket(0)
        var seenHello: DataMessage.DataHello? = null
        dataHost(dataServer) { seenHello = it }

        val vm = AgentViewModel(
            paneId = "p1", host = "127.0.0.1", port = dataServer.localPort, controlConn = controlConn,
            initialCols = 40, initialRows = 30,
        )
        vm.attach()
        val ready = withTimeout(5000) { vm.status.first { it is DataStatus.Ready } } as DataStatus.Ready
        assertEquals(40, ready.cols); assertEquals(30, ready.rows)
        assertNotNull(vm.terminalSession.value)
        assertNotNull(seenHello)
        assertEquals("nonce-1", seenHello!!.sessionNonce); assertEquals("p1", seenHello!!.paneId)

        vm.detach(); controlConn.stop(); scope.cancel(); controlServer.close(); dataServer.close()
    }

    @Test fun reflectsPromptStoreForItsPaneAndClearsOnUnblock() = runBlocking {
        PromptStore.reset()
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        // A control connection to a dead port: attach()'s prompt collector runs regardless of the
        // (never-completing) data-channel connect, which is all this test exercises.
        val controlConn = RemoteConnection("127.0.0.1", 1, { ControlMessage.Hello("d", "n", null, "s", null, 1) }, scope)
        val vm = AgentViewModel(paneId = "p1", host = "127.0.0.1", port = 1, controlConn = controlConn)
        vm.attach()

        PromptStore.update(ControlMessage.Prompt("p1", "askUserQuestion", null,
            listOf(PromptQuestion("Q", "H", listOf("A", "B"), false))))
        withTimeout(5000) { vm.prompt.first { it != null } }
        assertEquals("askUserQuestion", vm.prompt.value!!.kind)

        PromptStore.update(ControlMessage.Prompt("p2", "permission", "Bash", null))  // other pane
        assertEquals("askUserQuestion", vm.prompt.value!!.kind)                       // unchanged

        PromptStore.update(ControlMessage.StateMsg("p1", "working", null))
        withTimeout(5000) { vm.prompt.first { it == null } }

        vm.detach(); scope.cancel()
    }
}
