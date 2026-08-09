package com.eshaan.shepherd.v2

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.eshaan.shepherd.ui.theme.ShepherdPalette

/**
 * Whatever the Mac contributes, drawn as a list.
 *
 * **Nothing here knows what a task is.** It draws rows: a label, an optional
 * description, a status dot, a busy state. `tasks` produces some today; a
 * `projects` extension would produce others tomorrow and this file would not
 * change. That is the entire point of rendering contributed views rather than a
 * bespoke fleet screen — and it is only possible because the host's row type
 * names SEMANTICS (a design-token name, a glyph name) rather than pixels.
 *
 * The tint mapping is this renderer's own, deliberately. The Mac says "accent"
 * or "danger"; what those look like on a phone in dark mode is a decision for
 * the phone, and a host that sent `#RRGGBB` would be a host deciding how a
 * screen it cannot see should look.
 */
@Composable
fun BrowseScreen(
    model: BrowseViewModel,
    onOpenSession: (String) -> Unit,
) {
    val state by model.state.collectAsState()

    // A tap that asked for a terminal. Consumed once, so returning to this
    // screen does not immediately re-open what you just came back from.
    androidx.compose.runtime.LaunchedEffect(state.openSession) {
        state.openSession?.let {
            onOpenSession(it)
            model.openedSession()
        }
    }
    androidx.compose.runtime.LaunchedEffect(Unit) { model.loadViews() }

    Column(Modifier.fillMaxSize().background(Color(ShepherdPalette.ground))) {
        // The view picker, shown only when there is a choice to make. One
        // contributed view needs no chrome saying so.
        if (state.views.size > 1) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                state.views.forEach { view ->
                    val selected = view.type == state.selected
                    Text(
                        text = view.title,
                        color = if (selected) Color(ShepherdPalette.textPrimary) else Color(ShepherdPalette.textDim),
                        fontSize = 13.sp,
                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (selected) Color(ShepherdPalette.surface2) else Color.Transparent)
                            .clickable { model.select(view.type) }
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                    )
                }
            }
        }

        state.error?.let { message ->
            Text(
                message,
                color = Color(ERROR),
                fontSize = 12.sp,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
        }

        if (state.rows.isEmpty() && !state.loading) {
            // An empty contributed view is a real state — no tasks yet — and
            // saying so beats a blank screen that looks like a failed load.
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Nothing here yet", color = Color(ShepherdPalette.textDim), fontSize = 14.sp)
            }
            return@Column
        }

        LazyColumn(Modifier.fillMaxSize()) {
            items(state.rows, key = { it.id }) { row ->
                if (row.section) SectionHeading(row) else RowItem(row) { model.tap(row) }
            }
        }
    }
}

@Composable
private fun SectionHeading(row: Row) {
    Row(
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            row.label.uppercase(),
            color = Color(ShepherdPalette.textDim),
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
        )
        row.description?.let {
            Spacer(Modifier.width(6.dp))
            Text(it, color = Color(ShepherdPalette.textDim), fontSize = 11.sp)
        }
    }
}

@Composable
private fun RowItem(row: Row, onTap: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            // A row with no command is not tappable, and must not pretend to be:
            // the extension decides which rows do something.
            .clickable(enabled = row.command != null) { onTap() }
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusDot(row)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                row.label,
                color = Color(ShepherdPalette.textPrimary),
                fontSize = 15.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            row.description?.let {
                Text(
                    it,
                    color = Color(ShepherdPalette.textDim),
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/**
 * The row's state, as a dot.
 *
 * `busy` is drawn as its own colour rather than an animation for the reason the
 * host's own comment gives: the operations behind a contributed row have no
 * honest denominator, so anything resembling progress would be inventing one.
 */
@Composable
private fun StatusDot(row: Row) {
    val colour = when {
        row.busy -> Color(WORKING)
        else -> tint(row.tint)
    }
    Box(Modifier.size(8.dp).clip(CircleShape).background(colour))
}

/**
 * A design-token NAME to a colour on THIS screen.
 *
 * The mapping lives here because the phone owns how it looks; the Mac owns what
 * it means. An unknown token falls back to dim rather than to a guess — a new
 * host naming a token this build has never seen should render a plain row, not
 * a wrong one.
 */
private fun tint(token: String?): Color = when (token) {
    "accent" -> Color(WORKING)
    "danger", "error" -> Color(ERROR)
    "success", "ok", "done" -> Color(DONE)
    "warning", "attention", "blocked" -> Color(BLOCKED)
    else -> Color(ShepherdPalette.textDim)
}

// The same state colours the Mac's own chrome uses, so a row reads the same on
// both screens without either sending the other a hex.
private const val WORKING = 0xFF5B9DF8L
private const val DONE = 0xFF43C988L
private const val BLOCKED = 0xFFE5A23DL
private const val ERROR = 0xFFE5645DL
