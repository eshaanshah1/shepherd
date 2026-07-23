# Android App Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin all three Android screens (Pairing, Fleet, Agent) into a mobile-native premium client that matches the Mac app's design language, with the Fleet screen restructured as an attention-first inbox.

**Architecture:** A token + component foundation ported from the Mac `Theme.swift` (colors, DM Sans typography, shape/spacing) lives in `ui/theme/` and `ui/components/`; the three screens are rebuilt to compose only those primitives. Pure logic (state→color mapping, inbox sort/partition, swipe→arrow geometry) is extracted into unit-tested helpers; Compose UI is verified by compile + existing-test-green and deferred to on-device user checks.

**Tech Stack:** Kotlin, Jetpack Compose (BOM 2024.09.03 → Material3 1.3.0, Compose UI 1.7.x), DM Sans variable font, Termux `terminal-view`, JUnit4.

## Global Constraints

- **Build/verify discipline** (project standing rule): every task ends green on **compile + JVM unit tests** — `./gradlew :app:assembleDebug :app:testDebugUnitTest`, run from the `android/` directory. **Never launch the app, an emulator, or `adb install`; never kill the user's live Shepherd.** Instrumented/Compose-render checks are a deferred user-run device pass, not plan steps.
- **View-layer only:** touch only `app/src/main/java/com/eshaan/shepherd/ui/**`, new `ui/theme/**` + `ui/components/**`, `app/src/main/res/font/**`, and matching `app/src/test/**`. No transport/protocol/view-model logic changes.
- **Dark-only** for v1. No new dependencies (use Material3 1.3.0 + `material-icons-core` already present; draw the send/QR glyphs with Canvas rather than adding `material-icons-extended`).
- **Palette is authoritative** — hex values copied verbatim from the Mac `Theme.swift` dark tokens (below). Terminal grid stays `Typeface.MONOSPACE`.
- **Commit messages** end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Run all `git`/`gradlew` commands from `android/` unless a path says otherwise.

---

### Task 1: Palette + state-color realignment

Introduce the authoritative dark palette as pure hex constants and realign `ShepherdColors.dot` to the Mac's state semantics (fixes working=amber→blue etc.), with a regression test that locks the values.

**Files:**
- Create: `android/app/src/main/java/com/eshaan/shepherd/ui/theme/Palette.kt`
- Create: `android/app/src/test/java/com/eshaan/shepherd/ui/theme/PaletteTest.kt`
- Modify: `android/app/src/main/java/com/eshaan/shepherd/ui/theme/Theme.kt`

**Interfaces:**
- Produces: `object ShepherdPalette` with `Long` ARGB consts `ground, surface1, surface2, surface3, hairline, textPrimary, textSecondary, textDim` and `fun stateColorHex(state: AgentState): Long`. `ShepherdColors.dot(state): Color` (unchanged signature) now returns `Color(stateColorHex(state))`.

- [ ] **Step 1: Write the failing test**

```kotlin
// PaletteTest.kt
package com.eshaan.shepherd.ui.theme

import com.eshaan.shepherd.model.AgentState
import org.junit.Assert.assertEquals
import org.junit.Test

class PaletteTest {
    @Test fun stateColorsMatchMacSemantics() {
        assertEquals(0xFF5B9DF8L, ShepherdPalette.stateColorHex(AgentState.WORKING))    // blue
        assertEquals(0xFF43C988L, ShepherdPalette.stateColorHex(AgentState.NEEDS_CHECK)) // green
        assertEquals(0xFFE5A23DL, ShepherdPalette.stateColorHex(AgentState.BLOCKED))     // amber
        assertEquals(0xFFE5645DL, ShepherdPalette.stateColorHex(AgentState.ERROR))       // red
        assertEquals(0xFF8C8C92L, ShepherdPalette.stateColorHex(AgentState.IDLE))        // gray
        assertEquals(0xFF5F5F66L, ShepherdPalette.stateColorHex(AgentState.SHELL))       // dim
        assertEquals(0xFF5F5F66L, ShepherdPalette.stateColorHex(AgentState.UNKNOWN))     // dim
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests "com.eshaan.shepherd.ui.theme.PaletteTest"`
Expected: FAIL — `Unresolved reference: ShepherdPalette`.

- [ ] **Step 3: Write minimal implementation**

```kotlin
// Palette.kt
package com.eshaan.shepherd.ui.theme

import com.eshaan.shepherd.model.AgentState

/** Authoritative dark palette, ported verbatim from the Mac Theme.swift dark tokens.
 *  Surfaces separate by tint (no borders/shadows). ARGB Longs (0xAARRGGBB). */
object ShepherdPalette {
    const val ground        = 0xFF0F0F11L
    const val surface1      = 0xFF141417L
    const val surface2      = 0xFF1A1A1EL
    const val surface3      = 0xFF212127L
    const val hairline      = 0xFF232327L
    const val textPrimary   = 0xFFEDEDEDL
    const val textSecondary = 0xFF8C8C92L
    const val textDim        = 0xFF5F5F66L

    fun stateColorHex(state: AgentState): Long = when (state) {
        AgentState.WORKING    -> 0xFF5B9DF8L
        AgentState.NEEDS_CHECK -> 0xFF43C988L
        AgentState.BLOCKED    -> 0xFFE5A23DL
        AgentState.ERROR      -> 0xFFE5645DL
        AgentState.IDLE       -> 0xFF8C8C92L
        AgentState.SHELL, AgentState.UNKNOWN -> 0xFF5F5F66L
    }
}
```

