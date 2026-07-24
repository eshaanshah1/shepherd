# In-app auto-update — design

**Date:** 2026-07-24
**Branch:** `feat-auto-update`
**Status:** approved design, pre-implementation

## Goal

Shepherd should update itself in its smoothest form — no "download a DMG and
drag it over yourself". Concretely:

1. Check GitHub Releases for a newer version **once a day** (and on launch if
   >24h since the last check). When one exists, float a quiet **"update
   available" badge at the bottom of the sidebar**. Clicking it downloads the
   release, installs it in the background, and prompts to restart — with
   **Restart now** and **Restart when all tabs are idle** (idle *includes*
   terminals not running a foreground process).
2. A **"Check for Updates"** button in Settings → General does the same on
   demand. If none: a transient "You're up to date". If found: an **inline
   panel showing the new version + changelog + an Update button** (same
   restart choices) — you decide right there without leaving Settings.
3. The app must report its **correct version number** (today it lies — see
   Prerequisite).
4. The popup/pill has a **close button = "skip this version"**: dismissing it
   suppresses that version, and it only reappears when a **newer** version is
   released (not the same one again tomorrow).
5. Settings can **disable the automatic popup entirely** (manual "Check for
   Updates" still works).

Engine decision: **hand-rolled**, native Swift, zero external deps (not
Sparkle) — chosen for full control of the custom UX (sidebar badge +
restart-when-idle gate) and to fit the app's native-DIY ethos. Trust anchor is
HTTPS from the **public** `eshaanshah1/shepherd` repo, so the update check needs
no auth token and no `gh`.

## Prerequisite: correct version number

`spike/seam1/project.yml` hardcodes `CFBundleShortVersionString: "0.0.1"` for
both targets, and the release workflow's `version` input is used only for the
release tag + DMG volume name — it is **never injected into the built app**. So
every installed release currently reports `0.0.1`. Any version-compare updater
is meaningless until this is fixed.

- **CI (`.github/workflows/release.yml`):** derive a plain semver from the
  `version` input (strip a leading `v`: `v0.5.0` → `0.5.0`) and pass it to the
  build so the bundle carries it — `xcodebuild … MARKETING_VERSION=<semver>
  CURRENT_PROJECT_VERSION=<n>`. If the xcodegen-generated project doesn't honour
  `MARKETING_VERSION`, stamp `CFBundleShortVersionString` into the built
  `Info.plist` with `PlistBuddy`/`agvtool` after the build, before signing.
- **Local/dev default:** keep a low sentinel (`0.0.0-dev`) in `project.yml` so
  dev/local builds always compare as older-than-any-release and the updater
  treats them as non-updatable (also caught by the dormancy gate below).

## When the feature is live vs dormant

The entire feature — daily check, sidebar badge, Settings action — is **dormant**
(existing behavior, untouched) unless **all** of these hold:

- Running the **`Shepherd`** target, not `ShepherdDev` (`AppMode.isDev` short-
  circuits everything).
- The running bundle lives in a **writable location** (`/Applications/
  Shepherd.app`) so an in-place swap succeeds without an auth prompt. Running
  from a read-only DMG mount or elsewhere ⇒ dormant.
- The current build version parses as a real release (not the `-dev`
  sentinel).

Dormancy is silent: no badge, no Settings row activity, no network.

## Components (all `spike/seam1/Sources/` unless noted)

Design for isolation: pure model bits are unit-tested with no AppKit; IO is a
thin shell around them (mirrors the repo's `SleepPolicy`/`SleepGuard`,
`StopPolicy`/`AgentStore.apply` pattern).

### `Version.swift` — pure
Semver parse + compare (`major.minor.patch`, tolerant of a leading `v`,
`-dev`/pre-release suffix sorts lower). The single comparison authority. In
`ShepherdModelTests`.

### `UpdateService.swift` — IO shell over pure parse
- `checkForUpdate() async -> UpdateAvailable?`: GET
  `https://api.github.com/repos/eshaanshah1/shepherd/releases/latest`
  (unauthenticated; `Accept: application/vnd.github+json`). Parse `tag_name`,
  `body` (changelog), and the **`Shepherd.zip`** asset's
  `browser_download_url`. Compare tag vs current `Version`; return
  `UpdateAvailable{ version, notes, zipURL }` when strictly newer, else `nil`.
  `/releases/latest` **excludes prereleases** by default — prerelease cuts are
  never offered.
- `download(_:) async`: stream the zip to a temp file (progress callback),
  `ditto -x -k` unpack to a temp dir, `codesign --verify --deep` the unpacked
  `Shepherd.app` (corruption check only — ad-hoc gives no identity guarantee),
  return the unpacked bundle path.
- The JSON→`UpdateAvailable` reduction and zip-asset selection are pure and
  unit-tested against fixture JSON; `URLSession`/`Process` are the shell.

### `UpdateInstaller.swift` — IO shell over pure script-gen
- Pure: `swapScript(pid:newBundle:installedPath:logPath:) -> String` — the
  detached bash script text, unit-tested.
- Script behavior: wait for the Shepherd PID to exit
  (`while kill -0 $PID 2>/dev/null; do sleep 0.2; done`) → `ditto` the new
  bundle over `/Applications/Shepherd.app` → `xattr -dr com.apple.quarantine`
  the installed bundle (so the non-notarized ad-hoc app relaunches with no
  Gatekeeper prompt) → `open` it. Logs to `/tmp/shepherd-update.log`. The
  `ditto` overwrite is the **last** destructive step, so a failure before it
  leaves the old app intact.
- `install(newBundle:)`: write the script to temp, launch it detached
  (`Process`, `setsid`/`nohup`-style so it outlives the app), then ask the app
  to terminate.

### `UpdateController.swift` — `@MainActor ObservableObject`
The state the UI binds to and the cadence owner.
- State: `.idle → .checking → .available(UpdateAvailable) →
  .downloading(Double) → .readyToRestart(newBundlePath) → .restarting`, plus
  `.upToDate` (transient) and `.error(String)`.
- Cadence: `shepherd.update.lastCheck` (UserDefaults, epoch). On launch, if
  dormancy gate passes, auto-check is enabled, and >24h elapsed, check; also
  schedule a ~24h repeating timer while running. `checkNow()` for the Settings
  button — **ignores** the 24h gate, the auto-check toggle, **and** the skipped-
  version filter (an explicit check always shows the truth).
- **Skip-this-version:** `shepherd.update.skippedVersion` (UserDefaults, a
  semver string). `skip(_:)` records the currently-available version. A found
  update is surfaced **automatically** (pill + daily notification path) only
  when its version is strictly **newer** than `skippedVersion` (so the same
  version never re-nags; a later release clears the suppression by comparison).
  The Settings manual check bypasses this and shows it regardless.
- **Auto-check toggle:** `shepherd.update.autoCheckEnabled` (UserDefaults,
  default `true`). When `false`: no launch check, no daily timer, no sidebar
  pill — the automatic popup is fully off. The Settings "Check for Updates"
  button still works on demand.
- Restart-when-idle arming: a `restartWhenIdle` flag; when set and the app is in
  `.readyToRestart`, observe `AgentStore` state transitions and fire the
  countdown the first time `allIdle()` becomes true.
- The 10s cancelable countdown lives here (`countdownRemaining`), driven by a
  timer; `cancelRestart()` disarms and returns to `.readyToRestart`.

### `IdleGate` — helper on `AgentStore`
`allIdle() -> Bool`: true iff **no** pane across **all** workspaces is
`working` or `blocked`, **and** no leaf surface reports
`ghostty_surface_needs_confirm_quit(surface)` (a live foreground command in a
shell pane). `needsCheck`/`error` panes count as **idle-safe** — the turn has
finished, nothing is running (and session-resume + layout-restore recover state
across the restart anyway).

## UI

### Sidebar footer (`SidebarView.swift`)
When `UpdateController.state` is `.available`/`.downloading`/`.readyToRestart`, a
quiet pill pinned at the **bottom of the sidebar**:
- `.available` → "↑ Update available (vX.Y.Z)".
- `.downloading` → a determinate progress ring + "Updating…".
- `.readyToRestart` → "Update ready".
- armed-when-idle → subtle "will restart when idle".

Styled from `Theme` tokens; `.focusable(false)` (sidebar focus rule — keystrokes
stay on the PTY). **No** OS notification and **no** dock badge — an available
update is informational, and must not dilute the agent-attention channel
(notification + dock badge) that means "an agent needs you now".

Clicking the pill opens a small popover/sheet: version + release notes + a
**Download & Install** button; once downloaded it offers **Restart now** /
**Restart when idle** / **Later**. A **close (×) button** on the popover/pill
means **"skip this version"** → `UpdateController.skip(version)` records it and
the pill disappears; it won't reappear until a newer release exists. ("Later"
keeps the pill for this same version; "×/skip" suppresses this version.)

