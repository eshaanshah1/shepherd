package com.eshaan.shepherd.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Tabler line-icon path data (24×24 grid, 2px stroke) — the same line-icon set the Mac chrome
 *  uses (see Tabler in SidebarView.swift), so glyphs read as thin strokes across both platforms. */
object Tabler {
    val send = listOf(
        "M10 14l11 -11",
        "M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5",
    )
    val cornerDownLeft = listOf("M18 6v6a3 3 0 0 1 -3 3h-10l4 -4m0 8l-4 -4")
}

/** Renders a Tabler stroke-icon from its SVG path list, scaled from the 24×24 grid to [size] and
 *  stroked at 2 grid-units with round caps/joins — mirrors the Mac's TablerIcon renderer. */
@Composable
fun TablerIcon(paths: List<String>, color: Color, size: Dp = 18.dp, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        val s = this.size.minDimension / 24f
        val stroke = Stroke(width = 2f, cap = StrokeCap.Round, join = StrokeJoin.Round)
        scale(s, pivot = Offset.Zero) {
            for (d in paths) drawPath(PathParser().parsePathString(d).toPath(), color, style = stroke)
        }
    }
}