Then rewrite `Theme.kt` to use the palette (keep `ShepherdColors.dot` signature):

```kotlin
// Theme.kt
package com.eshaan.shepherd.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.eshaan.shepherd.model.AgentState

private val ShepherdDarkColors = darkColorScheme(
    background        = Color(ShepherdPalette.ground),
    surface           = Color(ShepherdPalette.ground),
    surfaceContainer  = Color(ShepherdPalette.surface1),
    onBackground      = Color(ShepherdPalette.textPrimary),
    onSurface         = Color(ShepherdPalette.textPrimary),
    primary           = Color(0xFF5B9DF8),
    error             = Color(0xFFE5645D),
)

@Composable
fun ShepherdTheme(content: @Composable () -> Unit) =
    MaterialTheme(colorScheme = ShepherdDarkColors, typography = ShepherdTypography, content = content)

object ShepherdColors {
    fun dot(state: AgentState): Color = Color(ShepherdPalette.stateColorHex(state))
}
```

> Note: `ShepherdTypography` is added in Task 2. To keep Task 1 compiling on its own, temporarily omit the `typography = ShepherdTypography` argument in this step and add it in Task 2. (Everything else here compiles standalone.)

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests "com.eshaan.shepherd.ui.theme.PaletteTest"`
Expected: PASS.

- [ ] **Step 5: Full verify**

Run: `./gradlew :app:assembleDebug :app:testDebugUnitTest`
Expected: BUILD SUCCESSFUL, all tests green.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/java/com/eshaan/shepherd/ui/theme/Palette.kt \
        app/src/test/java/com/eshaan/shepherd/ui/theme/PaletteTest.kt \
        app/src/main/java/com/eshaan/shepherd/ui/theme/Theme.kt
git commit -m "feat(android): authoritative dark palette + realigned state colors

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: DM Sans font + Typography

Bundle the DM Sans variable font (already vendored for the Mac app) and wire a Compose `Typography` with a medium (500) default weight, matching the Mac chrome.

**Files:**
- Create: `android/app/src/main/res/font/dm_sans.ttf` (copied binary)
- Create: `android/app/src/main/res/font/dm_sans_ofl.txt` (license, copied)
- Create: `android/app/src/main/java/com/eshaan/shepherd/ui/theme/Type.kt`
- Modify: `android/app/src/main/java/com/eshaan/shepherd/ui/theme/Theme.kt` (add `typography = ShepherdTypography`)

**Interfaces:**
- Produces: `val DMSans: FontFamily`, `val ShepherdTypography: Typography`.

- [ ] **Step 1: Copy the font + license into res/font**

Run (from repo root, paths relative to `android/`):
```bash
mkdir -p app/src/main/res/font
cp ../spike/seam1/Resources/DMSans.ttf     app/src/main/res/font/dm_sans.ttf
cp ../spike/seam1/Resources/DMSans-OFL.txt app/src/main/res/font/dm_sans_ofl.txt
```
Expected: both files exist under `app/src/main/res/font/`. (`res/font` names must be lowercase, digits, `_`.)

- [ ] **Step 2: Create Type.kt**

```kotlin
// Type.kt
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
```

- [ ] **Step 3: Wire typography into the theme**

In `Theme.kt`, add the argument back:
```kotlin
fun ShepherdTheme(content: @Composable () -> Unit) =
    MaterialTheme(colorScheme = ShepherdDarkColors, typography = ShepherdTypography, content = content)
```

- [ ] **Step 4: Verify compile + tests**

Run: `./gradlew :app:assembleDebug :app:testDebugUnitTest`
Expected: BUILD SUCCESSFUL (font resource resolves; `R.font.dm_sans` exists), all tests green.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/res/font/ app/src/main/java/com/eshaan/shepherd/ui/theme/Type.kt \
        app/src/main/java/com/eshaan/shepherd/ui/theme/Theme.kt
git commit -m "feat(android): bundle DM Sans + wire Compose typography

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Inbox sort/partition (pure model)

Add the pure attention-first partition + urgency sort that drives the Fleet inbox, fully unit-tested.

**Files:**
- Create: `android/app/src/main/java/com/eshaan/shepherd/model/Inbox.kt`
- Create: `android/app/src/test/java/com/eshaan/shepherd/model/InboxTest.kt`

**Interfaces:**
- Consumes: `PaneInfo`, `AgentState` (Task 0 existing).
- Produces: `data class InboxPartition(val attention: List<PaneInfo>, val other: List<PaneInfo>)` and `object Inbox { fun rank(state: AgentState): Int; fun partition(panes: List<PaneInfo>): InboxPartition }`.

- [ ] **Step 1: Write the failing test**

```kotlin
// InboxTest.kt
package com.eshaan.shepherd.model

import com.eshaan.shepherd.protocol.PaneInfo
import org.junit.Assert.assertEquals
import org.junit.Test

class InboxTest {
    private fun p(id: String, state: String) = PaneInfo(id, id, "W", state, null)

    @Test fun attentionHoldsWantsAttentionSortedByUrgency() {
        val part = Inbox.partition(listOf(
            p("needs", "need-to-check"), p("err", "error"), p("blk", "blocked"),
            p("work", "working"), p("idle", "idle"),
        ))
        assertEquals(listOf("blk", "err", "needs"), part.attention.map { it.paneId })
        assertEquals(listOf("work", "idle"), part.other.map { it.paneId })
    }

