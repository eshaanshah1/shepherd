package com.eshaan.shepherd.model

enum class AgentState(val raw: String) {
    SHELL("shell"), WORKING("working"), BLOCKED("blocked"),
    NEEDS_CHECK("need-to-check"), IDLE("idle"), ERROR("error"), UNKNOWN("");

    val wantsAttention: Boolean get() = this == BLOCKED || this == NEEDS_CHECK || this == ERROR

    companion object {
        fun fromRaw(s: String): AgentState = entries.firstOrNull { it.raw == s } ?: UNKNOWN
    }
}
