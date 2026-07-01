package com.eshaan.shepherd.data

import android.os.Build
import java.util.UUID

object DeviceIdentity {
    fun newSecret(): String = UUID.randomUUID().toString()
    fun newDeviceId(): String = UUID.randomUUID().toString()
    fun deviceName(): String = Build.MODEL ?: "Android"
}