    @Test fun otherSortsWorkingIdleShellAndKeepsStableOrderWithinState() {
        val part = Inbox.partition(listOf(
            p("shell1", "shell"), p("idle1", "idle"), p("work1", "working"),
            p("work2", "working"), p("idle2", "idle"),
        ))
        assertEquals(listOf("work1", "work2", "idle1", "idle2", "shell1"), part.other.map { it.paneId })
        assertEquals(emptyList<String>(), part.attention.map { it.paneId })
    }

    @Test fun unknownStateSortsLast() {
        val part = Inbox.partition(listOf(p("u", "bogus"), p("i", "idle")))
        assertEquals(listOf("i", "u"), part.other.map { it.paneId })
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests "com.eshaan.shepherd.model.InboxTest"`
Expected: FAIL — `Unresolved reference: Inbox`.

- [ ] **Step 3: Write minimal implementation**

```kotlin
// Inbox.kt
package com.eshaan.shepherd.model

import com.eshaan.shepherd.protocol.PaneInfo

data class InboxPartition(val attention: List<PaneInfo>, val other: List<PaneInfo>)

/** Attention-first inbox model: partition panes into "needs you" vs the rest, each sorted by
 *  urgency. Sort is stable (sortedBy preserves input order within an equal rank). */
object Inbox {
    fun rank(state: AgentState): Int = when (state) {
        AgentState.BLOCKED     -> 0
        AgentState.ERROR       -> 1
        AgentState.NEEDS_CHECK -> 2
        AgentState.WORKING     -> 3
        AgentState.IDLE        -> 4
        AgentState.SHELL       -> 5
        AgentState.UNKNOWN     -> 6
    }

    fun partition(panes: List<PaneInfo>): InboxPartition {
        val (attn, other) = panes.partition { AgentState.fromRaw(it.state).wantsAttention }
        val byRank = { p: PaneInfo -> rank(AgentState.fromRaw(p.state)) }
        return InboxPartition(attn.sortedBy(byRank), other.sortedBy(byRank))
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests "com.eshaan.shepherd.model.InboxTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/com/eshaan/shepherd/model/Inbox.kt \
        app/src/test/java/com/eshaan/shepherd/model/InboxTest.kt
git commit -m "feat(android): attention-first inbox partition/sort (pure model)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Shared component primitives

Build the reusable, screen-agnostic composables. Compose UI — verified by compile + tests-green.

**Files:**
- Create: `android/app/src/main/java/com/eshaan/shepherd/ui/components/Components.kt`

**Interfaces:**
- Consumes: `ShepherdPalette`, `ShepherdColors`, `AgentState` (Tasks 1/3).
- Produces:
  - `@Composable fun StateDot(state: AgentState, size: Dp = 10.dp, pulse: Boolean = false)`
  - `@Composable fun StatusPill(state: AgentState, label: String)`
  - `@Composable fun ConnectionChip(connected: Boolean, reconnecting: Boolean)`
  - `@Composable fun ShepherdTopBar(title: String, onBack: (() -> Unit)? = null, trailing: @Composable RowScope.() -> Unit = {})`
  - `@Composable fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true)`
  - `@Composable fun KeyPill(label: String, onClick: () -> Unit)`

- [ ] **Step 1: Write the components**

```kotlin
// Components.kt
package com.eshaan.shepherd.ui.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.eshaan.shepherd.model.AgentState
import com.eshaan.shepherd.ui.theme.ShepherdColors
import com.eshaan.shepherd.ui.theme.ShepherdPalette

@Composable
fun StateDot(state: AgentState, size: Dp = 10.dp, pulse: Boolean = false) {
    val a = if (pulse && state == AgentState.WORKING) {
        val t = rememberInfiniteTransition(label = "pulse")
        t.animateFloat(0.45f, 1f,
            infiniteRepeatable(tween(1100, easing = FastOutSlowInEasing), RepeatMode.Reverse),
            label = "pulseAlpha").value
    } else 1f
    Box(Modifier.size(size).alpha(a).clip(CircleShape).background(ShepherdColors.dot(state)))
}

@Composable
fun StatusPill(state: AgentState, label: String) {
    Row(
        Modifier.clip(RoundedCornerShape(999.dp)).background(Color(ShepherdPalette.surface2))
            .padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        StateDot(state, 8.dp)
        Text(label, style = MaterialTheme.typography.labelLarge, color = Color(ShepherdPalette.textPrimary))
    }
}

@Composable
fun ConnectionChip(connected: Boolean, reconnecting: Boolean) {
    val (color, label) = when {
        connected -> Color(0xFF43C988) to "Connected"
        reconnecting -> Color(0xFFE5A23D) to "Reconnecting…"
        else -> Color(0xFF5F5F66) to "Offline"
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(color))
        Text(label, style = MaterialTheme.typography.bodySmall, color = Color(ShepherdPalette.textSecondary))
    }
}

@Composable
fun ShepherdTopBar(title: String, onBack: (() -> Unit)? = null, trailing: @Composable RowScope.() -> Unit = {}) {
    Row(
        Modifier.fillMaxWidth().background(Color(ShepherdPalette.surface1)).padding(16.dp, 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            Text("‹", style = MaterialTheme.typography.titleLarge, color = Color(ShepherdPalette.textSecondary),
                modifier = Modifier.clip(CircleShape).clickable(onClick = onBack).padding(horizontal = 10.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(title, style = MaterialTheme.typography.titleLarge, color = Color(ShepherdPalette.textPrimary))
        Spacer(Modifier.weight(1f))
        trailing()
    }
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(
        onClick = onClick, enabled = enabled, modifier = modifier,
        shape = RoundedCornerShape(10.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = Color(0xFF5B9DF8), contentColor = Color(0xFF0F0F11),
            disabledContainerColor = Color(ShepherdPalette.surface3), disabledContentColor = Color(ShepherdPalette.textDim)),
    ) { Text(text, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold) }
}

@Composable
fun KeyPill(label: String, onClick: () -> Unit) {
    Box(
        Modifier.clip(RoundedCornerShape(8.dp)).background(Color(ShepherdPalette.surface2))
            .clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = Color(ShepherdPalette.textPrimary))
    }
}
```

- [ ] **Step 2: Verify compile + tests**

Run: `./gradlew :app:assembleDebug :app:testDebugUnitTest`
Expected: BUILD SUCCESSFUL, all tests green.

- [ ] **Step 3: Commit**

```bash
git add app/src/main/java/com/eshaan/shepherd/ui/components/Components.kt
git commit -m "feat(android): shared component primitives (dot/pill/chip/topbar/button/keypill)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: SwipeNavStrip + swipe→direction geometry

The one-line trackpad nav: a pure swipe→arrow mapping (unit-tested) plus the Compose pad that emits keys with hold-to-repeat.

**Files:**
- Create: `android/app/src/main/java/com/eshaan/shepherd/ui/components/SwipeNav.kt`
- Create: `android/app/src/test/java/com/eshaan/shepherd/ui/components/SwipeNavTest.kt`

**Interfaces:**
- Consumes: `Key` (enum in `ui/AgentViewModel.kt`).
- Produces: `fun swipeDirection(dx: Float, dy: Float, threshold: Float): Key?` (dominant-axis; null if under threshold) and `@Composable fun SwipeNavStrip(modifier: Modifier = Modifier, onKey: (Key) -> Unit)`.

- [ ] **Step 1: Write the failing test**

```kotlin
// SwipeNavTest.kt
package com.eshaan.shepherd.ui.components

import com.eshaan.shepherd.ui.Key
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SwipeNavTest {
    @Test fun horizontalDominant() {
        assertEquals(Key.Right, swipeDirection(40f, 5f, 20f))
        assertEquals(Key.Left, swipeDirection(-40f, -5f, 20f))
    }
    @Test fun verticalDominant() {
        assertEquals(Key.Down, swipeDirection(5f, 40f, 20f))   // screen y grows downward
        assertEquals(Key.Up, swipeDirection(-5f, -40f, 20f))
    }
    @Test fun belowThresholdIsNull() {
        assertNull(swipeDirection(8f, 8f, 20f))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests "com.eshaan.shepherd.ui.components.SwipeNavTest"`
Expected: FAIL — `Unresolved reference: swipeDirection`.

- [ ] **Step 3: Write minimal implementation**

```kotlin
// SwipeNav.kt
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
    val stepPx = with(androidx.compose.ui.platform.LocalDensity.current) { 24.dp.toPx() }
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
```

- [ ] **Step 4: Run test + full verify**

Run: `./gradlew :app:testDebugUnitTest --tests "com.eshaan.shepherd.ui.components.SwipeNavTest"`
Expected: PASS.
Run: `./gradlew :app:assembleDebug :app:testDebugUnitTest`
Expected: BUILD SUCCESSFUL, all green.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/com/eshaan/shepherd/ui/components/SwipeNav.kt \
        app/src/test/java/com/eshaan/shepherd/ui/components/SwipeNavTest.kt
git commit -m "feat(android): swipe-nav strip + pure swipe->arrow geometry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Fleet screen — the inbox

Rebuild `FleetScreen` as an attention-first inbox: `AttentionCard`s over thin `AgentRow`s (workspace demoted to a field), custom top bar + connection chip, pull-to-refresh, empty/loading states.

**Files:**
- Modify: `android/app/src/main/java/com/eshaan/shepherd/ui/FleetScreen.kt` (full rewrite)
- Modify: `android/app/src/main/java/com/eshaan/shepherd/ui/components/Components.kt` (append `AttentionCard`, `AgentRow`)

**Interfaces:**
- Consumes: `FleetViewModel` (`fleet`, `connected`, `connect()`, `refresh()`, `openAgent(id)`), `Inbox.partition`, all Task 4 primitives.
- Produces: `@Composable fun AttentionCard(p: PaneInfo, onClick: () -> Unit)`, `@Composable fun AgentRow(p: PaneInfo, onClick: () -> Unit)`.

- [ ] **Step 1: Append the two Fleet cards to Components.kt**

```kotlin
// append to Components.kt (add imports: com.eshaan.shepherd.protocol.PaneInfo)
@Composable
fun AttentionCard(p: PaneInfo, onClick: () -> Unit) {
    val state = AgentState.fromRaw(p.state)
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Color(ShepherdPalette.surface1))
            .clickable(onClick = onClick).padding(16.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        StateDot(state, 12.dp, pulse = false)
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(p.title, style = MaterialTheme.typography.bodyLarge, color = Color(ShepherdPalette.textPrimary))
            Text(p.workspace, style = MaterialTheme.typography.bodySmall, color = Color(ShepherdPalette.textDim))
            Text(p.reason ?: p.state, style = MaterialTheme.typography.bodyMedium,
                color = ShepherdColors.dot(state))
        }
    }
}

@Composable
fun AgentRow(p: PaneInfo, onClick: () -> Unit) {
    val state = AgentState.fromRaw(p.state)
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp, 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        StateDot(state, 10.dp, pulse = true)
        Text(p.title, style = MaterialTheme.typography.bodyLarge, color = Color(ShepherdPalette.textPrimary),
            modifier = Modifier.weight(1f))
        Text(p.workspace, style = MaterialTheme.typography.bodySmall, color = Color(ShepherdPalette.textDim))
        Text("›", style = MaterialTheme.typography.titleMedium, color = Color(ShepherdPalette.textDim))
    }
}
```

- [ ] **Step 2: Rewrite FleetScreen.kt**

```kotlin
package com.eshaan.shepherd.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.eshaan.shepherd.model.Inbox
import com.eshaan.shepherd.ui.components.*
import com.eshaan.shepherd.ui.theme.ShepherdPalette
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetScreen(vm: FleetViewModel) {
    val fleet by vm.fleet.collectAsState()
    val connected by vm.connected.collectAsState()
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { vm.connect() }
    // Clear the spinner once we reconnect (or after a short ceiling so it never hangs).
    LaunchedEffect(connected) { if (connected) refreshing = false }
    LaunchedEffect(refreshing) { if (refreshing) { delay(4000); refreshing = false } }

    val part = Inbox.partition(fleet.panes)
    val needCount = part.attention.size

    Column(Modifier.fillMaxSize().background(Color(ShepherdPalette.ground))) {
        ShepherdTopBar(title = "Agents", trailing = { ConnectionChip(connected, reconnecting = refreshing && !connected) })
        if (needCount > 0) {
            Text("$needCount need you", style = MaterialTheme.typography.bodySmall, color = Color(0xFFE5A23D),
                modifier = Modifier.padding(16.dp, 0.dp, 16.dp, 8.dp))
        }
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = { refreshing = true; vm.refresh() },
            modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                fleet.panes.isEmpty() && connected -> EmptyState()
                fleet.panes.isEmpty() -> SkeletonList()
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp, 4.dp, 12.dp, 24.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(part.attention, key = { it.paneId }) { AttentionCard(it) { vm.openAgent(it.paneId) } }
                    if (part.attention.isNotEmpty() && part.other.isNotEmpty()) item { Spacer(Modifier.height(8.dp)) }
                    items(part.other, key = { it.paneId }) { AgentRow(it) { vm.openAgent(it.paneId) } }
                }
            }
        }
    }
}

