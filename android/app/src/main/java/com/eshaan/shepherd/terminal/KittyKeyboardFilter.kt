package com.eshaan.shepherd.terminal

/**
 * Strips kitty keyboard protocol sequences from the host→emulator output stream so Claude Code
 * falls back to legacy key encoding on the phone.
 *
 * Termux's bundled emulator round-trips the kitty query badly, leaking literal `u`s into Claude's
 * input. The kitty output sequences are all CSI with a private prefix (`?` `>` `<` `=`) ending in
 * `u` — the support query (`ESC [ ? u`), and push/pop/set. Dropping them before the emulator sees
 * them means it never emits the malformed response, so Claude sees "unsupported" and uses legacy
 * encoding (its standard fallback — no loss of function for phone use).
 *
 * Deliberately NARROW: only CSI-`u` sequences that carry a private prefix are dropped. A bare
 * `CSI u` (SCO restore-cursor) and every non-`u` CSI pass through untouched. Stateful so a sequence
 * split across two [filter] calls (PTY reads chunk arbitrarily) is held until complete.
 */
class KittyKeyboardFilter {
    private var pending: ByteArray = ByteArray(0)   // an incomplete ESC-sequence carried to the next call

    fun filter(input: ByteArray): ByteArray {
        val buf = if (pending.isEmpty()) input else pending + input
        pending = ByteArray(0)
        val out = ArrayList<Byte>(buf.size)
        var i = 0
        while (i < buf.size) {
            val b = buf[i]
            if (b != ESC) { out.add(b); i++; continue }
            if (i + 1 >= buf.size) { pending = buf.copyOfRange(i, buf.size); break }   // lone ESC at end
            if (buf[i + 1] != LBRACKET) { out.add(b); i++; continue }                  // ESC x (not CSI) → pass ESC
            // CSI: ESC [ <params/intermediates...> <final 0x40..0x7E>
            var j = i + 2
            while (j < buf.size && (buf[j].toInt() and 0xff) !in FINAL_RANGE) j++
            if (j >= buf.size) {
                // Incomplete CSI at chunk end — hold it, unless it's implausibly long (malformed),
                // in which case flush so we never swallow real output.
                if (buf.size - i > MAX_SEQ) { for (k in i until buf.size) out.add(buf[k]); i = buf.size }
                else pending = buf.copyOfRange(i, buf.size)
                break
            }
            val finalByte = buf[j].toInt() and 0xff
            val firstParam = if (j > i + 2) (buf[i + 2].toInt() and 0xff) else -1
            val kittyPrefixed = firstParam == QUESTION || firstParam == GT || firstParam == LT || firstParam == EQ
            if (finalByte != U || !kittyPrefixed) { for (k in i..j) out.add(buf[k]) }   // keep everything else
            i = j + 1                                                                    // (drop kitty CSI-u)
        }
        return out.toByteArray()
    }

    private companion object {
        const val ESC = 0x1b.toByte()
        val LBRACKET = '['.code.toByte()
        val FINAL_RANGE = 0x40..0x7e
        const val U = 'u'.code
        const val QUESTION = '?'.code
        const val GT = '>'.code
        const val LT = '<'.code
        const val EQ = '='.code
        const val MAX_SEQ = 64
    }
}
