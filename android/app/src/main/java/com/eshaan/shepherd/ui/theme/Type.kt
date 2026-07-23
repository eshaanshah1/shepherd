@file:OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)

package com.eshaan.shepherd.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.eshaan.shepherd.R

/** DM Sans, driven through the variable font's weight axis. minSdk 31 supports variationSettings. */
val DMSans = FontFamily(
    Font(R.font.dm_sans, FontWeight.Normal,   variationSettings = FontVariation.Settings(FontVariation.weight(400))),
    Font(R.font.dm_sans, FontWeight.Medium,   variationSettings = FontVariation.Settings(FontVariation.weight(500))),
    Font(R.font.dm_sans, FontWeight.SemiBold, variationSettings = FontVariation.Settings(FontVariation.weight(600))),
    Font(R.font.dm_sans, FontWeight.Bold,     variationSettings = FontVariation.Settings(FontVariation.weight(700))),
)

/** Medium (500) default weight, matching the Mac's Font.ui. Only the styles the app uses. */
val ShepherdTypography = Typography(
    titleLarge  = TextStyle(fontFamily = DMSans, fontWeight = FontWeight.SemiBold, fontSize = 24.sp),
    titleMedium = TextStyle(fontFamily = DMSans, fontWeight = FontWeight.Medium,   fontSize = 17.sp),
    bodyLarge   = TextStyle(fontFamily = DMSans, fontWeight = FontWeight.Medium,   fontSize = 16.sp),
    bodyMedium  = TextStyle(fontFamily = DMSans, fontWeight = FontWeight.Normal,   fontSize = 14.sp),
    bodySmall   = TextStyle(fontFamily = DMSans, fontWeight = FontWeight.Normal,   fontSize = 13.sp),
    labelLarge  = TextStyle(fontFamily = DMSans, fontWeight = FontWeight.Medium,   fontSize = 13.sp),
    labelSmall  = TextStyle(fontFamily = DMSans, fontWeight = FontWeight.SemiBold, fontSize = 11.sp),
)