@Composable
private fun EmptyState() {
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally) {
        Text("No agents running", style = MaterialTheme.typography.titleMedium, color = Color(ShepherdPalette.textSecondary))
        Spacer(Modifier.height(6.dp))
        Text("Start `claude` in a Shepherd pane on your Mac — it'll show up here.",
            style = MaterialTheme.typography.bodyMedium, color = Color(ShepherdPalette.textDim), textAlign = TextAlign.Center)
    }
}

@Composable
private fun SkeletonList() {
    Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        repeat(4) {
            Box(Modifier.fillMaxWidth().height(64.dp)
                .background(Color(ShepherdPalette.surface1), androidx.compose.foundation.shape.RoundedCornerShape(14.dp)))
        }
    }
}
```

- [ ] **Step 3: Verify compile + tests**

Run: `./gradlew :app:assembleDebug :app:testDebugUnitTest`
Expected: BUILD SUCCESSFUL, all tests green.

- [ ] **Step 4: Commit**

```bash
git add app/src/main/java/com/eshaan/shepherd/ui/FleetScreen.kt \
        app/src/main/java/com/eshaan/shepherd/ui/components/Components.kt
git commit -m "feat(android): Fleet inbox — attention cards over thin rows, pull-to-refresh

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Agent screen — contained terminal + one-line key bar

