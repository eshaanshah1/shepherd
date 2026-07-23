package com.eshaan.shepherd.fcm

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import com.eshaan.shepherd.R
import com.eshaan.shepherd.model.AgentState

enum class ChimeKind { DONE, BLOCKED }

/** The Mac's attention chime, played on the Android alarm stream so it sounds through
 *  ringer-silent / vibrate. Mapping is pure; playback is thin Android glue. */
object Chime {
    fun soundFor(state: AgentState): ChimeKind? = when (state) {
        AgentState.NEEDS_CHECK -> ChimeKind.DONE
        AgentState.BLOCKED, AgentState.ERROR -> ChimeKind.BLOCKED
        else -> null
    }

    private fun resFor(kind: ChimeKind): Int = when (kind) {
        ChimeKind.DONE -> R.raw.done
        ChimeKind.BLOCKED -> R.raw.blocked
    }

    /** Fire-and-forget: routes through USAGE_ALARM so the ringer's silent/vibrate mode
     *  can't mute it. No-op for states without a chime. Releases itself when done.
     *  Runs on the main looper so MediaPlayer's completion/error callbacks fire (this is
     *  usually called from the FCM handler's Looper-less background thread). */
    fun play(context: Context, state: AgentState) {
        val res = soundFor(state)?.let(::resFor) ?: return
        Handler(Looper.getMainLooper()).post {
            runCatching {
                MediaPlayer().apply {
                    setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build()
                    )
                    // setDataSource dups the fd, so closing the AFD right after is safe.
                    context.resources.openRawResourceFd(res).use { afd ->
                        setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
                    }
                    setOnCompletionListener { it.release() }
                    setOnErrorListener { mp, _, _ -> mp.release(); true }
                    prepare()
                    start()
                }
            }
        }
    }
}
