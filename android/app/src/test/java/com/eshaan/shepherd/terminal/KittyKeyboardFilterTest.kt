package com.eshaan.shepherd.terminal

import org.junit.Assert.assertArrayEquals
import org.junit.Test

class KittyKeyboardFilterTest {
    private val e = 27.toChar().toString()   // ESC
    private fun bytes(s: String) = s.toByteArray(Charsets.US_ASCII)

    @Test fun stripsKittyQueryButKeepsSurroundingText() {
        val out = KittyKeyboardFilter().filter(bytes("hi" + e + "[?uthere"))
        assertArrayEquals(bytes("hithere"), out)
    }

    @Test fun stripsPushPopAndSetForms() {
        assertArrayEquals(bytes("ab"), KittyKeyboardFilter().filter(bytes("a" + e + "[>1ub")))
        assertArrayEquals(bytes("ab"), KittyKeyboardFilter().filter(bytes("a" + e + "[<ub")))
        assertArrayEquals(bytes("ab"), KittyKeyboardFilter().filter(bytes("a" + e + "[=1;1ub")))
    }

    @Test fun keepsBareCsiU_scoRestoreCursor() {
        // No private prefix -> SCO restore-cursor, NOT kitty. Must pass through untouched.
        val seq = e + "[u"
        assertArrayEquals(bytes(seq), KittyKeyboardFilter().filter(bytes(seq)))
    }

    @Test fun keepsOtherCsiSequences() {
        // SGR color, erase, private mode set (?25h), DA query -- none is a prefixed 'u'.
        val seq = e + "[31m" + e + "[2J" + e + "[?25h" + e + "[c"
        assertArrayEquals(bytes(seq), KittyKeyboardFilter().filter(bytes(seq)))
    }

    @Test fun handlesSequenceSplitAcrossChunks() {
        val f = KittyKeyboardFilter()
        assertArrayEquals(bytes("x"), f.filter(bytes("x" + e + "[?")))   // 'x' out, partial held
        assertArrayEquals(bytes("y"), f.filter(bytes("uy")))             // kitty completes -> dropped, 'y' out
    }

    @Test fun handlesEscAtChunkBoundary() {
        val f = KittyKeyboardFilter()
        assertArrayEquals(bytes("z"), f.filter(bytes("z" + e)))   // lone ESC held
        assertArrayEquals(ByteArray(0), f.filter(bytes("[?u")))   // completes -> dropped
    }
}
