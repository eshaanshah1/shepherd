package com.eshaan.shepherd.terminal

import com.eshaan.shepherd.protocol.PromptQuestion
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class PromptKeystrokesTest {
    private val DOWN = byteArrayOf(0x1b, '['.code.toByte(), 'B'.code.toByte())
    private val ENTER = byteArrayOf(0x0d)
    private fun digit(i: Int) = byteArrayOf(('1'.code + i).toByte())
    private fun q(n: Int, multi: Boolean) = PromptQuestion("q", "h", (0 until n).map { "o$it" }, multi)

    private fun assertNested(expected: List<List<ByteArray>>, actual: List<List<ByteArray>>) {
        assertEquals("question count", expected.size, actual.size)
        expected.zip(actual).forEach { (eq, aq) ->
            assertEquals("keystroke count", eq.size, aq.size)
            eq.zip(aq).forEach { (e, a) -> assertArrayEquals(e, a) }
        }
    }

    @Test fun singleSelectSendsTheOptionNumber() {
        // option index 1 → number "2", one keystroke, one question
        assertNested(listOf(listOf(digit(1))),
            PromptKeystrokes.askUserQuestion(listOf(q(2, false)), listOf(listOf(1))))
    }

    @Test fun singleMultiSelectSendsNumbersDownToSubmitEnterThenReviewConfirm() {
        // options 0 and 2 of 3 → "1","3", Down×(3+1) to the Submit row, Enter; then a lone
        // multi-choice ALSO hits the review screen → trailing [Enter] to confirm.
        val q1 = listOf(digit(0), digit(2)) + List(4) { DOWN } + listOf(ENTER)
        assertNested(listOf(q1, listOf(ENTER)),
            PromptKeystrokes.askUserQuestion(listOf(q(3, true)), listOf(listOf(0, 2))))
    }

    @Test fun mixedQuestionsEmitPerQuestionKeystrokeListsThenSubmitConfirm() {
        // Q1 single idx0 → ["1"]; Q2 multi idx0 (3 opts) → ["1", Down×4, Enter];
        // then a trailing [Enter] to confirm "Submit answers" on the review screen.
        val q2 = listOf(digit(0)) + List(4) { DOWN } + listOf(ENTER)
        assertNested(listOf(listOf(digit(0)), q2, listOf(ENTER)),
            PromptKeystrokes.askUserQuestion(listOf(q(2, false), q(3, true)), listOf(listOf(0), listOf(0))))
    }

    @Test fun singleQuestionHasNoSubmitConfirm() {
        // one question → no review screen → no trailing Enter
        assertNested(listOf(listOf(digit(0))),
            PromptKeystrokes.askUserQuestion(listOf(q(3, false)), listOf(listOf(0))))
    }
}
