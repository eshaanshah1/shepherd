package com.eshaan.shepherd.protocol

sealed interface DataMessage {
    data class DataHello(val sessionNonce: String, val paneId: String, val cols: Int, val rows: Int) : DataMessage
    data class DataReady(val cols: Int, val rows: Int) : DataMessage
    data class DataRejected(val reason: String) : DataMessage
    data class PtyHello(val paneId: String, val cols: Int, val rows: Int) : DataMessage
}
