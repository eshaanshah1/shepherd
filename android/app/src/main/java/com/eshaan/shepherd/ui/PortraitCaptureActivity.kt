package com.eshaan.shepherd.ui

import com.journeyapps.barcodescanner.CaptureActivity

/**
 * The scanner, in portrait.
 *
 * zxing-android-embedded declares its own `CaptureActivity` as `sensorLandscape` in the library
 * manifest, so scanning always flipped the phone sideways however the caller configured
 * `ScanOptions`. The orientation lives on the activity, not the options, so the only fix is our
 * own subclass declared portrait in our manifest.
 */
class PortraitCaptureActivity : CaptureActivity()
