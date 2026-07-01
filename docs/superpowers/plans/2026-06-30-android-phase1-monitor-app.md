# Android Phase 1 — Monitor App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Shepherd Android **monitor** app — pair with a macOS host over Tailscale, show the live agent fleet with state dots, and get an FCM push (→ local notification) when an agent needs you. No terminal view (that's Phase 2).

**Architecture:** A single-module Jetpack-Compose app (`:app`). Pure-Kotlin packages (`protocol`, `model`, `pairing` state machine) hold all logic and are JVM-unit-tested; Android-coupled packages (`transport`, `data`, `fcm`, `ui`) wrap them. The phone is a TCP client of the host's existing control server (`RemoteServer.swift`, port 8722), speaking the **same framed wire protocol** re-implemented in Kotlin. FCM data-only wakes (project `shepherd-da653`) decouple alerting from connectivity: a wake arrives via Google even when the app is swiped away, then the app dials the host over Tailscale to pull context and raise a local notification.

**Tech Stack:** Kotlin 2.0.20, Jetpack Compose (BOM 2024.09.03), Gradle 8.9, AGP 8.6.1, kotlinx-serialization-json 1.7.1 (JVM-testable JSON tree — **not** `org.json`, which is stubbed in unit tests), Firebase BOM 33.3.0 (firebase-messaging), AndroidX Security (EncryptedSharedPreferences), minSdk 31 / compileSdk 35 / targetSdk 35.

## Global Constraints