### Settings → General (`SettingsView.swift`)
A **"Check for Updates"** button, a "last checked" line, the current version,
and an **"Automatically check for updates"** toggle
(`shepherd.update.autoCheckEnabled`). The button runs
`UpdateController.checkNow()`:
- Up to date → transient "You're up to date (vX.Y.Z)".
- Found → an **inline panel in Settings**: new version, changelog rendered from
  the release `body`, and an **Update** button + the same *Restart now /
  Restart when idle / Later* choices. Decide without leaving Settings.

The toggle, when off, disables the automatic launch/daily check + sidebar pill
(the manual button above still works). Turning it off does not clear a
skipped-version record; turning auto-check back on resumes normal surfacing.

Both entry points converge on the one `UpdateController` state, so the sidebar
pill and Settings panel never disagree.

### Restart-when-idle countdown
When idle is first reached (or immediately, on Restart now), a short
**"Updating in 10s… Cancel"** banner appears before relaunch. Cancel disarms and
keeps the pill/panel. On expiry → `UpdateInstaller.install()`.

## Data flow

```
launch / daily timer / Settings "Check for Updates"
  → UpdateController.check() → UpdateService.checkForUpdate() → GitHub API
  → .available → sidebar pill (+ Settings inline panel if triggered there)
  → user: Download & Install
  → UpdateService.download() (stream + unpack + verify → temp)  [.downloading]
  → .readyToRestart → user picks:
       Restart now       → 10s countdown → UpdateInstaller.install()
       Restart when idle → arm; on IdleGate.allIdle → 10s countdown → install()
       Later             → keep pill/panel
  → install(): detached swap script → app quits → script swaps bundle + relaunch
```

