package com.eshaan.shepherd.transport

import org.junit.Assert.*
import org.junit.Test

/**
 * The SAS is the whole of the LAN pairing's man-in-the-middle detection: the host shows three
 * codes and the user picks the one this app displays. If the two implementations ever compute it
 * differently, that comparison compares nothing and always fails — or worse, is "fixed" by
 * someone removing it.
 *
 * The vector below is byte-identical to the one Swift's `LANIdentityTests
 * .testSASDigitsAreAPinnedFunctionOfTheHash` asserts. Do not change one without the other.
 */
class SasTest {

    private val vector = byteArrayOf(0x00, 0x01, 0x02, 0x03) + ByteArray(28) { 0xff.toByte() }

    @Test
    fun `matches the pinned Swift vector`() {
        val expected = "%06d".format(0x00010203L % 1_000_000L)
        assertEquals(expected, Pinning.sasDigits(vector))
    }

    @Test
    fun `is always six digits`() {
        assertEquals(6, Pinning.sasDigits(vector).length)
        assertEquals(6, Pinning.sasDigits(ByteArray(32)).length)          // all zero
        assertEquals(6, Pinning.sasDigits(ByteArray(32) { 0xff.toByte() }).length)
    }

    @Test
    fun `a different certificate gives different digits`() {
        val nudged = byteArrayOf(0x00, 0x01, 0x02, 0x04) + ByteArray(28) { 0xff.toByte() }
        assertNotEquals(Pinning.sasDigits(vector), Pinning.sasDigits(nudged))
    }
}