Rebuild `AgentScreen`'s chrome: a bordered/inset terminal pane, a `StatusPill` top bar, a one-line key bar (`KeyPill`s + `SwipeNavStrip` + collapse handle), and a circular accent send button. Terminal/emulator wiring and `PromptPanel` invocation are preserved verbatim.

**Files:**
- Modify: `android/app/src/main/java/com/eshaan/shepherd/ui/AgentScreen.kt`

**Interfaces:**
- Consumes: `AgentViewModel`, `RemoteTerminalSession`, `Key`/`escBytesFor`, Task 4/5 components.
- Preserves: `pushGridSize`, `TERM_TEXT_SIZE_PX`, `gridPaint`, `inputClient`, the `AndroidView` factory/update blocks, and the `PromptPanel(...)` call — copy them unchanged from the current file.

- [ ] **Step 1: Rewrite the composable chrome**

Keep `pushGridSize`, `gridPaint`, `TERM_TEXT_SIZE_PX`, `statusLabel`, `inputClient`, and the `AndroidView` factory/update lambdas byte-for-byte from the current `AgentScreen.kt`. Replace the top bar, the terminal container, `ExtraKeysRow`, and `InputField` as below. New imports: `com.eshaan.shepherd.ui.components.*`, `com.eshaan.shepherd.ui.theme.ShepherdPalette`, `androidx.compose.foundation.border`, `androidx.compose.foundation.shape.RoundedCornerShape`, `androidx.compose.foundation.shape.CircleShape`, `androidx.compose.ui.draw.clip`, `androidx.compose.foundation.Canvas`, `androidx.compose.ui.geometry.Offset`, `androidx.compose.ui.graphics.Path`.

