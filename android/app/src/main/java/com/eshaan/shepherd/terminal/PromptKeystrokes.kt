package com.eshaan.shepherd.terminal

import com.eshaan.shepherd.protocol.PromptQuestion

/**
 * Synthesizes the keystrokes that answer an AskUserQuestion prompt as a TUI menu.
 *
 * Number-key model (options are numbered, first option highlighted by default):
 * - **Single-select:** press the chosen option's number (`1` = option 1, …) — selects and advances.
 * - **Multi-select:** press each chosen option's number to toggle it, then step down to the Submit
 *   row (`Down × (optionCount + 1)` — option 0 is highlighted and Submit sits 2 below the last
 *   option) and press Enter.
 *
 * Returns one **list of individual keystrokes per question**; the caller paces them (a gap after
 * every keystroke, a larger gap between questions) — the TUI drops keystrokes sent faster than it
 * processes them.
 */
object PromptKeystrokes {
    private val ESC = 0x1b.toByte()
    private val DOWN = byteArrayOf(ESC, '['.code.toByte(), 'B'.code.toByte())
    private val ENTER = byteArrayOf(0x0d)
    private fun digit(optionIndex: Int): ByteArray = byteArrayOf(('1'.code + optionIndex).toByte())

    /** [selections]`[i]` = chosen option indices for question `i` (single-select = one index). */
    fun askUserQuestion(questions: List<PromptQuestion>, selections: List<List<Int>>): List<List<ByteArray>> {
        val perQuestion = questions.mapIndexed { qi, q ->
            val chosen = (selections.getOrNull(qi) ?: emptyList()).sorted()
            if (q.multiSelect) {
                chosen.map { digit(it) } + List(q.options.size + 1) { DOWN } + listOf(ENTER)
            } else {
                listOf(digit(chosen.firstOrNull() ?: 0))
            }
        }
        // The form ends on a "Review your answers → 1. Submit answers" screen (highlighted) for
        // anything except a lone single-choice question — i.e. multiple questions OR a single
        // multi-choice question. One more Enter confirms it. A lone single-choice submits directly.
        val needsConfirm = questions.size > 1 || (questions.size == 1 && questions[0].multiSelect)
        return if (needsConfirm) perQuestion + listOf(listOf(ENTER)) else perQuestion
    }
}
