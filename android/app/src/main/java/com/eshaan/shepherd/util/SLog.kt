package com.eshaan.shepherd.util

import android.util.Log

/**
 * The client's log, and it exists for the same reason the host's does: without it, a failure on
 * this side is invisible and the only evidence is the host's view of the symptom. A whole day of
 * debugging went into inferring what this app was doing from the Mac's socket log, because the app
 * itself said nothing at all.
 *
 * One tag so `adb logcat -s Shepherd:V` is the whole story, with a short category as the first
 * column to grep — mirroring the categories on the Mac side.
 */
object SLog {
    private const val TAG = "Shepherd"

    /** control channel: dial, hello, accepted/rejected, status */
    const val CONN = "conn"
    /** pty data channel: dial, handshake, backoff */
    const val DATA = "data"
    /** pairing: QR, pin, SAS, code */
    const val PAIR = "pair"
    /** view-model decisions: nonce changes, resume, rebuilds */
    const val VM = "vm"

    fun d(cat: String, msg: String) { Log.d(TAG, "$cat  $msg") }
    fun i(cat: String, msg: String) { Log.i(TAG, "$cat  $msg") }
    fun w(cat: String, msg: String) { Log.w(TAG, "$cat  $msg") }
    fun e(cat: String, msg: String, t: Throwable? = null) { Log.e(TAG, "$cat  $msg", t) }
}