## Edge cases / failure handling

- **Network / API failure / rate-limit:** daily check fails silently (log only,
  no retry storm); the Settings button surfaces a small inline error.
- **Download / verify failure:** `.error`, then revert to `.available` so it can
  be retried from the pill/panel.
- **Swap-script failure (rare):** old app untouched (overwrite is the last
  step); badge reappears next launch. Script logs to `/tmp/shepherd-update.log`.
- **Already latest:** no pill; Settings shows "up to date".
- **Prereleases:** ignored via `/releases/latest`.
- **Not in `/Applications` / dev build:** dormant (no check, no UI).
- **Skipped version:** the automatic pill stays hidden while the latest release
  equals the skipped version; a strictly-newer release re-surfaces it. The
  manual Settings check always shows it regardless of skip.
- **Auto-check disabled:** no automatic check or pill at all; only the manual
  Settings button runs a check.

## Testing

`ShepherdModelTests` (pure, no AppKit — added to the target's `sources:` list in
`project.yml` after `xcodegen generate`):
- `VersionTests` — parse, compare, `v`-prefix, `-dev`/prerelease ordering,
  equal/edge.
- `UpdateServiceTests` — release-JSON → `UpdateAvailable` parsing, `Shepherd.zip`
  asset selection, newer-vs-up-to-date decisioning against fixture JSON.
- `UpdateInstallerTests` — swap-script text + path construction.
- Skip decision — a pure `shouldSurface(available:skipped:) -> Bool` (available
  strictly newer than the skipped version, or nothing skipped) lives next to
  `Version` and is unit-tested there.

Live network, the real bundle swap, and relaunch are **manual / deferred to the
user** (per "don't kill Shepherd while live" — verify by compile + unit tests;
runtime checks are the user's to run).

## Out of scope (v1)

- Delta/differential updates (full-zip swap only).
- Auto-download without a click (download is always user-initiated).
- Notarization / Developer ID signing (stays ad-hoc; quarantine stripped on
  install).
- Updating `ShepherdDev` (no releases; dormant by design).
- Rollback UI (the previous release remains reachable manually on GitHub).
```

## Open decisions locked in

- Idle gate: `needsCheck`/`error` panes are idle-safe; only `working`/`blocked`/
  live-shell-proc block a restart.
- Prereleases ignored (`/releases/latest`).
- Sidebar badge only — no OS notification / dock badge.
- Close (×) = skip-this-version (suppress until a newer release); "Later" keeps
  the same version pending. Manual Settings check ignores skip.
- Settings toggle disables automatic checking/pill; manual check still works.
