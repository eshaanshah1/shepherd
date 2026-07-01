package com.eshaan.shepherd.protocol

data class PaneInfo(
    val paneId: String,
    val title: String,
    val workspace: String,
    val state: String,
    val reason: String?,
)