- **applicationId / namespace = `com.eshaan.shepherd`** — pinned by `google-services.json` (project `shepherd-da653`). FCM registration fails if this differs. Copy verbatim.
- **minSdk 31, compileSdk 35, targetSdk 35.** Build-tools 35.0.1 and platform `android-35` are already installed.
- **JSON library: kotlinx-serialization (`JsonElement` tree API).** Do NOT use `org.json` for protocol code — it is a non-functional stub on the JVM unit-test classpath and will throw `RuntimeException("Stub!")`. kotlinx-serialization runs on plain JVM tests.
- **Wire protocol is implemented twice** (Swift host + Kotlin client). It is **defined once** in Task 2 against captured golden vectors. Keep it small, additive, versioned (`protocolVersion = 1`). The exact JSON shapes (below) are non-negotiable interop contracts — match them byte-for-key.
- **Build/verify discipline (project standing rule, [[shepherd-dont-kill-while-live]]):** every task ends green on **compile + JVM unit/integration tests** (`./gradlew :app:assembleDebug :app:testDebugUnitTest`). **Subagents NEVER launch the app, an emulator, or `adb install`** and never kill the user's live Shepherd. Instrumented/Compose-UI rendering, real FCM delivery, and live pairing are a **deferred user-run device checklist** (end of this doc), not subagent steps.
- **Every Gradle command MUST be prefixed** with `JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home` (the brew JDK 17 is not registered with macOS `java_home`, which resolves to JDK 11 and breaks AGP 8.6).
- **All Android work lives in `android/`** (subdir of this repo — one git history, shared protocol doc). The one **host** task (Task 9) is Swift in `spike/seam1/` and is built/tested with `xcodebuild`, not Gradle.
- **Commit on branch `android-monitor-app`. Do NOT create a new branch per task** (the global "branch per task" rule fights single-branch SDD). `git add` only the task's own files — never `-A`/`.`.
- Commit messages end with the project Co-Authored-By line.
- `google-services.json` is **staged** at the session scratchpad `…/scratchpad/google-services.json`; Task 1 copies it to `android/app/google-services.json` and **gitignores** it (mirrors the host's gitignored `~/.config/shepherd/fcm-service-account.json`).

---

## The wire protocol (captured ground truth — the interop contract)

Frame = `[u32 big-endian length][utf8 JSON]`. Example: `Ping` → bytes `00 00 00 0b` + `{"ping":{}}` (len 11). Max frame 8 MiB (reject larger).

Each `ControlMessage` is a **single-key JSON object** keyed by the case name (externally tagged). **Nil/absent optionals are OMITTED, never `null`.** Captured from the real `RemoteProtocol.swift` via `JSONEncoder`:

| Message | Direction | Exact JSON |
|---|---|---|
| `hello` (first pair) | P→H | `{"hello":{"protocolVersion":1,"pairingCode":"0042","fcmToken":"tok","secret":"<phone-secret>","deviceID":"dev-123","deviceName":"Pixel 8"}}` |
| `hello` (reconnect) | P→H | `{"hello":{"protocolVersion":1,"fcmToken":"tok","deviceID":"dev-123","deviceName":"Pixel 8","secret":"<phone-secret>"}}` (no `pairingCode`) |
| `refreshFCMToken` | P→H | `{"refreshFCMToken":{"token":"newtok"}}` |
| `accepted` | H→P | `{"accepted":{"sessionNonce":"nonce-1"}}` |
| `rejected` | H→P | `{"rejected":{"reason":"bad secret"}}` |
| `pendingApproval` | H→P | `{"pendingApproval":{}}` |
| `snapshot` | H→P | `{"snapshot":{"panes":[{"paneID":"p1","state":"blocked","title":"~/proj","reason":"approve Bash","workspace":"Work"}]}}` |
| `state` (no reason) | H→P | `{"state":{"paneID":"p1","state":"working"}}` |
| `paneAdded` | H→P | `{"paneAdded":{"_0":{"paneID":"p1","state":"blocked","title":"~/proj","reason":"…","workspace":"Work"}}}` |
| `paneRemoved` | H→P | `{"paneRemoved":{"paneID":"p1"}}` |
| `paneRenamed` | H→P | `{"paneRenamed":{"paneID":"p1","title":"new"}}` |
| `detach` | P→H | `{"detach":{}}` |
| `ping` | P→H | `{"ping":{}}` |
| `pong` | H→P | `{"pong":{}}` |

**Critical details:**
- `paneAdded` wraps the pane under key **`_0`** (Swift unlabeled associated value). The others use the field labels shown.
- JSON object key **order does not matter** (both sides use keyed decoders) — emit any order.
- `PaneInfo` keys: `paneID`, `title`, `workspace`, `state` (an `AgentState.rawValue`), `reason` (omit when nil).
- `AgentState.rawValue` strings: `shell`, `working`, `blocked`, **`need-to-check`** (note the hyphen — *not* `needsCheck`), `idle`, `error`. **Attention-worthy** = `blocked`, `need-to-check`, `error`.
- Empty-payload messages (`pendingApproval`, `detach`, `ping`, `pong`) serialize as `{"case":{}}` — an empty object, not a bare string.

**FCM data-only wake payload** (host `buildWakeMessage`) — what `onMessageReceived` reads from `remoteMessage.data`:
```
{ "paneID": "<id>", "state": "<AgentState.rawValue>", "urgent": "true" | "false" }
```
plus `android: { priority: high|normal }`. No `notification` block — the app raises its own local notification.

**Pairing secret model (see Task 9):** the **phone generates and owns** its per-device secret (a UUID stored once). It sends that secret in the *first* `hello` alongside the `pairingCode`; the host persists the phone-supplied secret and checks it on every reconnect. (The shipped host mints its own secret and never returns it — a real reconnect gap fixed in Task 9.)

**Host connection sequence:** phone connects → sends `hello` → host replies one of:
- `rejected{reason}` → fail, surface reason.
- `pendingApproval{}` → host is showing its approve sheet; keep the socket open and wait for the next frame.
- `accepted{sessionNonce}` → immediately followed by `snapshot{panes}`. Store the nonce (Phase 2 data-channel gating; unused in Phase 1). Apply the snapshot. Then live deltas (`state`/`paneAdded`/`paneRemoved`/`paneRenamed`) stream until detach/disconnect.

Host only **responds** to `ping` with `pong`; it never initiates pings. The **phone owns the heartbeat**.

---

## File structure

```
android/
  settings.gradle.kts            # root settings, dependencyResolutionManagement
  build.gradle.kts               # root: plugin versions via pluginManagement
  gradle.properties              # AndroidX, JVM args
  gradle/wrapper/                # wrapper jar + properties (Gradle 8.9)
  gradlew  gradlew.bat
  local.properties               # sdk.dir (GITIGNORED)
  .gitignore
  app/
    build.gradle.kts             # the :app module config
    google-services.json         # Firebase client config (GITIGNORED)
    proguard-rules.pro
    src/
      main/
        AndroidManifest.xml
        java/com/eshaan/shepherd/
          MainActivity.kt
          ShepherdApp.kt          # Application (Firebase init is automatic)
          protocol/               # PURE — JVM tested
            ControlMessage.kt
            PaneInfo.kt
            WireCodec.kt          # frame + JSON encode/decode (kotlinx tree)
          model/                  # PURE — JVM tested
            AgentState.kt
            Fleet.kt
          transport/
            RemoteConnection.kt   # TCP, framing I/O, handshake, heartbeat, backoff
          data/
            PairingStore.kt       # interface + InMemory fake (PURE)
            EncryptedPairingStore.kt   # AndroidX Security impl (device-deferred)
            DeviceIdentity.kt     # deviceId UUID + deviceName
          pairing/
            PairingController.kt  # PURE state machine (JVM tested)
          fcm/
            FcmWake.kt            # PURE: parse wake data, build notification content
            ShepherdMessagingService.kt   # FirebaseMessagingService
            Notifications.kt      # channel + post (Android)
          ui/
            FleetViewModel.kt
            FleetScreen.kt        # Compose
            PairingViewModel.kt
            PairingScreen.kt      # Compose
            theme/Theme.kt        # state-dot colors mirroring Shepherd's Theme.swift
      test/java/com/eshaan/shepherd/    # JVM unit tests (run on testDebugUnitTest)
        protocol/WireCodecTest.kt
        model/FleetTest.kt
        transport/RemoteConnectionLoopbackTest.kt
        data/PairingStoreTest.kt
        pairing/PairingControllerTest.kt
        fcm/FcmWakeTest.kt
        ui/FleetViewModelTest.kt
```

---

### Task 1: Buildable skeleton (Gradle + Compose + Firebase, empty app)

Goal: an empty Compose app that **builds to an APK** and runs one trivial JVM unit test, with the full toolchain (AGP/Kotlin/Compose/Firebase/serialization) wired. This de-risks the toolchain before any feature code.

**Files:**
- Create: `android/settings.gradle.kts`, `android/build.gradle.kts`, `android/gradle.properties`, `android/.gitignore`, `android/local.properties`
- Create: `android/app/build.gradle.kts`, `android/app/proguard-rules.pro`, `android/app/google-services.json` (copied from scratchpad)
- Create: `android/app/src/main/AndroidManifest.xml`
- Create: `android/app/src/main/java/com/eshaan/shepherd/MainActivity.kt`, `ShepherdApp.kt`
- Create: `android/app/src/test/java/com/eshaan/shepherd/SkeletonTest.kt`
- Generate: `android/gradlew`, `android/gradle/wrapper/*` (via bootstrap)

**Interfaces:**
- Produces: a buildable `:app` module (`com.eshaan.shepherd`), the Gradle wrapper, and the verified build command used by all later tasks.

- [ ] **Step 1: Bootstrap the Gradle wrapper**

No system Gradle is installed; download a distribution to the scratchpad once and use it only to generate the committed wrapper. Run:
```bash
SCRATCH=/private/tmp/claude-502/-Users-eshaannileshshah-Home-dev-tools-shepherd/788e1376-99ba-408d-af26-c1b29ad61ef3/scratchpad
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
mkdir -p "$SCRATCH/gradle-dl" && cd "$SCRATCH/gradle-dl"
curl -fsSL -o gradle.zip https://services.gradle.org/distributions/gradle-8.9-bin.zip
unzip -q gradle.zip
mkdir -p /Users/eshaannileshshah/Home/dev/tools/shepherd/android
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/android
"$SCRATCH/gradle-dl/gradle-8.9/bin/gradle" wrapper --gradle-version 8.9 --distribution-type bin
```
Expected: creates `android/gradlew`, `android/gradlew.bat`, `android/gradle/wrapper/gradle-wrapper.jar`, `android/gradle/wrapper/gradle-wrapper.properties`. (If `curl` is blocked, the user runs the three lines under `!`; do not retry repeatedly.)

- [ ] **Step 2: Write `android/local.properties` (gitignored) and `.gitignore`**

`android/local.properties`:
```properties
sdk.dir=/Users/eshaannileshshah/Library/Android/sdk
```
`android/.gitignore`:
```gitignore
.gradle/
build/
local.properties
app/google-services.json
*.iml
.idea/
.kotlin/
```

- [ ] **Step 3: Write the root Gradle files**

`android/settings.gradle.kts`:
```kotlin
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "Shepherd"
include(":app")
```
`android/build.gradle.kts`:
```kotlin
plugins {
    id("com.android.application") version "8.6.1" apply false
    id("org.jetbrains.kotlin.android") version "2.0.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.20" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.20" apply false
    id("com.google.gms.google-services") version "4.4.2" apply false
}
```
`android/gradle.properties`:
```properties
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
```

- [ ] **Step 4: Write `android/app/build.gradle.kts`**

```kotlin
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.gms.google-services")
}

android {
    namespace = "com.eshaan.shepherd"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.eshaan.shepherd"
        minSdk = 31
        targetSdk = 35
        versionCode = 1
        versionName = "0.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.03")
    implementation(composeBom)
    androidTestImplementation(composeBom)
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation(platform("com.google.firebase:firebase-bom:33.3.0"))
    implementation("com.google.firebase:firebase-messaging")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
}
```
`android/app/proguard-rules.pro`: leave empty (one comment line is fine).

- [ ] **Step 5: Copy `google-services.json` and write manifest + app shell**

```bash
cp "$SCRATCH/google-services.json" /Users/eshaannileshshah/Home/dev/tools/shepherd/android/app/google-services.json
```
`android/app/src/main/AndroidManifest.xml`:
```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <application
        android:name=".ShepherdApp"
        android:allowBackup="true"
        android:label="Shepherd"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.Material.NoActionBar">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```
`ShepherdApp.kt`:
```kotlin
package com.eshaan.shepherd

import android.app.Application

class ShepherdApp : Application()
```
`MainActivity.kt`:
```kotlin
package com.eshaan.shepherd

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface { Text("Shepherd") }
            }
        }
    }
}
```

- [ ] **Step 6: Write the trivial unit test**

`android/app/src/test/java/com/eshaan/shepherd/SkeletonTest.kt`:
```kotlin
package com.eshaan.shepherd

import org.junit.Assert.assertEquals
import org.junit.Test

class SkeletonTest {
    @Test fun arithmetic() { assertEquals(2, 1 + 1) }
}
```

- [ ] **Step 7: Build + test (the canonical command for all later tasks)**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/android
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
  ./gradlew :app:assembleDebug :app:testDebugUnitTest
```
Expected: `BUILD SUCCESSFUL`; APK at `app/build/outputs/apk/debug/app-debug.apk`; `SkeletonTest` passes. (First run downloads Gradle 8.9 + deps — minutes.)

- [ ] **Step 8: Commit**
```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd
git add android/settings.gradle.kts android/build.gradle.kts android/gradle.properties \
  android/.gitignore android/gradlew android/gradlew.bat android/gradle/wrapper \
  android/app/build.gradle.kts android/app/proguard-rules.pro \
  android/app/src/main/AndroidManifest.xml android/app/src/main/java android/app/src/test/java
git commit -m "feat(android): buildable Compose skeleton + Firebase/serialization wiring"
```

---

### Task 2: Wire protocol (pure Kotlin, golden-vector tested)

Goal: encode/decode the framed control protocol in Kotlin, byte-compatible with the host's golden vectors.

**Files:**
- Create: `app/src/main/java/com/eshaan/shepherd/protocol/PaneInfo.kt`, `ControlMessage.kt`, `WireCodec.kt`
- Test: `app/src/test/java/com/eshaan/shepherd/protocol/WireCodecTest.kt`

**Interfaces:**
- Produces: `data class PaneInfo(paneId, title, workspace, state, reason: String?)`; `sealed interface ControlMessage` with `Hello`, `RefreshFcmToken`, `Accepted`, `Rejected`, `PendingApproval`, `Snapshot`, `StateMsg`, `PaneAdded`, `PaneRemoved`, `PaneRenamed`, `Detach`, `Ping`, `Pong`; `object WireCodec { fun encode(ControlMessage): ByteArray; class Decoder { fun feed(ByteArray): List<ControlMessage> } }`.

- [ ] **Step 1: Write the failing test**

`WireCodecTest.kt`:
```kotlin
package com.eshaan.shepherd.protocol

import org.junit.Assert.*
import org.junit.Test

class WireCodecTest {
    private fun frameJson(msg: ControlMessage): String {
        val bytes = WireCodec.encode(msg)
        val len = ((bytes[0].toInt() and 0xff) shl 24) or ((bytes[1].toInt() and 0xff) shl 16) or
                  ((bytes[2].toInt() and 0xff) shl 8) or (bytes[3].toInt() and 0xff)
        assertEquals(bytes.size - 4, len)
        return String(bytes, 4, len, Charsets.UTF_8)
    }
    private fun decodeOne(json: String): ControlMessage {
        val body = json.toByteArray(Charsets.UTF_8)
        val frame = ByteArray(4 + body.size)
        frame[0] = (body.size ushr 24).toByte(); frame[1] = (body.size ushr 16).toByte()
        frame[2] = (body.size ushr 8).toByte(); frame[3] = body.size.toByte()
        body.copyInto(frame, 4)
        val msgs = WireCodec.Decoder().feed(frame)
        assertEquals(1, msgs.size)
        return msgs[0]
    }

    @Test fun pingFrameMatchesHostBytes() {
        val bytes = WireCodec.encode(ControlMessage.Ping)
        assertArrayEquals(byteArrayOf(0,0,0,0x0b, '{'.code.toByte(),'"'.code.toByte(),'p'.code.toByte(),
            'i'.code.toByte(),'n'.code.toByte(),'g'.code.toByte(),'"'.code.toByte(),':'.code.toByte(),
            '{'.code.toByte(),'}'.code.toByte(),'}'.code.toByte()), bytes)
    }

    @Test fun helloOmitsNilFields() {
        val json = frameJson(ControlMessage.Hello("dev-123","Pixel 8", pairingCode = null,
            secret = "s3cr3t", fcmToken = "tok", protocolVersion = 1))
        assertFalse("nil pairingCode must be omitted, not null", json.contains("pairingCode"))
        assertTrue(json.contains("\"secret\":\"s3cr3t\""))
        assertTrue(json.contains("\"deviceID\":\"dev-123\""))
        assertTrue(json.contains("\"deviceName\":\"Pixel 8\""))
        assertTrue(json.contains("\"protocolVersion\":1"))
    }

    @Test fun decodesHostSnapshot() {
        val m = decodeOne("""{"snapshot":{"panes":[{"paneID":"p1","state":"blocked","title":"~/proj","reason":"approve Bash","workspace":"Work"}]}}""")
        m as ControlMessage.Snapshot
        assertEquals(1, m.panes.size)
        assertEquals(PaneInfo("p1","~/proj","Work","blocked","approve Bash"), m.panes[0])
    }

    @Test fun decodesStateWithMissingReasonAsNull() {
        val m = decodeOne("""{"state":{"paneID":"p1","state":"working"}}""") as ControlMessage.StateMsg
        assertEquals("p1", m.paneId); assertEquals("working", m.state); assertNull(m.reason)
    }

    @Test fun decodesPaneAddedUnderUnderscoreZero() {
        val m = decodeOne("""{"paneAdded":{"_0":{"paneID":"p2","state":"idle","title":"t","workspace":"W"}}}""") as ControlMessage.PaneAdded
        assertEquals("p2", m.pane.paneId); assertNull(m.pane.reason)
    }

    @Test fun decodesAcceptedRejectedPending() {
        assertEquals("nonce-1", (decodeOne("""{"accepted":{"sessionNonce":"nonce-1"}}""") as ControlMessage.Accepted).sessionNonce)
        assertEquals("nope", (decodeOne("""{"rejected":{"reason":"nope"}}""") as ControlMessage.Rejected).reason)
        assertTrue(decodeOne("""{"pendingApproval":{}}""") is ControlMessage.PendingApproval)
        assertTrue(decodeOne("""{"pong":{}}""") is ControlMessage.Pong)
    }

    @Test fun decoderReassemblesSplitAndCoalescedFrames() {
        val a = WireCodec.encode(ControlMessage.Ping)
        val b = WireCodec.encode(ControlMessage.Pong)
        val dec = WireCodec.Decoder()
        // split frame a across two feeds, then both b halves coalesced
        assertEquals(0, dec.feed(a.copyOfRange(0, 3)).size)
        val r1 = dec.feed(a.copyOfRange(3, a.size) + b.copyOfRange(0, 2))
        assertEquals(1, r1.size); assertTrue(r1[0] is ControlMessage.Ping)
        val r2 = dec.feed(b.copyOfRange(2, b.size))
        assertEquals(1, r2.size); assertTrue(r2[0] is ControlMessage.Pong)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ./gradlew :app:testDebugUnitTest --tests '*WireCodecTest'`
Expected: FAIL — `WireCodec`/`ControlMessage` unresolved.

- [ ] **Step 3: Write `PaneInfo.kt`**
```kotlin
package com.eshaan.shepherd.protocol

data class PaneInfo(
    val paneId: String,
    val title: String,
    val workspace: String,
    val state: String,
    val reason: String?,
)
```

- [ ] **Step 4: Write `ControlMessage.kt`**
```kotlin
package com.eshaan.shepherd.protocol

sealed interface ControlMessage {
    data class Hello(
        val deviceId: String,
        val deviceName: String,
        val pairingCode: String?,
        val secret: String?,
        val fcmToken: String?,
        val protocolVersion: Int = 1,
    ) : ControlMessage
    data class RefreshFcmToken(val token: String) : ControlMessage
    data class Accepted(val sessionNonce: String) : ControlMessage
    data class Rejected(val reason: String) : ControlMessage
    data object PendingApproval : ControlMessage
    data class Snapshot(val panes: List<PaneInfo>) : ControlMessage
    data class StateMsg(val paneId: String, val state: String, val reason: String?) : ControlMessage
    data class PaneAdded(val pane: PaneInfo) : ControlMessage
    data class PaneRemoved(val paneId: String) : ControlMessage
    data class PaneRenamed(val paneId: String, val title: String) : ControlMessage
    data object Detach : ControlMessage
    data object Ping : ControlMessage
    data object Pong : ControlMessage
}
```

- [ ] **Step 5: Write `WireCodec.kt`** (hand-rolled externally-tagged JSON over kotlinx tree; omit-nil)
```kotlin
package com.eshaan.shepherd.protocol

import kotlinx.serialization.json.*

object WireCodec {
    private const val MAX_FRAME = 8 * 1024 * 1024

    private fun paneJson(p: PaneInfo): JsonObject = buildJsonObject {
        put("paneID", p.paneId); put("title", p.title); put("workspace", p.workspace); put("state", p.state)
        if (p.reason != null) put("reason", p.reason)
    }

    private fun bodyJson(msg: ControlMessage): JsonObject = buildJsonObject {
        when (msg) {
            is ControlMessage.Hello -> putJsonObject("hello") {
                put("protocolVersion", msg.protocolVersion)
                if (msg.pairingCode != null) put("pairingCode", msg.pairingCode)
                if (msg.secret != null) put("secret", msg.secret)
                if (msg.fcmToken != null) put("fcmToken", msg.fcmToken)
                put("deviceID", msg.deviceId); put("deviceName", msg.deviceName)
            }
            is ControlMessage.RefreshFcmToken -> putJsonObject("refreshFCMToken") { put("token", msg.token) }
            is ControlMessage.Accepted -> putJsonObject("accepted") { put("sessionNonce", msg.sessionNonce) }
            is ControlMessage.Rejected -> putJsonObject("rejected") { put("reason", msg.reason) }
            ControlMessage.PendingApproval -> putJsonObject("pendingApproval") {}
            is ControlMessage.Snapshot -> putJsonObject("snapshot") {
                put("panes", buildJsonArray { msg.panes.forEach { add(paneJson(it)) } })
            }
            is ControlMessage.StateMsg -> putJsonObject("state") {
                put("paneID", msg.paneId); put("state", msg.state); if (msg.reason != null) put("reason", msg.reason)
            }
            is ControlMessage.PaneAdded -> putJsonObject("paneAdded") { put("_0", paneJson(msg.pane)) }
            is ControlMessage.PaneRemoved -> putJsonObject("paneRemoved") { put("paneID", msg.paneId) }
            is ControlMessage.PaneRenamed -> putJsonObject("paneRenamed") { put("paneID", msg.paneId); put("title", msg.title) }
            ControlMessage.Detach -> putJsonObject("detach") {}
            ControlMessage.Ping -> putJsonObject("ping") {}
            ControlMessage.Pong -> putJsonObject("pong") {}
        }
    }

    fun encode(msg: ControlMessage): ByteArray {
        val json = bodyJson(msg).toString().toByteArray(Charsets.UTF_8)
        val out = ByteArray(4 + json.size)
        out[0] = (json.size ushr 24).toByte(); out[1] = (json.size ushr 16).toByte()
        out[2] = (json.size ushr 8).toByte(); out[3] = json.size.toByte()
        json.copyInto(out, 4)
        return out
    }

    private fun pane(o: JsonObject): PaneInfo = PaneInfo(
        paneId = o.getValue("paneID").jsonPrimitive.content,
        title = o.getValue("title").jsonPrimitive.content,
        workspace = o.getValue("workspace").jsonPrimitive.content,
        state = o.getValue("state").jsonPrimitive.content,
        reason = o["reason"]?.jsonPrimitive?.contentOrNull,
    )

    private fun parse(json: String): ControlMessage? {
        val root = Json.parseToJsonElement(json).jsonObject
        val key = root.keys.firstOrNull() ?: return null
        val b = root.getValue(key).jsonObject
        return when (key) {
            "accepted" -> ControlMessage.Accepted(b.getValue("sessionNonce").jsonPrimitive.content)
            "rejected" -> ControlMessage.Rejected(b.getValue("reason").jsonPrimitive.content)
            "pendingApproval" -> ControlMessage.PendingApproval
            "snapshot" -> ControlMessage.Snapshot(b.getValue("panes").jsonArray.map { pane(it.jsonObject) })
            "state" -> ControlMessage.StateMsg(b.getValue("paneID").jsonPrimitive.content,
                b.getValue("state").jsonPrimitive.content, b["reason"]?.jsonPrimitive?.contentOrNull)
            "paneAdded" -> ControlMessage.PaneAdded(pane(b.getValue("_0").jsonObject))
            "paneRemoved" -> ControlMessage.PaneRemoved(b.getValue("paneID").jsonPrimitive.content)
            "paneRenamed" -> ControlMessage.PaneRenamed(b.getValue("paneID").jsonPrimitive.content,
                b.getValue("title").jsonPrimitive.content)
            "pong" -> ControlMessage.Pong
            "ping" -> ControlMessage.Ping
            "detach" -> ControlMessage.Detach
            "hello" -> ControlMessage.Hello(b.getValue("deviceID").jsonPrimitive.content,
                b.getValue("deviceName").jsonPrimitive.content, b["pairingCode"]?.jsonPrimitive?.contentOrNull,
                b["secret"]?.jsonPrimitive?.contentOrNull, b["fcmToken"]?.jsonPrimitive?.contentOrNull,
                b["protocolVersion"]?.jsonPrimitive?.int ?: 1)
            "refreshFCMToken" -> ControlMessage.RefreshFcmToken(b.getValue("token").jsonPrimitive.content)
            else -> null
        }
    }

    class Decoder {
        private var buf = ByteArray(0)
        fun feed(data: ByteArray): List<ControlMessage> {
            buf += data
            val out = ArrayList<ControlMessage>()
            while (buf.size >= 4) {
                val len = ((buf[0].toInt() and 0xff) shl 24) or ((buf[1].toInt() and 0xff) shl 16) or
                          ((buf[2].toInt() and 0xff) shl 8) or (buf[3].toInt() and 0xff)
                if (len < 0 || len > MAX_FRAME) throw IllegalStateException("frame too large: $len")
                if (buf.size < 4 + len) break
                val json = String(buf, 4, len, Charsets.UTF_8)
                buf = buf.copyOfRange(4 + len, buf.size)
                parse(json)?.let { out.add(it) }
            }
            return out
        }
    }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd android && JAVA_HOME=…/openjdk@17/…/Home ./gradlew :app:testDebugUnitTest --tests '*WireCodecTest'`
Expected: PASS (all 7).

- [ ] **Step 7: Commit**
```bash
git add android/app/src/main/java/com/eshaan/shepherd/protocol android/app/src/test/java/com/eshaan/shepherd/protocol
git commit -m "feat(android): Kotlin wire protocol matching host golden vectors"
```

---

### Task 3: Fleet model (pure Kotlin, JVM-tested)

Goal: hold the agent fleet and apply control-channel updates; expose attention info.

**Files:**
- Create: `app/src/main/java/com/eshaan/shepherd/model/AgentState.kt`, `Fleet.kt`
- Test: `app/src/test/java/com/eshaan/shepherd/model/FleetTest.kt`

**Interfaces:**
- Consumes: `PaneInfo`, `ControlMessage` (Task 2).
- Produces: `enum class AgentState { SHELL, WORKING, BLOCKED, NEEDS_CHECK, IDLE, ERROR, UNKNOWN; companion fun fromRaw(String): AgentState; val wantsAttention: Boolean }`; `data class Fleet(val panes: List<PaneInfo>)` with `fun applying(msg: ControlMessage): Fleet`, `val attentionCount: Int`, `fun pane(id: String): PaneInfo?`, `fun byWorkspace(): List<Pair<String, List<PaneInfo>>>`.

- [ ] **Step 1: Write the failing test**
```kotlin
package com.eshaan.shepherd.model

import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.protocol.PaneInfo
import org.junit.Assert.*
import org.junit.Test

class FleetTest {
    private val p1 = PaneInfo("p1","a","W1","working",null)
    private val p2 = PaneInfo("p2","b","W2","blocked","approve Bash")

    @Test fun fromRawMapsHyphenatedNeedsCheck() {
        assertEquals(AgentState.NEEDS_CHECK, AgentState.fromRaw("need-to-check"))
        assertEquals(AgentState.ERROR, AgentState.fromRaw("error"))
        assertEquals(AgentState.UNKNOWN, AgentState.fromRaw("bogus"))
    }
    @Test fun attentionStates() {
        assertTrue(AgentState.BLOCKED.wantsAttention)
        assertTrue(AgentState.NEEDS_CHECK.wantsAttention)
        assertTrue(AgentState.ERROR.wantsAttention)
        assertFalse(AgentState.WORKING.wantsAttention)
    }
    @Test fun snapshotReplacesAndCounts() {
        val f = Fleet(emptyList()).applying(ControlMessage.Snapshot(listOf(p1, p2)))
        assertEquals(2, f.panes.size); assertEquals(1, f.attentionCount)
    }
    @Test fun stateUpdatesOnePane() {
        val f = Fleet(listOf(p1, p2)).applying(ControlMessage.StateMsg("p1","blocked","plan approval"))
        assertEquals("blocked", f.pane("p1")!!.state)
        assertEquals("plan approval", f.pane("p1")!!.reason)
        assertEquals(2, f.attentionCount)
    }
    @Test fun addRemoveRename() {
        var f = Fleet(listOf(p1)).applying(ControlMessage.PaneAdded(p2))
        assertEquals(2, f.panes.size)
        f = f.applying(ControlMessage.PaneRemoved("p1"))
        assertNull(f.pane("p1"))
        f = f.applying(ControlMessage.PaneRenamed("p2","renamed"))
        assertEquals("renamed", f.pane("p2")!!.title)
    }
    @Test fun groupsByWorkspacePreservingOrder() {
        val f = Fleet(listOf(p1, p2, p1.copy(paneId="p3")))
        val g = f.byWorkspace()
        assertEquals(listOf("W1","W2"), g.map { it.first })
        assertEquals(2, g[0].second.size)
    }
}
```

- [ ] **Step 2: Run — expect FAIL** (`AgentState`/`Fleet` unresolved).

- [ ] **Step 3: Write `AgentState.kt`**
```kotlin
package com.eshaan.shepherd.model

enum class AgentState(val raw: String) {
    SHELL("shell"), WORKING("working"), BLOCKED("blocked"),
    NEEDS_CHECK("need-to-check"), IDLE("idle"), ERROR("error"), UNKNOWN("");

    val wantsAttention: Boolean get() = this == BLOCKED || this == NEEDS_CHECK || this == ERROR

    companion object {
        fun fromRaw(s: String): AgentState = entries.firstOrNull { it.raw == s } ?: UNKNOWN
    }
}
```

- [ ] **Step 4: Write `Fleet.kt`**
```kotlin
package com.eshaan.shepherd.model

import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.protocol.PaneInfo

data class Fleet(val panes: List<PaneInfo>) {
    fun pane(id: String): PaneInfo? = panes.firstOrNull { it.paneId == id }
    val attentionCount: Int get() = panes.count { AgentState.fromRaw(it.state).wantsAttention }

    fun byWorkspace(): List<Pair<String, List<PaneInfo>>> {
        val order = LinkedHashMap<String, MutableList<PaneInfo>>()
        for (p in panes) order.getOrPut(p.workspace) { mutableListOf() }.add(p)
        return order.map { it.key to it.value.toList() }
    }

    fun applying(msg: ControlMessage): Fleet = when (msg) {
        is ControlMessage.Snapshot -> Fleet(msg.panes)
        is ControlMessage.StateMsg -> Fleet(panes.map {
            if (it.paneId == msg.paneId) it.copy(state = msg.state, reason = msg.reason) else it
        })
        is ControlMessage.PaneAdded ->
            if (pane(msg.pane.paneId) != null) this else Fleet(panes + msg.pane)
        is ControlMessage.PaneRemoved -> Fleet(panes.filterNot { it.paneId == msg.paneId })
        is ControlMessage.PaneRenamed -> Fleet(panes.map {
            if (it.paneId == msg.paneId) it.copy(title = msg.title) else it
        })
        else -> this
    }
}
```

- [ ] **Step 5: Run — expect PASS.** Then **commit**:
```bash
git add android/app/src/main/java/com/eshaan/shepherd/model android/app/src/test/java/com/eshaan/shepherd/model
git commit -m "feat(android): fleet model + agent-state mapping"
```

---

### Task 4: Transport — RemoteConnection (TCP, framing, handshake, heartbeat, backoff)

Goal: a connection that dials the host, runs the client handshake, emits inbound messages + connection status, sends the heartbeat, and reconnects with backoff. Verified by a JVM loopback integration test against a fake server (mirrors the host's loopback E2E).

**Files:**
- Create: `app/src/main/java/com/eshaan/shepherd/transport/RemoteConnection.kt`
- Test: `app/src/test/java/com/eshaan/shepherd/transport/RemoteConnectionLoopbackTest.kt`

**Interfaces:**
- Consumes: `WireCodec`, `ControlMessage` (Task 2).
- Produces:
  - `sealed interface ConnStatus { object Connecting; object Pending; data class Connected(val sessionNonce: String); data class Failed(val reason: String); object Disconnected }`
  - `class RemoteConnection(host, port, helloFactory: () -> ControlMessage.Hello, scope: CoroutineScope, pingIntervalMs: Long = 20_000, backoffStartMs: Long = 1_000, backoffMaxMs: Long = 30_000, connect: (String, Int) -> Socket = { h, p -> Socket(h, p) })`
  - `val status: StateFlow<ConnStatus>`, `val inbound: SharedFlow<ControlMessage>`, `fun start()`, `fun send(ControlMessage)`, `fun stop()` (sends `Detach` then closes).
  - The injectable `connect` lambda is what makes loopback testing possible (the test passes a factory returning a client `Socket` to its in-JVM `ServerSocket`).

- [ ] **Step 1: Write the failing loopback test**
```kotlin
package com.eshaan.shepherd.transport

import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.protocol.PaneInfo
import com.eshaan.shepherd.protocol.WireCodec
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import org.junit.Assert.*
import org.junit.Test
import java.io.DataInputStream
import java.net.ServerSocket
import java.net.Socket

class RemoteConnectionLoopbackTest {
    /** Minimal host: read one hello, reply accepted+snapshot, then a state delta. */
    private fun fakeHost(server: ServerSocket, onHello: (ControlMessage.Hello) -> Unit) = Thread {
        val s = server.accept()
        val ins = DataInputStream(s.getInputStream())
        val dec = WireCodec.Decoder()
        val buf = ByteArray(4096)
        // read until we get a hello
        loop@ while (true) {
            val n = ins.read(buf); if (n <= 0) return@Thread
            for (m in dec.feed(buf.copyOf(n))) if (m is ControlMessage.Hello) { onHello(m); break@loop }
        }
        val out = s.getOutputStream()
        out.write(WireCodec.encode(ControlMessage.Accepted("nonce-xyz")))
        out.write(WireCodec.encode(ControlMessage.Snapshot(listOf(PaneInfo("p1","t","W","idle",null)))))
        out.write(WireCodec.encode(ControlMessage.StateMsg("p1","blocked","approve Bash")))
        out.flush()
        Thread.sleep(200); s.close()
    }.apply { isDaemon = true; start() }

    @Test fun handshakeThenSnapshotThenDelta() = runBlocking {
        val server = ServerSocket(0)
        var seenHello: ControlMessage.Hello? = null
        fakeHost(server) { seenHello = it }
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val conn = RemoteConnection(
            host = "127.0.0.1", port = server.localPort,
            helloFactory = { ControlMessage.Hello("dev-1","Test", "0042", "secret", "tok", 1) },
            scope = scope,
            connect = { h, p -> Socket(h, p) },
        )
        val received = mutableListOf<ControlMessage>()
        val job = scope.launch { conn.inbound.toList(received) }
        conn.start()
        val connected = withTimeout(3000) { conn.status.first { it is ConnStatus.Connected } } as ConnStatus.Connected
        assertEquals("nonce-xyz", connected.sessionNonce)
        withTimeout(3000) { while (received.none { it is ControlMessage.StateMsg }) delay(20) }
        assertTrue(received.any { it is ControlMessage.Snapshot })
        assertTrue(received.any { it is ControlMessage.StateMsg })
        assertNotNull(seenHello); assertEquals("0042", seenHello!!.pairingCode)
        job.cancel(); conn.stop(); scope.cancel(); server.close()
    }

    @Test fun pendingThenAcceptedTransitions() = runBlocking {
        val server = ServerSocket(0)
        Thread {
            val s = server.accept(); val ins = DataInputStream(s.getInputStream())
            val dec = WireCodec.Decoder(); val buf = ByteArray(4096)
            loop@ while (true) { val n = ins.read(buf); if (n <= 0) return@Thread
                for (m in dec.feed(buf.copyOf(n))) if (m is ControlMessage.Hello) break@loop }
            val out = s.getOutputStream()
            out.write(WireCodec.encode(ControlMessage.PendingApproval)); out.flush(); Thread.sleep(150)
            out.write(WireCodec.encode(ControlMessage.Accepted("n2")))
            out.write(WireCodec.encode(ControlMessage.Snapshot(emptyList()))); out.flush(); Thread.sleep(150); s.close()
        }.apply { isDaemon = true; start() }
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val conn = RemoteConnection("127.0.0.1", server.localPort,
            { ControlMessage.Hello("d","n",null,"sec","tok",1) }, scope)
        conn.start()
        withTimeout(3000) { conn.status.first { it is ConnStatus.Pending } }
        withTimeout(3000) { conn.status.first { it is ConnStatus.Connected } }
        conn.stop(); scope.cancel(); server.close()
    }
}
```

- [ ] **Step 2: Run — expect FAIL** (`RemoteConnection`/`ConnStatus` unresolved).

- [ ] **Step 3: Write `RemoteConnection.kt`**
```kotlin
package com.eshaan.shepherd.transport

import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.protocol.WireCodec
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import java.net.Socket
import java.io.OutputStream

sealed interface ConnStatus {
    data object Connecting : ConnStatus
    data object Pending : ConnStatus
    data class Connected(val sessionNonce: String) : ConnStatus
    data class Failed(val reason: String) : ConnStatus
    data object Disconnected : ConnStatus
}

class RemoteConnection(
    private val host: String,
    private val port: Int,
    private val helloFactory: () -> ControlMessage.Hello,
    private val scope: CoroutineScope,
    private val pingIntervalMs: Long = 20_000,
    private val backoffStartMs: Long = 1_000,
    private val backoffMaxMs: Long = 30_000,
    private val connect: (String, Int) -> Socket = { h, p -> Socket(h, p) },
) {
    private val _status = MutableStateFlow<ConnStatus>(ConnStatus.Disconnected)
    val status: StateFlow<ConnStatus> = _status
    private val _inbound = MutableSharedFlow<ControlMessage>(extraBufferCapacity = 64)
    val inbound: SharedFlow<ControlMessage> = _inbound

    private var loopJob: Job? = null
    @Volatile private var socket: Socket? = null
    @Volatile private var out: OutputStream? = null
    @Volatile private var running = false
    @Volatile private var detaching = false

    fun start() {
        if (loopJob != null) return
        running = true
        loopJob = scope.launch(Dispatchers.IO) {
            var backoff = backoffStartMs
            while (running && isActive) {
                try {
                    runSession()
                    backoff = backoffStartMs            // a clean session resets backoff
                } catch (_: CancellationException) {
                    throw CancellationException()
                } catch (e: Exception) {
                    _status.value = ConnStatus.Failed(e.message ?: "connection error")
                }
                if (!running) break
                _status.value = ConnStatus.Disconnected
                delay(backoff); backoff = (backoff * 2).coerceAtMost(backoffMaxMs)
            }
        }
    }

    private suspend fun runSession() = coroutineScope {
        _status.value = ConnStatus.Connecting
        val s = connect(host, port); socket = s; out = s.getOutputStream()
        try {
            sendRaw(helloFactory())
            val heartbeat = launch { while (isActive) { delay(pingIntervalMs); runCatching { sendRaw(ControlMessage.Ping) } } }
            val ins = s.getInputStream(); val dec = WireCodec.Decoder(); val buf = ByteArray(8192)
            while (isActive) {
                val n = ins.read(buf); if (n <= 0) break
                for (m in dec.feed(buf.copyOf(n))) {
                    when (m) {
                        is ControlMessage.PendingApproval -> _status.value = ConnStatus.Pending
                        is ControlMessage.Accepted -> _status.value = ConnStatus.Connected(m.sessionNonce)
                        is ControlMessage.Rejected -> { _status.value = ConnStatus.Failed(m.reason); running = false }
                        else -> {}
                    }
                    _inbound.emit(m)
                }
            }
            heartbeat.cancel()
        } finally { closeSocket() }
    }

    /** Enqueue any message; serialized on the IO dispatcher. */
    fun send(msg: ControlMessage) { scope.launch(Dispatchers.IO) { runCatching { sendRaw(msg) } } }

    @Synchronized private fun sendRaw(msg: ControlMessage) {
        val o = out ?: return; o.write(WireCodec.encode(msg)); o.flush()
    }

    private fun closeSocket() { runCatching { socket?.close() }; socket = null; out = null }

    fun stop() {
        running = false; detaching = true
        runCatching { sendRaw(ControlMessage.Detach) }
        loopJob?.cancel(); loopJob = null
        closeSocket(); _status.value = ConnStatus.Disconnected
    }
}
```

- [ ] **Step 4: Run — expect PASS** (both tests). Run with `--tests '*RemoteConnectionLoopbackTest'`. If flaky on CI timing, the timeouts are generous (3s); do not add sleeps to production code.

- [ ] **Step 5: Commit**
```bash
git add android/app/src/main/java/com/eshaan/shepherd/transport android/app/src/test/java/com/eshaan/shepherd/transport
git commit -m "feat(android): RemoteConnection TCP transport with handshake + heartbeat + backoff"
```

---

### Task 5: Pairing store (interface + in-memory fake + EncryptedSharedPreferences impl)

Goal: persist the paired host + the phone-owned secret + device identity. Logic tested against an in-memory fake; the real Keystore-backed impl is compiled but device-verified.

**Files:**
- Create: `app/src/main/java/com/eshaan/shepherd/data/PairingStore.kt`, `DeviceIdentity.kt`, `EncryptedPairingStore.kt`
- Test: `app/src/test/java/com/eshaan/shepherd/data/PairingStoreTest.kt`

**Interfaces:**
- Produces:
  - `data class Pairing(val host: String, val port: Int, val deviceId: String, val deviceName: String, val secret: String)`
  - `interface PairingStore { fun load(): Pairing?; fun save(p: Pairing); fun clear() }`
  - `class InMemoryPairingStore : PairingStore` (test fake)
  - `object DeviceIdentity { fun newSecret(): String; fun deviceName(): String }` (UUID + `android.os.Build.MODEL`; `deviceName` is the only Android-coupled call — keep it out of pure tests)
  - `class EncryptedPairingStore(context) : PairingStore` (EncryptedSharedPreferences)

- [ ] **Step 1: Write the failing test**
```kotlin
package com.eshaan.shepherd.data

import org.junit.Assert.*
import org.junit.Test

class PairingStoreTest {
    @Test fun saveLoadClearRoundTrips() {
        val store = InMemoryPairingStore()
        assertNull(store.load())
        val p = Pairing("100.64.0.5", 8722, "dev-1", "Pixel 8", "secret-abc")
        store.save(p)
        assertEquals(p, store.load())
        store.clear()
        assertNull(store.load())
    }
    @Test fun newSecretIsUniqueAndNonEmpty() {
        val a = DeviceIdentity.newSecret(); val b = DeviceIdentity.newSecret()
        assertTrue(a.isNotBlank()); assertNotEquals(a, b)
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Write `PairingStore.kt`**
```kotlin
package com.eshaan.shepherd.data

data class Pairing(
    val host: String,
    val port: Int,
    val deviceId: String,
    val deviceName: String,
    val secret: String,
)

interface PairingStore {
    fun load(): Pairing?
    fun save(p: Pairing)
    fun clear()
}

class InMemoryPairingStore : PairingStore {
    private var current: Pairing? = null
    override fun load(): Pairing? = current
    override fun save(p: Pairing) { current = p }
    override fun clear() { current = null }
}
```

- [ ] **Step 4: Write `DeviceIdentity.kt`**
```kotlin
package com.eshaan.shepherd.data

import android.os.Build
import java.util.UUID

object DeviceIdentity {
    fun newSecret(): String = UUID.randomUUID().toString()
    fun newDeviceId(): String = UUID.randomUUID().toString()
    fun deviceName(): String = Build.MODEL ?: "Android"
}
```
(`Build.MODEL` is a field read; safe to reference from `:app` even though `deviceName()` itself isn't unit-tested.)

- [ ] **Step 5: Write `EncryptedPairingStore.kt`** (device-verified, not unit-tested)
```kotlin
package com.eshaan.shepherd.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class EncryptedPairingStore(context: Context) : PairingStore {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "shepherd_pairing",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
    override fun load(): Pairing? {
        val host = prefs.getString("host", null) ?: return null
        return Pairing(host, prefs.getInt("port", 8722), prefs.getString("deviceId", "")!!,
            prefs.getString("deviceName", "")!!, prefs.getString("secret", "")!!)
    }
    override fun save(p: Pairing) = prefs.edit()
        .putString("host", p.host).putInt("port", p.port).putString("deviceId", p.deviceId)
        .putString("deviceName", p.deviceName).putString("secret", p.secret).apply()
    override fun clear() = prefs.edit().clear().apply()
}
```

- [ ] **Step 6: Run — expect PASS.** Then **commit**:
```bash
git add android/app/src/main/java/com/eshaan/shepherd/data android/app/src/test/java/com/eshaan/shepherd/data
git commit -m "feat(android): pairing store (in-memory fake + EncryptedSharedPreferences) + device identity"
```

---

### Task 6: Pairing controller + screen

Goal: a pure state machine that drives pairing (first-pair with code, or reconnect with stored secret) over a `RemoteConnection`, persisting on success — plus the Compose pairing screen. Logic unit-tested with fakes; the screen is device-deferred.

**Files:**
- Create: `app/src/main/java/com/eshaan/shepherd/pairing/PairingController.kt`
- Create: `app/src/main/java/com/eshaan/shepherd/ui/PairingViewModel.kt`, `PairingScreen.kt`
- Test: `app/src/test/java/com/eshaan/shepherd/pairing/PairingControllerTest.kt`

**Interfaces:**
- Consumes: `RemoteConnection`, `ConnStatus` (Task 4); `PairingStore`, `Pairing`, `DeviceIdentity` (Task 5); `ControlMessage.Hello` (Task 2).
- Produces:
  - `sealed interface PairingState { object Idle; object Connecting; object WaitingApproval; data class Paired(val pairing: Pairing); data class Error(val reason: String) }`
  - `class PairingController(store: PairingStore)` with:
    - `fun helloForFirstPair(host, port, code, deviceId, deviceName, secret, fcmToken): ControlMessage.Hello`
    - `fun helloForReconnect(p: Pairing, fcmToken): ControlMessage.Hello`
    - `fun reduce(prev: PairingState, status: ConnStatus, pending: Pairing): PairingState` — maps connection status → pairing state; on `Connected`, returns `Paired` and **the caller persists** `pending` (the controller exposes `onPaired(pending)` to persist; keep persistence in `reduce`'s caller for testability — see test).

- [ ] **Step 1: Write the failing test**
```kotlin
package com.eshaan.shepherd.pairing

import com.eshaan.shepherd.data.InMemoryPairingStore
import com.eshaan.shepherd.data.Pairing
import com.eshaan.shepherd.transport.ConnStatus
import org.junit.Assert.*
import org.junit.Test

class PairingControllerTest {
    private val pending = Pairing("100.64.0.5", 8722, "dev-1", "Pixel 8", "secret-abc")

    @Test fun firstPairHelloCarriesCodeAndSecretAndToken() {
        val c = PairingController(InMemoryPairingStore())
        val h = c.helloForFirstPair("h", 8722, "0042", "dev-1", "Pixel 8", "secret-abc", "tok")
        assertEquals("0042", h.pairingCode); assertEquals("secret-abc", h.secret)
        assertEquals("tok", h.fcmToken); assertEquals("dev-1", h.deviceId)
    }
    @Test fun reconnectHelloHasNoCode() {
        val c = PairingController(InMemoryPairingStore())
        val h = c.helloForReconnect(pending, "tok")
        assertNull(h.pairingCode); assertEquals("secret-abc", h.secret)
    }
    @Test fun statusDrivesStateAndPersistsOnAccept() {
        val store = InMemoryPairingStore()
        val c = PairingController(store)
        assertEquals(PairingState.Connecting, c.reduce(PairingState.Idle, ConnStatus.Connecting, pending))
        assertEquals(PairingState.WaitingApproval, c.reduce(PairingState.Connecting, ConnStatus.Pending, pending))
        val paired = c.reduce(PairingState.WaitingApproval, ConnStatus.Connected("n"), pending)
        assertEquals(PairingState.Paired(pending), paired)
        assertEquals(pending, store.load())   // persisted on accept
    }
    @Test fun rejectionSurfacesError() {
        val c = PairingController(InMemoryPairingStore())
        val s = c.reduce(PairingState.Connecting, ConnStatus.Failed("bad secret"), pending)
        assertEquals(PairingState.Error("bad secret"), s)
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Write `PairingController.kt`**
```kotlin
package com.eshaan.shepherd.pairing

import com.eshaan.shepherd.data.Pairing
import com.eshaan.shepherd.data.PairingStore
import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.transport.ConnStatus

sealed interface PairingState {
    data object Idle : PairingState
    data object Connecting : PairingState
    data object WaitingApproval : PairingState
    data class Paired(val pairing: Pairing) : PairingState
    data class Error(val reason: String) : PairingState
}

class PairingController(private val store: PairingStore) {
    fun helloForFirstPair(host: String, port: Int, code: String, deviceId: String,
                          deviceName: String, secret: String, fcmToken: String?): ControlMessage.Hello =
        ControlMessage.Hello(deviceId, deviceName, pairingCode = code, secret = secret, fcmToken = fcmToken)

    fun helloForReconnect(p: Pairing, fcmToken: String?): ControlMessage.Hello =
        ControlMessage.Hello(p.deviceId, p.deviceName, pairingCode = null, secret = p.secret, fcmToken = fcmToken)

    /** Pure status→state map. Persists the pending pairing exactly when accepted. */
    fun reduce(prev: PairingState, status: ConnStatus, pending: Pairing): PairingState = when (status) {
        is ConnStatus.Connecting -> PairingState.Connecting
        is ConnStatus.Pending -> PairingState.WaitingApproval
        is ConnStatus.Connected -> { store.save(pending); PairingState.Paired(pending) }
        is ConnStatus.Failed -> PairingState.Error(status.reason)
        is ConnStatus.Disconnected -> prev   // transient between retries; don't clobber
    }
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Write `PairingViewModel.kt`** (wires controller + a `RemoteConnection`; not unit-tested — exercised live)
```kotlin
package com.eshaan.shepherd.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.eshaan.shepherd.data.DeviceIdentity
import com.eshaan.shepherd.data.Pairing
import com.eshaan.shepherd.data.PairingStore
import com.eshaan.shepherd.pairing.PairingController
import com.eshaan.shepherd.pairing.PairingState
import com.eshaan.shepherd.transport.RemoteConnection
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

class PairingViewModel(
    private val store: PairingStore,
    private val controller: PairingController = PairingController(store),
    private val fcmToken: suspend () -> String?,
) : ViewModel() {
    private val _state = MutableStateFlow<PairingState>(PairingState.Idle)
    val state: StateFlow<PairingState> = _state
    private var conn: RemoteConnection? = null

    fun pair(host: String, port: Int, code: String) {
        val deviceId = DeviceIdentity.newDeviceId()
        val pending = Pairing(host, port, deviceId, DeviceIdentity.deviceName(), DeviceIdentity.newSecret())
        viewModelScope.launch {
            val token = fcmToken()
            val c = RemoteConnection(host, port,
                helloFactory = { controller.helloForFirstPair(host, port, code, deviceId, pending.deviceName, pending.secret, token) },
                scope = viewModelScope)
            conn = c
            viewModelScope.launch { c.status.collect { _state.value = controller.reduce(_state.value, it, pending) } }
            c.start()
        }
    }
    override fun onCleared() { conn?.stop() }
}
```

- [ ] **Step 6: Write `PairingScreen.kt`** (Compose; device-verified)
```kotlin
package com.eshaan.shepherd.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.eshaan.shepherd.pairing.PairingState

@Composable
fun PairingScreen(vm: PairingViewModel, onPaired: () -> Unit) {
    val state by vm.state.collectAsState()
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("8722") }
    var code by remember { mutableStateOf("") }
    LaunchedEffect(state) { if (state is PairingState.Paired) onPaired() }
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Pair with a Shepherd host", style = MaterialTheme.typography.titleLarge)
        OutlinedTextField(host, { host = it }, label = { Text("Host (Tailscale 100.x or MagicDNS)") }, singleLine = true)
        OutlinedTextField(port, { port = it.filter(Char::isDigit) }, label = { Text("Port") }, singleLine = true)
        OutlinedTextField(code, { code = it.filter(Char::isDigit).take(4) }, label = { Text("Pairing code (4 digits)") }, singleLine = true)
        Button(onClick = { vm.pair(host.trim(), port.toIntOrNull() ?: 8722, code) },
            enabled = host.isNotBlank() && code.length == 4) { Text("Pair") }
        when (val s = state) {
            PairingState.Connecting -> Text("Connecting…")
            PairingState.WaitingApproval -> Text("Waiting for approval on the host…")
            is PairingState.Error -> Text("Failed: ${s.reason}", color = MaterialTheme.colorScheme.error)
            else -> {}
        }
    }
}
```

- [ ] **Step 7: Build (no new unit test for VM/screen — they're live-verified)**

Run: `cd android && JAVA_HOME=…/openjdk@17/…/Home ./gradlew :app:assembleDebug :app:testDebugUnitTest`
Expected: `BUILD SUCCESSFUL`; all unit tests pass.

- [ ] **Step 8: Commit**
```bash
git add android/app/src/main/java/com/eshaan/shepherd/pairing android/app/src/main/java/com/eshaan/shepherd/ui/PairingViewModel.kt \
  android/app/src/main/java/com/eshaan/shepherd/ui/PairingScreen.kt android/app/src/test/java/com/eshaan/shepherd/pairing
git commit -m "feat(android): pairing controller (pure) + pairing screen"
```

---

### Task 7: Fleet screen + view model

Goal: maintain a live `Fleet` from a paired `RemoteConnection` and render it (state dots, workspace grouping, pull-to-refresh). VM logic unit-tested; Compose device-deferred.

**Files:**
- Create: `app/src/main/java/com/eshaan/shepherd/ui/FleetViewModel.kt`, `FleetScreen.kt`, `theme/Theme.kt`
- Test: `app/src/test/java/com/eshaan/shepherd/ui/FleetViewModelTest.kt`

**Interfaces:**
- Consumes: `Fleet`, `AgentState` (Task 3); `RemoteConnection`, `ConnStatus` (Task 4); `Pairing`, `PairingStore` (Task 5); `PairingController.helloForReconnect` (Task 6).
- Produces:
  - `class FleetViewModel(store, fcmToken, connectionFactory)` with `val fleet: StateFlow<Fleet>`, `val connected: StateFlow<Boolean>`, `fun connect()`, `fun refresh()`, `fun applyInbound(ControlMessage)` (the pure reducer the test drives), `fun disconnect()`.
  - `object ShepherdColors` mapping `AgentState` → Compose `Color`, mirroring `Theme.swift` (working amber, blocked red-orange, needs-check blue, idle green-grey, error red, shell dim).

- [ ] **Step 1: Write the failing test**
```kotlin
package com.eshaan.shepherd.ui

import com.eshaan.shepherd.data.InMemoryPairingStore
import com.eshaan.shepherd.data.Pairing
import com.eshaan.shepherd.model.Fleet
import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.protocol.PaneInfo
import org.junit.Assert.*
import org.junit.Test

class FleetViewModelTest {
    private fun vm(): FleetViewModel {
        val store = InMemoryPairingStore()
        store.save(Pairing("h", 8722, "d", "n", "sec"))
        return FleetViewModel(store, fcmToken = { null }, connectionFactory = { _, _ -> null })
    }
    @Test fun snapshotThenDeltaUpdatesFleet() {
        val vm = vm()
        vm.applyInbound(ControlMessage.Snapshot(listOf(PaneInfo("p1","t","W","idle",null))))
        assertEquals(1, vm.fleet.value.panes.size)
        vm.applyInbound(ControlMessage.StateMsg("p1","blocked","approve Bash"))
        assertEquals("blocked", vm.fleet.value.pane("p1")!!.state)
        assertEquals(1, vm.fleet.value.attentionCount)
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Write `theme/Theme.kt`**
```kotlin
package com.eshaan.shepherd.ui.theme

import androidx.compose.ui.graphics.Color
import com.eshaan.shepherd.model.AgentState

object ShepherdColors {
    fun dot(state: AgentState): Color = when (state) {
        AgentState.WORKING -> Color(0xFFE0A458)
        AgentState.BLOCKED -> Color(0xFFE0683C)
        AgentState.NEEDS_CHECK -> Color(0xFF5B9BD5)
        AgentState.IDLE -> Color(0xFF6FBF8B)
        AgentState.ERROR -> Color(0xFFD9483B)
        AgentState.SHELL, AgentState.UNKNOWN -> Color(0xFF6B6B6B)
    }
}
```
(Approximate the `Theme.swift` state palette; exact hexes can be tuned later against `Theme.swift`.)

- [ ] **Step 4: Write `FleetViewModel.kt`**
```kotlin
package com.eshaan.shepherd.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.eshaan.shepherd.data.PairingStore
import com.eshaan.shepherd.model.Fleet
import com.eshaan.shepherd.pairing.PairingController
import com.eshaan.shepherd.protocol.ControlMessage
import com.eshaan.shepherd.transport.ConnStatus
import com.eshaan.shepherd.transport.RemoteConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

class FleetViewModel(
    private val store: PairingStore,
    private val fcmToken: suspend () -> String?,
    private val connectionFactory: (CoroutineScope, () -> ControlMessage.Hello) -> RemoteConnection?,
) : ViewModel() {
    private val _fleet = MutableStateFlow(Fleet(emptyList()))
    val fleet: StateFlow<Fleet> = _fleet
    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected
    private var conn: RemoteConnection? = null

    /** Pure reducer (unit-tested). */
    fun applyInbound(msg: ControlMessage) { _fleet.value = _fleet.value.applying(msg) }

    fun connect() {
        val p = store.load() ?: return
        val controller = PairingController(store)
        viewModelScope.launch {
            val token = fcmToken()
            val c = connectionFactory(viewModelScope) { controller.helloForReconnect(p, token) } ?: return@launch
            conn = c
            viewModelScope.launch { c.inbound.collect { applyInbound(it) } }
            viewModelScope.launch { c.status.collect { _connected.value = it is ConnStatus.Connected } }
            c.start()
        }
    }
    fun refresh() { /* reconnect re-snapshots; cheap no-op hook for pull-to-refresh */ disconnect(); connect() }
    fun disconnect() { conn?.stop(); conn = null; _connected.value = false }
    override fun onCleared() { disconnect() }
}
```

- [ ] **Step 5: Write `FleetScreen.kt`** (Compose; device-verified)
```kotlin
package com.eshaan.shepherd.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.eshaan.shepherd.model.AgentState
import com.eshaan.shepherd.protocol.PaneInfo
import com.eshaan.shepherd.ui.theme.ShepherdColors

@Composable
fun FleetScreen(vm: FleetViewModel) {
    val fleet by vm.fleet.collectAsState()
    val connected by vm.connected.collectAsState()
    LaunchedEffect(Unit) { vm.connect() }
    Scaffold(topBar = {
        TopAppBar(title = { Text(if (connected) "Agents" else "Agents (offline)") },
            actions = { TextButton(onClick = { vm.refresh() }) { Text("Refresh") } })
    }) { pad ->
        LazyColumn(Modifier.padding(pad).fillMaxSize()) {
            fleet.byWorkspace().forEach { (ws, panes) ->
                item { Text(ws, Modifier.padding(16.dp, 12.dp, 16.dp, 4.dp), style = MaterialTheme.typography.labelLarge) }
                items(panes, key = { it.paneId }) { PaneRow(it) }
            }
        }
    }
}

@Composable
private fun PaneRow(p: PaneInfo) {
    val state = AgentState.fromRaw(p.state)
    Row(Modifier.fillMaxWidth().padding(16.dp, 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(10.dp).clip(CircleShape).background(ShepherdColors.dot(state)))
        Spacer(Modifier.width(12.dp))
        Column {
            Text(p.title, style = MaterialTheme.typography.bodyLarge)
            val sub = p.reason ?: p.state
            Text(sub, style = MaterialTheme.typography.bodySmall)
        }
    }
}
```

- [ ] **Step 6: Wire navigation in `MainActivity.kt`** (replace the placeholder body)
```kotlin
// in setContent { MaterialTheme { ... } }:
val store = remember { com.eshaan.shepherd.data.EncryptedPairingStore(applicationContext) }
var paired by remember { mutableStateOf(store.load() != null) }
if (!paired) {
    val pvm = remember { PairingViewModel(store, fcmToken = { com.eshaan.shepherd.fcm.fcmToken() }) }
    PairingScreen(pvm) { paired = true }
} else {
    val fvm = remember {
        FleetViewModel(store, fcmToken = { com.eshaan.shepherd.fcm.fcmToken() },
            connectionFactory = { scope, hello -> store.load()?.let { com.eshaan.shepherd.transport.RemoteConnection(it.host, it.port, hello, scope) } })
    }
    FleetScreen(fvm)
}
```
(`com.eshaan.shepherd.fcm.fcmToken()` is defined in Task 8; until then stub it returning `null` — or implement Task 8 before this wiring. If executing strictly in order, leave `fcmToken = { null }` here and update in Task 8.)

- [ ] **Step 7: Run — unit tests PASS + `assembleDebug` SUCCESS.** Commit:
```bash
git add android/app/src/main/java/com/eshaan/shepherd/ui android/app/src/test/java/com/eshaan/shepherd/ui \
  android/app/src/main/java/com/eshaan/shepherd/MainActivity.kt
git commit -m "feat(android): live fleet screen + view model"
```

---

### Task 8: FCM — token mint, send-at-pairing, refresh, wake → local notification

Goal: obtain the FCM token (sent in `hello`), forward rotations via `refreshFCMToken`, and on a data-only wake raise a local notification (deep-linking to the agent). Payload-parse + notification-content logic unit-tested; token mint + delivery are device-deferred.

**Files:**
- Create: `app/src/main/java/com/eshaan/shepherd/fcm/FcmWake.kt` (pure), `Notifications.kt`, `ShepherdMessagingService.kt`, `FcmToken.kt`
- Modify: `app/src/main/AndroidManifest.xml` (register the service), `MainActivity.kt` (request POST_NOTIFICATIONS; use real `fcmToken()`)
- Test: `app/src/test/java/com/eshaan/shepherd/fcm/FcmWakeTest.kt`

**Interfaces:**
- Consumes: `AgentState` (Task 3); the wake data map.
- Produces:
  - `data class WakeContent(val paneId: String, val title: String, val body: String, val urgent: Boolean)`
  - `object FcmWake { fun parse(data: Map<String, String>): WakeContent? }` — pure: reads `paneID`/`state`/`urgent`, composes a human title/body from the state, returns null if `paneID` missing.
  - `suspend fun fcmToken(): String?` (in `FcmToken.kt`) — `FirebaseMessaging.getInstance().token.await()` wrapped.
  - `ShepherdMessagingService : FirebaseMessagingService` — `onNewToken` (persist + push `refreshFCMToken` if a pairing exists), `onMessageReceived` (parse → post local notification).
  - `object Notifications { fun ensureChannel(context); fun post(context, WakeContent) }`.

- [ ] **Step 1: Write the failing test**
```kotlin
package com.eshaan.shepherd.fcm

import org.junit.Assert.*
import org.junit.Test

class FcmWakeTest {
    @Test fun parsesBlockedWakeAsUrgent() {
        val w = FcmWake.parse(mapOf("paneID" to "p1", "state" to "blocked", "urgent" to "true"))!!
        assertEquals("p1", w.paneId); assertTrue(w.urgent)
        assertTrue(w.body.contains("needs you") || w.body.contains("blocked"))
    }
    @Test fun parsesNeedsCheckNonUrgent() {
        val w = FcmWake.parse(mapOf("paneID" to "p2", "state" to "need-to-check", "urgent" to "false"))!!
        assertFalse(w.urgent)
    }
    @Test fun nullWhenNoPaneId() {
        assertNull(FcmWake.parse(mapOf("state" to "blocked")))
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Write `FcmWake.kt`**
```kotlin
package com.eshaan.shepherd.fcm

import com.eshaan.shepherd.model.AgentState

data class WakeContent(val paneId: String, val title: String, val body: String, val urgent: Boolean)

object FcmWake {
    fun parse(data: Map<String, String>): WakeContent? {
        val paneId = data["paneID"] ?: return null
        val state = AgentState.fromRaw(data["state"] ?: "")
        val urgent = data["urgent"] == "true"
        val body = when (state) {
            AgentState.BLOCKED -> "An agent needs you (blocked)"
            AgentState.NEEDS_CHECK -> "An agent finished — needs a check"
            AgentState.ERROR -> "An agent hit an error"
            else -> "Agent update"
        }
        return WakeContent(paneId, "Shepherd", body, urgent)
    }
}
```
(Richer copy — pulling the pane title/reason — happens after the woken app re-snapshots over Tailscale; for the first cut the wake content is state-derived. Re-snapshot enrichment is a deferred polish.)

- [ ] **Step 4: Run — expect PASS** (`*FcmWakeTest`).

- [ ] **Step 5: Write `FcmToken.kt`, `Notifications.kt`, `ShepherdMessagingService.kt`** (device-verified)
```kotlin
// FcmToken.kt
package com.eshaan.shepherd.fcm
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
suspend fun fcmToken(): String? = suspendCancellableCoroutine { cont ->
    FirebaseMessaging.getInstance().token
        .addOnSuccessListener { cont.resume(it) }
        .addOnFailureListener { cont.resume(null) }
}
```
```kotlin
// Notifications.kt
package com.eshaan.shepherd.fcm
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.eshaan.shepherd.MainActivity
object Notifications {
    private const val CHANNEL = "agents"
    fun ensureChannel(context: Context) {
        val mgr = context.getSystemService(NotificationManager::class.java)
        if (mgr.getNotificationChannel(CHANNEL) == null)
            mgr.createNotificationChannel(NotificationChannel(CHANNEL, "Agent alerts", NotificationManager.IMPORTANCE_HIGH))
    }
    fun post(context: Context, w: WakeContent) {
        ensureChannel(context)
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("paneID", w.paneId)
        }
        val pi = android.app.PendingIntent.getActivity(context, w.paneId.hashCode(), intent,
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setContentTitle(w.title).setContentText(w.body)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setPriority(if (w.urgent) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(pi).setAutoCancel(true).build()
        runCatching { NotificationManagerCompat.from(context).notify(w.paneId.hashCode(), n) }
    }
}
```
```kotlin
// ShepherdMessagingService.kt
package com.eshaan.shepherd.fcm
import com.eshaan.shepherd.data.EncryptedPairingStore
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
class ShepherdMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        FcmWake.parse(message.data)?.let { Notifications.post(this, it) }
    }
    override fun onNewToken(token: String) {
        // Persist via pairing reconnect path; simplest: store handled at next connect.
        // If paired, a refresh is sent on the next control connection's hello (carries the live token).
        EncryptedPairingStore(this).load() // touch store; full refresh-over-channel is a deferred polish
    }
}
```
(`onNewToken` immediate `refreshFCMToken` over a live channel is a deferred polish — the token is always read fresh into each `hello`, so rotation is reconciled on the next connect, matching the host's `reconcile rotated FCM token on known-device reconnect` path.)

- [ ] **Step 6: Register the service + request notification permission**

In `AndroidManifest.xml`, inside `<application>`:
```xml
<service
    android:name=".fcm.ShepherdMessagingService"
    android:exported="false">
    <intent-filter>
        <action android:name="com.google.firebase.MESSAGING_EVENT" />
    </intent-filter>
</service>
```
In `MainActivity.onCreate` (before `setContent`):
```kotlin
com.eshaan.shepherd.fcm.Notifications.ensureChannel(this)
if (android.os.Build.VERSION.SDK_INT >= 33 &&
    checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
    registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) {}
        .launch(android.Manifest.permission.POST_NOTIFICATIONS)
}
```
(If `registerForActivityResult` placement in `onCreate` is awkward, request via a small `LaunchedEffect` + `rememberLauncherForActivityResult` in the composable instead — either is fine; verify on device.)

Update the Task 7 `MainActivity` wiring to use the real `fcmToken = { com.eshaan.shepherd.fcm.fcmToken() }`.

- [ ] **Step 7: Run — unit tests PASS + `assembleDebug` SUCCESS.** Commit:
```bash
git add android/app/src/main/java/com/eshaan/shepherd/fcm android/app/src/test/java/com/eshaan/shepherd/fcm \
  android/app/src/main/AndroidManifest.xml android/app/src/main/java/com/eshaan/shepherd/MainActivity.kt
git commit -m "feat(android): FCM token mint + data-only wake -> local notification"
```

---

### Task 9: Host — adopt phone-supplied pairing secret + surface the pairing code (Swift)

Goal: close the reconnect gap (host persists the phone-supplied secret) and make the pairing code + bind address discoverable so the user can actually pair. **This is host Swift, built/tested with `xcodebuild`**, not Gradle.

**Files:**
- Modify: `spike/seam1/Sources/RemoteProtocol.swift` (`pairingDecision`)
- Modify: `spike/seam1/Sources/AgentStore.swift` (`startRemoteServingIfEnabled` — log code + bind addr)
- Test: `spike/seam1/Tests/RemoteProtocolTests.swift` (new case)

**Interfaces:**
- Changes `pairingDecision` so a new device's persisted secret is the one the phone supplied (falling back to the host-minted `newSecret` only if the phone sent none). The wire protocol is unchanged (the `hello.secret` field already exists).

- [ ] **Step 1: Write the failing host test**

Add to `RemoteProtocolTests.swift`:
```swift
func testNewDeviceWithCodeAndSuppliedSecretPersistsThatSecret() {
    let d = pairingDecision(deviceID: "dev-1", name: "Pixel 8", code: "0042",
                            secret: "phone-secret", known: [], currentCode: "0042", newSecret: "host-fallback")
    guard case let .needsApproval(_, _, proposedSecret) = d else { return XCTFail("expected needsApproval") }
    XCTAssertEqual(proposedSecret, "phone-secret")   // phone-supplied wins
}
func testNewDeviceWithCodeNoSuppliedSecretFallsBackToHostSecret() {
    let d = pairingDecision(deviceID: "dev-1", name: "Pixel 8", code: "0042",
                            secret: nil, known: [], currentCode: "0042", newSecret: "host-fallback")
    guard case let .needsApproval(_, _, proposedSecret) = d else { return XCTFail("expected needsApproval") }
    XCTAssertEqual(proposedSecret, "host-fallback")
}
```

- [ ] **Step 2: Run — expect FAIL** (current code returns `newSecret` always)

Run: `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO test -only-testing:ShepherdModelTests/RemoteProtocolTests 2>&1 | tail -20`
Expected: the supplied-secret test FAILS.

- [ ] **Step 3: Change `pairingDecision`** in `RemoteProtocol.swift`:
```swift
    if let code, code == currentCode {
        return .needsApproval(deviceID: deviceID, name: name, proposedSecret: secret ?? newSecret)
    }
```
(Only the `proposedSecret:` argument changes — `secret ?? newSecret`.)

- [ ] **Step 4: Surface the pairing code + bind address** in `AgentStore.startRemoteServingIfEnabled()`, right after `if s.start() { remoteServer = s }`:
```swift
        if s.start() {
            remoteServer = s
            log("REMOTE serving on \(ip):\(remotePort) — pairing code \(pairingCode)")
        }
```
(Use the existing `log(_:)` helper that appends to `/tmp/shepherd-events.log`; if the helper has a different name, match the file's existing logging call. The user reads this line to pair.)

- [ ] **Step 5: Run host tests — expect PASS**

Run: `cd spike/seam1 && xcodebuild ... test -only-testing:ShepherdModelTests 2>&1 | tail -20`
Expected: all `ShepherdModelTests` pass (incl. the two new cases). Also build the app target to confirm `AgentStore` change compiles:
`xcodebuild ... -scheme Shepherd build 2>&1 | tail -5` → `BUILD SUCCEEDED`. (Do NOT launch the app.)

- [ ] **Step 6: Commit**
```bash
git add spike/seam1/Sources/RemoteProtocol.swift spike/seam1/Sources/AgentStore.swift spike/seam1/Tests/RemoteProtocolTests.swift
git commit -m "fix(remote): persist phone-supplied pairing secret + surface pairing code on serve"
```

---

## Deferred user-run device checklist (NOT subagent steps)

Per the standing rule, runtime/device verification is the user's gate:

1. **Build to a device:** `cd android && JAVA_HOME=…/openjdk@17/…/Home ./gradlew :app:installDebug` with a phone on USB (or an AVD from the installed system-images). Grant the notification permission prompt.
2. **Host serving:** ensure `defaults write com.shepherd.Shepherd shepherd.remote.serving -bool YES`, relaunch Shepherd, both Mac + phone on the tailnet. Read `/tmp/shepherd-events.log` for the `REMOTE serving on 100.x:8722 — pairing code NNNN` line.
3. **Pair:** in the app enter the host's `100.x` (or MagicDNS name), port `8722`, the 4-digit code → tap Pair → approve on the Mac → fleet list appears with live state dots.
4. **Live state:** drive an agent on the Mac (submit a prompt, trigger an AskUserQuestion) → watch the phone's dot change in real time.
5. **Push (the killer feature):** close/swipe the app, put the Mac in the "away" state (lid shut + no external display) or rely on routing → trigger a blocker → the phone gets an FCM wake → local notification → tap deep-links to the agent. **This is the last untested host gate** (real FCM delivery), unblocked once the app mints a real token.
6. **Reconnect:** kill + reopen the app → it reconnects with the stored secret (no re-pair) → fleet re-snapshots.

## Status / progress (update each session)

- **2026-06-30:** Plan written. Decisions: `android/` subdir, minSdk 31, JDK 17 installed, `google-services.json` provided (project `shepherd-da653`, applicationId `com.eshaan.shepherd`). Wire shapes captured from the real `RemoteProtocol.swift`. Reconnect-secret gap found + folded into Task 9. Branch `android-monitor-app` off `f1ed894`.
