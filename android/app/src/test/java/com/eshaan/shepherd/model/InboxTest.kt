package com.eshaan.shepherd.model

import com.eshaan.shepherd.protocol.PaneInfo
import org.junit.Assert.assertEquals
import org.junit.Test

class InboxTest {
    private fun p(id: String, state: String) = PaneInfo(id, id, "W", state, null)

    @Test fun attentionHoldsWantsAttentionSortedByUrgency() {
        val part = Inbox.partition(listOf(
            p("needs", "need-to-check"), p("err", "error"), p("blk", "blocked"),
            p("work", "working"), p("idle", "idle"),
        ))
        assertEquals(listOf("blk", "err", "needs"), part.attention.map { it.paneId })
        assertEquals(listOf("work", "idle"), part.other.map { it.paneId })
    }

    @Test fun otherSortsWorkingIdleShellAndKeepsStableOrderWithinState() {
        val part = Inbox.partition(listOf(
            p("shell1", "shell"), p("idle1", "idle"), p("work1", "working"),
            p("work2", "working"), p("idle2", "idle"),
        ))
        assertEquals(listOf("work1", "work2", "idle1", "idle2", "shell1"), part.other.map { it.paneId })
        assertEquals(emptyList<String>(), part.attention.map { it.paneId })
    }

    @Test fun unknownStateSortsLast() {
        val part = Inbox.partition(listOf(p("u", "bogus"), p("i", "idle")))
        assertEquals(listOf("i", "u"), part.other.map { it.paneId })
    }

    @Test fun cleanTitleStripsLeadingGlyphs() {
        assertEquals("Review final gate", cleanPaneTitle("✳ Review final gate"))
        assertEquals("Fix checkpoint timing", cleanPaneTitle("· Fix checkpoint timing"))
        assertEquals("Debug evals", cleanPaneTitle("✳ ✳  Debug evals"))
    }

    @Test fun cleanTitleKeepsPlainAndPathTitles() {
        assertEquals("android-app-redesign", cleanPaneTitle("android-app-redesign"))
        assertEquals("repos/testAI", cleanPaneTitle("repos/testAI"))
        assertEquals("~", cleanPaneTitle("~"))
        assertEquals("~/dev", cleanPaneTitle("~/dev"))
    }
}