```kotlin
    Scaffold(
        containerColor = Color(ShepherdPalette.ground),
        topBar = {
            val (dotState, word) = statusPill(status, vm)
            ShepherdTopBar(title = vm.paneId.take(8), onBack = onBack,
                trailing = { StatusPill(dotState, word) })
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().background(Color(ShepherdPalette.ground))) {
            val s = session
            val p = prompt
            if (s != null && p != null && !forceTerminal) {
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    PromptPanel(p, onAnswer = { s.sendPaced(it) }, onUseTerminal = { forceTerminal = true })
                }
            } else if (s != null) {
                // Contained terminal pane: rounded, hairline border, inset from the chrome.
                Box(
                    Modifier.weight(1f).fillMaxWidth().padding(12.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .border(1.dp, Color(ShepherdPalette.hairline), RoundedCornerShape(12.dp))
                        .clipToBounds()
                ) {
                    AndroidView(
                        modifier = Modifier.fillMaxSize(),
                        factory = { ctx -> /* UNCHANGED factory block from current file */ TODO() },
                        update = { view -> /* UNCHANGED update block from current file */ },
                    )
                }
                var navShown by remember { mutableStateOf(true) }
                Column(Modifier.fillMaxWidth().background(Color(ShepherdPalette.surface1))) {
                    if (navShown) KeyBar(s)
                    InputRow(s)
                }
            } else {
                Box(Modifier.weight(1f).fillMaxWidth())
            }
        }
    }
```

> Replace the two `TODO()`/comment placeholders with the exact `factory`/`update` lambda bodies from the current `AgentScreen.kt` (Steps in the current file lines 93–116). They are copied verbatim — no logic change.

- [ ] **Step 2: Add the new status-pill mapper, key bar, and input row**

```kotlin
private fun statusPill(status: DataStatus, vm: AgentViewModel): Pair<com.eshaan.shepherd.model.AgentState, String> =
    when (status) {
        is DataStatus.Connecting  -> com.eshaan.shepherd.model.AgentState.WORKING to "Connecting…"
        is DataStatus.Ready       -> com.eshaan.shepherd.model.AgentState.IDLE to "Ready"
        is DataStatus.Rejected    -> com.eshaan.shepherd.model.AgentState.ERROR to "Rejected"
        is DataStatus.Disconnected -> com.eshaan.shepherd.model.AgentState.SHELL to "Disconnected"
    }

@Composable
private fun KeyBar(session: RemoteTerminalSession) {
    Row(
        Modifier.fillMaxWidth().padding(8.dp, 6.dp),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        KeyPill("Esc") { session.sendInput(escBytesFor(Key.Esc)) }
        KeyPill("^C") { session.sendInput(escBytesFor(Key.CtrlC)) }
        KeyPill("Tab") { session.sendInput(escBytesFor(Key.Tab)) }
        KeyPill("↵") { session.sendInput(escBytesFor(Key.Enter)) }
        Spacer(Modifier.weight(1f))
        SwipeNavStrip { key -> session.sendInput(escBytesFor(key)) }
    }
}

@Composable
private fun InputRow(session: RemoteTerminalSession) {
    var text by remember { mutableStateOf("") }
    val send = { if (text.isNotEmpty()) { session.sendInput((text + "\r").toByteArray()); text = "" } }
    Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = text, onValueChange = { text = it }, modifier = Modifier.weight(1f), singleLine = true,
            shape = RoundedCornerShape(10.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = Color(ShepherdPalette.surface2), unfocusedContainerColor = Color(ShepherdPalette.surface2),
                focusedBorderColor = Color(0xFF5B9DF8), unfocusedBorderColor = Color(ShepherdPalette.hairline)),
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSend = { send() }),
        )
        Box(Modifier.size(48.dp).clip(CircleShape).background(Color(0xFF5B9DF8))
            .clickable { send() }, contentAlignment = androidx.compose.ui.Alignment.Center) {
            Canvas(Modifier.size(20.dp)) {
                val path = Path().apply {  // paper-plane triangle
                    moveTo(0f, 0f); lineTo(size.width, size.height / 2); lineTo(0f, size.height); close()
                }
                drawPath(path, Color(0xFF0F0F11))
            }
        }
    }
}
```

> Delete the old `ExtraKeysRow`, `keyButton`, and `InputField` composables. `statusLabel` is no longer used by the top bar; remove it too.

- [ ] **Step 3: Verify compile + tests**

Run: `./gradlew :app:assembleDebug :app:testDebugUnitTest`
Expected: BUILD SUCCESSFUL, all tests green.

- [ ] **Step 4: Commit**

