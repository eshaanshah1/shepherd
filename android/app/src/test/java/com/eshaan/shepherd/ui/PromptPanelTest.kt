package com.eshaan.shepherd.ui

import com.eshaan.shepherd.protocol.PromptQuestion
import com.eshaan.shepherd.terminal.PromptKeystrokes
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class PromptPanelTest {
    private fun assertNested(expected: List<List<ByteArray>>, actual: List<List<ByteArray>>) {
        assertEquals(expected.size, actual.size)
        expected.zip(actual).forEach { (eq, aq) ->
            assertEquals(eq.size, aq.size)
            eq.zip(aq).forEach { (e, a) -> assertArrayEquals(e, a) }
        }
    }

    @Test fun buildsStepsFromSelectionState() {
        val qs = listOf(PromptQuestion("q", "h", listOf("A", "B"), false))
        assertNested(PromptKeystrokes.askUserQuestion(qs, listOf(listOf(1))), answerSteps(qs, mapOf(0 to setOf(1))))
    }

    @Test fun unselectedQuestionContributesEmptySelection() {
        val qs = listOf(PromptQuestion("q1", "h", listOf("A", "B"), false),
                        PromptQuestion("q2", "h", listOf("X", "Y"), true))
        assertNested(PromptKeystrokes.askUserQuestion(qs, listOf(listOf(1), emptyList())),
                     answerSteps(qs, mapOf(0 to setOf(1))))
    }
}
