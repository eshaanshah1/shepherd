package com.eshaan.shepherd.model

import com.eshaan.shepherd.protocol.PaneInfo

data class InboxPartition(val attention: List<PaneInfo>, val other: List<PaneInfo>)

private val leadingDecoration = Regex("^[^\\p{L}\\p{N}~/.]+")

/** Strip leading decoration (agent status glyphs like ✳ / ·, plus surrounding whitespace) that the
 *  host's pane title carries, so the inbox's left edge reads clean. Falls back to the trimmed raw
 *  title if stripping would leave nothing (e.g. a bare "~"). Keeps path/home leaders (~ / .). */
fun cleanPaneTitle(raw: String): String {
    val t = raw.trim()
    val stripped = t.replace(leadingDecoration, "").trim()
    return stripped.ifEmpty { t }
}

/** Attention-first inbox model: partition panes into "needs you" vs the rest, each sorted by
 *  urgency. Sort is stable (sortedBy preserves input order within an equal rank). */
object Inbox {
    fun rank(state: AgentState): Int = when (state) {
        AgentState.BLOCKED     -> 0
        AgentState.ERROR       -> 1
        AgentState.NEEDS_CHECK -> 2
        AgentState.WORKING     -> 3
        AgentState.IDLE        -> 4
        AgentState.SHELL       -> 5
        AgentState.UNKNOWN     -> 6
    }

    fun partition(panes: List<PaneInfo>): InboxPartition {
        val (attn, other) = panes.partition { AgentState.fromRaw(it.state).wantsAttention }
        val byRank = { p: PaneInfo -> rank(AgentState.fromRaw(p.state)) }
        return InboxPartition(attn.sortedBy(byRank), other.sortedBy(byRank))
    }
}