```bash
git add app/src/main/java/com/eshaan/shepherd/ui/AgentScreen.kt
git commit -m "feat(android): Agent screen — contained terminal, one-line key bar, swipe nav

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Prompt panel — option cards

Restyle `PromptPanel`'s `AskUserQuestion` rendering into tappable `OptionCard`s with a proper Submit + sending state. `answerSteps` and the submit/selection logic are unchanged (already covered by `PromptPanelTest`).

**Files:**
- Modify: `android/app/src/main/java/com/eshaan/shepherd/ui/PromptPanel.kt`
- Modify: `android/app/src/main/java/com/eshaan/shepherd/ui/components/Components.kt` (append `OptionCard`)

**Interfaces:**
- Consumes: `ControlMessage.Prompt`, `PromptQuestion`, `answerSteps` (unchanged), Task 4 `PrimaryButton`.
- Produces: `@Composable fun OptionCard(label: String, selected: Boolean, multi: Boolean, onClick: () -> Unit)`.

- [ ] **Step 1: Append OptionCard to Components.kt**

```kotlin
// append to Components.kt
@Composable
fun OptionCard(label: String, selected: Boolean, multi: Boolean, onClick: () -> Unit) {
    val bg = if (selected) Color(0x225B9DF8) else Color(ShepherdPalette.surface2)
    val bar = if (selected) Color(0xFF5B9DF8) else Color.Transparent
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(bg)
            .clickable(onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(4.dp).height(52.dp).background(bar))
        Text(label, style = MaterialTheme.typography.bodyLarge, color = Color(ShepherdPalette.textPrimary),
            modifier = Modifier.weight(1f).padding(14.dp))
        if (selected) Text(if (multi) "☑" else "✓", color = Color(0xFF5B9DF8),
            modifier = Modifier.padding(end = 14.dp), style = MaterialTheme.typography.titleMedium)
    }
}
```

- [ ] **Step 2: Rewrite PromptPanel's body**

Preserve `answerSteps` (top of file) verbatim. Replace the `Column` body: keep `submitting`, `loneSingle`, `selections`, and `submit` exactly; swap the option rendering to `OptionCard`s and use `PrimaryButton` for Submit; restyle the sending block as a card. Full new body:

```kotlin
@Composable
fun PromptPanel(prompt: ControlMessage.Prompt, onAnswer: (List<List<ByteArray>>) -> Unit, onUseTerminal: () -> Unit) {
    var submitting by remember(prompt) { mutableStateOf(false) }
    Column(
        Modifier.fillMaxSize().background(Color(ShepherdPalette.ground)).padding(16.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (submitting) {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                .background(Color(ShepherdPalette.surface1)).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = Color(0xFF5B9DF8))
                    Text("Sending your answers…", color = Color(ShepherdPalette.textPrimary),
                        style = MaterialTheme.typography.titleMedium)
                }
                Text("Sent one question at a time — this takes a few seconds.",
                    color = Color(ShepherdPalette.textDim), style = MaterialTheme.typography.bodySmall)
            }
            TextButton(onClick = onUseTerminal) { Text("Use terminal instead") }
            return@Column
        }

        if (prompt.kind == "askUserQuestion") {
            val questions = prompt.questions ?: emptyList()
            val loneSingle = questions.size == 1 && !questions[0].multiSelect
            val selections = remember(prompt) { mutableStateMapOf<Int, Set<Int>>() }
            val submit = { sel: Map<Int, Set<Int>> -> submitting = true; onAnswer(answerSteps(questions, sel)) }

            questions.forEachIndexed { qi, q ->
                Text(q.prompt, style = MaterialTheme.typography.titleMedium, color = Color(ShepherdPalette.textPrimary))
                q.options.forEachIndexed { oi, label ->
                    val checked = selections[qi]?.contains(oi) == true
                    OptionCard(label, checked, q.multiSelect) {
                        if (loneSingle) submit(mapOf(qi to setOf(oi)))
                        else if (q.multiSelect) {
                            val cur = selections[qi] ?: emptySet()
                            selections[qi] = if (checked) cur - oi else cur + oi
                        } else selections[qi] = setOf(oi)
                    }
                }
                Spacer(Modifier.height(4.dp))
            }
            if (!loneSingle) PrimaryButton("Submit", { submit(selections.toMap()) }, Modifier.fillMaxWidth())
        } else {
            val title = if (prompt.kind == "permission") "Permission: ${prompt.detail ?: ""}" else "Plan approval"
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                .background(Color(ShepherdPalette.surface1)).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = Color(ShepherdPalette.textPrimary))
                Text("Answer in the terminal.", color = Color(ShepherdPalette.textDim),
                    style = MaterialTheme.typography.bodyMedium)
            }
        }
        TextButton(onClick = onUseTerminal) { Text("Use terminal instead") }
    }
}
```

New imports: `com.eshaan.shepherd.ui.components.OptionCard`, `com.eshaan.shepherd.ui.components.PrimaryButton`, `com.eshaan.shepherd.ui.theme.ShepherdPalette`, `androidx.compose.foundation.shape.RoundedCornerShape`, `androidx.compose.ui.draw.clip`. Drop the old `Color.Black`/`Color.White`/`Color.Gray` usages and the `Button`/`Checkbox`/`RadioButton` imports if now unused.

- [ ] **Step 3: Verify — existing PromptPanelTest must stay green**

Run: `./gradlew :app:testDebugUnitTest --tests "com.eshaan.shepherd.ui.PromptPanelTest"`
Expected: PASS (submit logic unchanged).
Run: `./gradlew :app:assembleDebug :app:testDebugUnitTest`
Expected: BUILD SUCCESSFUL, all green.

- [ ] **Step 4: Commit**

```bash
git add app/src/main/java/com/eshaan/shepherd/ui/PromptPanel.kt \
        app/src/main/java/com/eshaan/shepherd/ui/components/Components.kt
git commit -m "feat(android): prompt panel as option cards + sending card

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Pairing screen — onboarding layout

Rebuild `PairingScreen` as a centered onboarding: a Shepherd wordmark, headline + instruction, a `PrimaryButton` scan action, manual entry behind a quiet toggle in a `surface2` card, and status as a chip. Pairing logic (scan launcher, `vm.pair`, state machine) is unchanged.

**Files:**
- Modify: `android/app/src/main/java/com/eshaan/shepherd/ui/PairingScreen.kt` (full rewrite of the layout; keep the `scanLauncher`, `vm.pair`, and `LaunchedEffect(state)` logic verbatim)

**Interfaces:**
- Consumes: `PairingViewModel`, `PairingState`, `PairingPayload`, `ScanContract`/`ScanOptions`, Task 4 `PrimaryButton`.

