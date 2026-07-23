package com.eshaan.shepherd.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.eshaan.shepherd.ui.Key
import com.eshaan.shepherd.ui.theme.ShepherdPalette
import kotlin.math.abs

/** Dominant-axis swipe → arrow key. Screen y grows downward, so +dy = Down. Null under threshold. */
fun swipeDirection(dx: Float, dy: Float, threshold: Float): Key? {
    if (abs(dx) < threshold && abs(dy) < threshold) return null
    return if (abs(dx) >= abs(dy)) { if (dx >= 0) Key.Right else Key.Left }
    else { if (dy >= 0) Key.Down else Key.Up }
}

/** Trackpad-style pad: each drag past the step threshold emits one arrow; continuing to drag past
 *  further multiples of the step re-emits (drag-hold repeat). */
@Composable
fun SwipeNavStrip(modifier: Modifier = Modifier, onKey: (Key) -> Unit) {
    val stepPx = with(LocalDensity.current) { 24.dp.toPx() }
    Box(
        modifier.clip(RoundedCornerShape(8.dp)).background(Color(ShepherdPalette.surface2))
            .height(38.dp).widthIn(min = 120.dp)
            .pointerInput(Unit) {
                var accX = 0f; var accY = 0f
                detectDragGestures(
                    onDragStart = { accX = 0f; accY = 0f },
                    onDrag = { change, drag ->
                        change.consume(); accX += drag.x; accY += drag.y
                        swipeDirection(accX, accY, stepPx)?.let { onKey(it); accX = 0f; accY = 0f }
                    },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        Text("‹ swipe ›", style = MaterialTheme.typography.bodySmall, color = Color(ShepherdPalette.textDim))
    }
}
