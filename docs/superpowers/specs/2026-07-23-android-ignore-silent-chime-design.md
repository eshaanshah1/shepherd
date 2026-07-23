# Android "Ignore silent" alerts + macOS chime — design

**Date:** 2026-07-23
**Branch:** `android-priortiy-notifs`
**Status:** approved, implementing

## Goal

When an agent needs the user (blocked / needs-check / error) and a data-only FCM
wake arrives on the phone, Shepherd can play the Mac's chime **on the Android alarm
audio stream** so it sounds through ringer-silent / vibrate — like an on-call alert
app. Gated by a user-controlled setting, **off by default**. The chime is the same
sound the macOS app uses.

## Approach: app plays the chime (not a notification-channel sound)

The app plays the sound itself via `MediaPlayer` configured with
`AudioAttributes.USAGE_ALARM`, rather than relying on a notification channel's sound.

**Why not a "critical" notification channel with an alarm sound?** Notification
channels are immutable after creation on API 26+, so a *runtime* toggle cannot flip
an existing channel's sound — that would force multiple pre-baked channels (one per
state × sound), and the user could still edit them in system settings. App-controlled
playback honors the toggle instantly, selects the right sound per state, needs no
special permission, and mirrors exactly how macOS does it (`NSSound`, not
`UNNotificationSound`). The visual notification banner is unchanged.

## Scope / boundaries

- Tied to the **FCM wake path** (Mac-away scenario) — where "phone on silent, agent
  finished" actually matters. Chiming on a live foreground control-channel connection
  is **out of scope** (deferred).
- **Silent / vibrate bypass only** via the alarm stream. No Do-Not-Disturb piercing,
  no `Notification Policy Access` permission, no new manifest permissions.
- The chime is suppressed for the pane the user is actively viewing (mirrors the
  existing banner suppression via `AppForeground.isViewing`).
- Single-user, one paired host (unchanged from the rest of the app).

## Components

Each is small, single-purpose, and independently testable.

1. **`res/raw/done.wav` + `res/raw/blocked.wav`** — the two macOS WAVs
   (`spike/seam1/Resources/done.wav`, `blocked.wav`) copied in verbatim. `res/raw`
   requires lowercase names; both already qualify → `R.raw.done`, `R.raw.blocked`.

2. **`data/SettingsStore.kt`** (new) — a thin `SharedPreferences`-backed store with a
   single boolean `ignore_silent` (default `false`). Interface + `InMemorySettingsStore`
   fake, matching the `PairingStore` test pattern (plain JUnit, no Robolectric).
   Not encrypted — it holds no secret.

3. **`fcm/Chime.kt`** (new) — an `object`:
   - `enum class ChimeKind { DONE, BLOCKED }`
   - pure `soundFor(state: AgentState): ChimeKind?` — `BLOCKED`/`ERROR` → `BLOCKED`,
     `NEEDS_CHECK` → `DONE`, else `null`. Unit-tested.
   - `play(context, state)` — resolves `soundFor`, and if non-null builds a one-shot
     `MediaPlayer` with `AudioAttributes(USAGE_ALARM, CONTENT_TYPE_SONIFICATION)`,
     plays the raw resource, and releases itself on completion (and on error). Thin
     Android glue, not unit-tested.

4. **`ui/SettingsScreen.kt`** (new) — reached by a **gear icon** added to the Fleet
   top bar's trailing slot. A `Switch` row labeled **"Sound alerts on silent"** with a
   one-line explainer ("Play a chime through the alarm volume even when your phone is
   on silent or vibrate."). Shown in-place from `FleetScreen` via a local `showSettings`
   state + a back arrow, leaving the existing Agent slide-nav in `MainActivity` untouched.

## Data flow

```
FCM data wake → ShepherdMessagingService.onMessageReceived
  → FcmWake.parse            (WakeContent now carries AgentState)
  → if !AppForeground.isViewing(wake.paneId):
        Notifications.post(...)                 // unchanged banner
        if SettingsStore(context).ignoreSilent:
            Chime.play(context, wake.state)     // alarm stream → ignores ringer silent
```

Only change to the wake model: add `state: AgentState` to `WakeContent`. `FcmWake`
already derives the state to pick the banner body; it is simply no longer discarded.

## State → sound mapping (mirrors macOS)

| AgentState             | Chime        | Source WAV   |
|------------------------|--------------|--------------|
| `NEEDS_CHECK`          | DONE         | `done.wav`   |
| `BLOCKED`              | BLOCKED      | `blocked.wav`|
| `ERROR`                | BLOCKED      | `blocked.wav`|
| anything else          | none         | —            |

(macOS maps needs-check→done and blocked→blocked; error is urgent so it reuses the
blocked chime on Android.)

## Testing

- `ChimeTest` — `soundFor(state)` mapping across all `AgentState` values. Pure JUnit.
- `SettingsStoreTest` — default is `false`; set/read round-trips. Via `InMemorySettingsStore`,
  plain JUnit.
- `FcmWakeTest` — extend to assert `parse` populates `state` for each attention state.

## Files

**New:** `data/SettingsStore.kt`, `fcm/Chime.kt`, `ui/SettingsScreen.kt`,
`res/raw/done.wav`, `res/raw/blocked.wav`, `test/.../fcm/ChimeTest.kt`,
`test/.../data/SettingsStoreTest.kt`.

**Edited:** `fcm/FcmWake.kt` (+`state` on `WakeContent`), `fcm/ShepherdMessagingService.kt`
(play hook), `ui/FleetScreen.kt` (gear + settings toggle), `test/.../fcm/FcmWakeTest.kt`.

## Non-goals (deferred)

- DND piercing / `Notification Policy Access`.
- Chiming over a live foreground control-channel connection.
- Per-state volume shaping (macOS drops `blocked` to 0.6; Android plays at alarm volume).
- A general settings framework beyond the one toggle (screen is built to grow, though).