- [ ] **Step 1: Rewrite PairingScreen.kt**

```kotlin
package com.eshaan.shepherd.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.eshaan.shepherd.pairing.PairingState
import com.eshaan.shepherd.protocol.PairingPayload
import com.eshaan.shepherd.ui.components.PrimaryButton
import com.eshaan.shepherd.ui.theme.ShepherdPalette
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

@Composable
fun PairingScreen(vm: PairingViewModel, onPaired: () -> Unit) {
    val state by vm.state.collectAsState()
    var showManual by remember { mutableStateOf(false) }
    var scanError by remember { mutableStateOf<String?>(null) }
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("8722") }
    LaunchedEffect(state) { if (state is PairingState.Paired) onPaired() }

    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents ?: return@rememberLauncherForActivityResult
        val p = PairingPayload.parse(contents)
        if (p == null) scanError = "That QR isn't a Shepherd pairing code."
        else { scanError = null; vm.pair(p.host ?: "", p.ip, p.port) }
    }

    Column(
        Modifier.fillMaxSize().background(Color(ShepherdPalette.ground)).padding(28.dp),
        verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Shepherd", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold,
            color = Color(ShepherdPalette.textPrimary))
        Spacer(Modifier.height(10.dp))
        Text("Pair with a Shepherd host", style = MaterialTheme.typography.titleMedium,
            color = Color(ShepherdPalette.textSecondary), textAlign = TextAlign.Center)
        Spacer(Modifier.height(4.dp))
        Text("On the Mac: ⋯ menu → Connect a phone… → scan the QR.",
            style = MaterialTheme.typography.bodyMedium, color = Color(ShepherdPalette.textDim), textAlign = TextAlign.Center)
        Spacer(Modifier.height(24.dp))

        PrimaryButton("Scan QR to pair", {
            scanError = null
            scanLauncher.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setBeepEnabled(false).setPrompt("Scan the Shepherd QR").setOrientationLocked(false))
        }, Modifier.fillMaxWidth())

        scanError?.let { Spacer(Modifier.height(8.dp)); Text(it, color = Color(0xFFE5645D)) }

        Spacer(Modifier.height(12.dp))
        TextButton(onClick = { showManual = !showManual }) {
            Text(if (showManual) "Hide manual entry" else "Enter host manually",
                color = Color(ShepherdPalette.textSecondary))
        }
        if (showManual) {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp))
                .background(Color(ShepherdPalette.surface2)).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(host, { host = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    label = { Text("Host (Tailscale 100.x or MagicDNS)") })
                OutlinedTextField(port, { port = it.filter(Char::isDigit) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    label = { Text("Port") })
                PrimaryButton("Pair", { vm.pair(host.trim(), null, port.toIntOrNull() ?: 8722) },
                    Modifier.fillMaxWidth(), enabled = host.isNotBlank())
            }
        }

        Spacer(Modifier.height(16.dp))
        when (val s = state) {
            PairingState.Connecting -> StatusLine(Color(0xFFE5A23D), "Connecting…")
            PairingState.WaitingApproval -> StatusLine(Color(0xFFE5A23D), "Waiting for approval on the host…")
            is PairingState.Error -> StatusLine(Color(0xFFE5645D), "Failed: ${s.reason}")
            else -> {}
        }
    }
}

@Composable
private fun StatusLine(color: Color, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        CircularProgressIndicator(Modifier.size(16.dp), color = color, strokeWidth = 2.dp)
        Text(text, color = color, style = MaterialTheme.typography.bodyMedium)
    }
}
```

> The error `StatusLine` shows a spinner too; that's cosmetically fine, but if you prefer no spinner on error, guard it — optional. Keep as-is for simplicity.

- [ ] **Step 2: Verify compile + tests**

Run: `./gradlew :app:assembleDebug :app:testDebugUnitTest`
Expected: BUILD SUCCESSFUL, all tests green.

- [ ] **Step 3: Commit**

```bash
git add app/src/main/java/com/eshaan/shepherd/ui/PairingScreen.kt
git commit -m "feat(android): Pairing onboarding layout + status chip

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Deferred (post-plan, user-run device pass)

- On-device visual verification of all three screens (emulator/phone), rotation, keyboard show/hide, and the swipe-nav feel — per the project's "subagents never launch the app" rule.
- Light/warm theme parity with the Mac.
- Bundling JetBrains Mono for the terminal grid (touches grid metrics; separate slice).
- Error `StatusLine` spinner suppression (cosmetic, optional).

## Self-Review Notes

- **Spec coverage:** foundation (Task 1–2), reusable components incl. all 10 named in the spec (Tasks 4/5/6/8 — StateDot, StatusPill, ConnectionChip, ShepherdTopBar, PrimaryButton, KeyPill, SwipeNavStrip, AttentionCard, AgentRow, OptionCard), Fleet inbox w/ zones + connection chip + pull-to-refresh + empty/skeleton (Task 6), Agent contained terminal + one-line key bar + swipe strip + circular send + status pill + prompt option cards (Tasks 7–8), Pairing onboarding + status chip (Task 9). Palette realignment + DM Sans covered (Tasks 1–2). All spec sections map to a task.
- **No new dependencies:** send/QR glyphs are Canvas-drawn; icons limited to text glyphs (`‹`, `›`, `↵`, `✓`).
- **Type consistency:** `Key`/`escBytesFor` reused from `ui/AgentViewModel.kt`; `ShepherdColors.dot` signature unchanged; `answerSteps` untouched so `PromptPanelTest` still applies.
