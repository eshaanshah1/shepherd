package com.eshaan.shepherd.terminal

import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class RemoteTerminalSessionTest {
    private fun session(
        cols: Int = 40, rows: Int = 30,
        channelInput: (ByteArray) -> Unit = {},
        resizeSink: (Int, Int) -> Unit = { _, _ -> },
        scope: CoroutineScope,
        debounceMs: Long = 50,
    ) = RemoteTerminalSession(cols, rows, channelInput, resizeSink, scope, debounceMs)

    @Test fun appendsOutputToEmulator() = runBlocking {
        val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
        val s = session(scope = scope)
        s.onOutput("hello".toByteArray())
        assertTrue(s.screenText().contains("hello"))
        scope.cancel()
    }

    @Test fun sendInputReachesChannel() = runBlocking {
        val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
        val got = ArrayList<Byte>()
        val s = session(channelInput = { got.addAll(it.toList()) }, scope = scope)
        s.sendInput(byteArrayOf(0x61))
        assertEquals(listOf<Byte>(0x61), got)
        scope.cancel()
    }

    @Test fun onSizeChangedDebouncesToLastValue() = runBlocking {
        val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
        val calls = ArrayList<Pair<Int, Int>>()
        val s = session(resizeSink = { c, r -> synchronized(calls) { calls.add(c to r) } }, scope = scope, debounceMs = 50)
        s.onSizeChanged(30, 15)
        s.onSizeChanged(20, 10)
        withTimeout(2000) { while (synchronized(calls) { calls.isEmpty() }) delay(10) }
        delay(120)   // let any late/duplicate fire land
        synchronized(calls) { assertEquals(listOf(20 to 10), calls) }
        scope.cancel()
    }
}
