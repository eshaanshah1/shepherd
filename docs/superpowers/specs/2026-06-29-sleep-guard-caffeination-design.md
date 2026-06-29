# Sleep guard ("caffeination") for Shepherd

**Date:** 2026-06-29
**Branch:** `feat/sleep-guard-caffeination`
**Status:** design — pending implementation plan

---

## Overview

Shepherd runs long-lived Claude agents. Today the Mac can idle-sleep (or sleep on
lid-close) out from under a running agent, stalling it. This feature lets Shepherd
hold the machine awake while agents are doing work — including with the lid closed —
with an explicit user-chosen policy, a graceful fallback when the privileged path
isn't available, and a thermal safety valve so unattended closed-lid runs don't cook
the laptop.

The detection side already exists: per-pane agent state lives in `AgentStore.apply`
(`SessionStart`→idle … `SessionEnd`→shell), so "is any agent busy" is a pure read over
existing state. This feature adds the *power-management* side.

---

## Goals

- A user-selectable policy for when to keep the Mac awake (3 modes).
- Survive **lid close** when the machine allows it (the real point — long agent runs
  with the laptop shut).
- Work on a locked-down/managed laptop with **no required setup**, automatically using
  the strongest mechanism available and degrading silently if a stronger one disappears.
- Never leave the machine permanently unable to sleep (clean teardown + launch reconcile).
- A **thermal safety valve**: under a closed lid, if the machine runs hot, let it sleep
  and cool rather than holding it awake indefinitely.

## Non-goals (out of scope)

- A watchdog daemon to clean up after a hard crash (see Accepted limitations).
- AC-vs-battery awareness.
- Per-workspace or per-tab policies — the policy is global.
- A keybinding — menu control only for v1.
- Shepherd writing `/etc/sudoers.d/` itself — that one-time setup is user-driven and
  documented; Shepherd only *probes and uses* it.

---

## 1. Modes

A single global policy, persisted in `UserDefaults` under `shepherd.caffeinate.mode`
(stored as the enum's raw string). **Default: Off** — installing the feature must not
silently disable the Mac's sleep; the user opts in.

| Mode | `CaffeinateMode` | Hold the Mac awake when… |
|---|---|---|
| **Off** | `.off` | never |
| **While agents working** | `.whileAgents` | any pane (across **all** workspaces) is `working`, `blocked`, `needsCheck`, or `error` |
| **Always** | `.always` | the whole time Shepherd is running |

`.always` is the remote-control-friendly mode: it toggles the privileged flag exactly
once at app launch/enable and once at quit/disable, so even a password-prompting fallback
path would be tolerable there.

### "Busy" semantics (`.whileAgents`)

"Busy" = `state == .working || state.wantsAttention` — i.e. `working`, `blocked`,
`needsCheck`, or `error`. Plain `shell` panes and `idle` (acknowledged / waiting for a
fresh prompt) sessions do **not** hold the machine awake. Computed as
`AgentStore.hasBusyAgent`, scanning every pane in every tab in every workspace.

---

## 2. Mechanism — strongest available, reconcile, degrade

Exactly **one** mechanism is held at a time (they're redundant; Tier 2 already prevents
all sleep). SleepGuard prefers Tier 2 and falls back to Tier 1 per-cycle.

### Tier 2 (preferred) — `pmset disablesleep`
- `sudo -n pmset -a disablesleep 1` to hold; `… 0` to release.
- Sets the kernel `SleepDisabled` flag — the **only** thing that survives lid close.
- The display is still free to idle-sleep; we only keep the **system/CPU** alive (we do
  not force the panel on).
- Requires passwordless sudo for `pmset`. If `sudo -n` exits non-zero (e.g. an MDM
  check-in reverted the sudoers file), the toggle is treated as unavailable for that
  cycle and SleepGuard falls back to Tier 1.

### Tier 1 (fallback) — IOKit power assertion
- `IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep, …)`; release
  with `IOPMAssertionRelease`.
- No root, always available. Prevents **idle** system sleep while the lid is open.
- Does **not** survive lid-close-on-battery — that's the kernel-flag-only capability.

### Tier selection / availability
- SleepGuard does not maintain both. On each desired-state transition it attempts Tier 2;
  on failure it holds a Tier 1 assertion instead.
- The active tier is surfaced in the UI ("Clamshell survival: on / unavailable") so the
  user knows what they've got.

### Reconcile + teardown (never strand the flag)
- **Idempotent reconcile:** SleepGuard tracks what it is *currently* holding
  (`none` / `assertion` / `pmset`) and only shells out on an actual transition — no
  per-event subprocess spawns.
- **On launch:** reconcile the flag to the *desired* state. If desired is "not held",
  force `disablesleep 0` — this clears a stale `disablesleep 1` left by a previous crash.
- **On quit (`applicationWillTerminate`):** force `disablesleep 0` and release any
  assertion. Critical cleanup.

### Accepted limitation
A *hard* crash (SIGKILL, panic) while Tier 2 is held leaves `disablesleep 1` set until the
next Shepherd launch (which reconciles it) or a reboot. A kernel flag has no auto-expiry;
auto-recovering from a hard crash needs a watchdog daemon, which is out of scope. The
launch-reconcile covers the common relaunch path. Documented for the user.

---

## 3. Release grace (`.whileAgents` only)

`.whileAgents` drops the hold the moment every agent goes non-busy. A quick gap between
turns (agent finishes → `needsCheck` → you read it → `idle` → you type the next prompt)
would otherwise flap the kernel flag and could let the Mac sleep if you shut the lid in
that gap.

So when the last busy agent goes quiet, SleepGuard keeps the hold for a **grace period
(default 120s)** before releasing. A new busy agent within the window cancels the pending
release. (Single timer; no effect in `.always` or `.off`.)

---

## 4. Clamshell listener (Tier 2 only) — the thermal lever

With the lid closed and `disablesleep` keeping the CPU alive, trapped air between the
keyboard and panel heats up, and the **internal display is a real heat + power source
sitting under the closed lid**. Blanking it is the main thermal lever userspace has.

- **`ClamshellMonitor`** registers an IOKit interest notification on `IOPMrootDomain`
  (`IOServiceAddInterestNotification`, `kIOGeneralInterest`) and watches for
  `kIOPMMessageClamshellStateChange`. It reads the initial state at startup and exposes a
  current `isLidClosed` plus an on-change closure.
- It **only observes** clamshell messages — it does **not** participate in sleep
  arbitration (no `kIOMessageCanSystemSleep` ack), avoiding the 30s-sleep-delay footgun.
- On lid **close**, while Tier 2 is actively held, SleepGuard fires `pmset displaysleepnow`
  (no root) so the panel goes dark. No-op when Tier 2 isn't held.
- On a desktop Mac / no lid, `AppleClamshellState` is absent → treated as "lid open / not
  applicable"; all clamshell behavior no-ops.

---

## 5. Thermal auto-sleep (separate toggle)

An independent safety valve, persisted under `shepherd.caffeinate.thermalAutoSleep`
(Bool), toggled separately from the mode. **Clamshell-gated** — it only ever acts with the
lid closed, the unattended no-airflow case; with the lid open you are present and can see
it, and the OS already hard-throttles at `.critical` to protect the hardware.

- **`ThermalMonitor`** observes `ProcessInfo.processInfo.thermalState` via the
  `ProcessInfo.thermalStateDidChangeNotification` (pure Foundation, notification-based —
  no polling, no IOKit).
- **Lifecycle-scoped:** the monitor is **registered only when the lid closes while Tier 2
  is actively holding and the setting is on**, and torn down when the lid opens or the
  hold drops. It does not run during normal lid-open use — it can only ever act in that
  window anyway.
- When active and thermal state reaches `.serious` (or `.critical`), SleepGuard enters a
  **thermal override**: the desired-awake decision is forced `false` regardless of
  mode/agents, releasing the hold (`disablesleep 0`). With the lid closed, the Mac then
  sleeps and cools. A notification fires ("Letting your Mac sleep to cool down — thermal:
  serious") so paused agents aren't a mystery.
- **Hysteresis:** the override clears when thermal drops back below `.serious`. Because the
  machine sleeps after release, thermal monitoring naturally stops; on the next wake the
  silicon has cooled, so normal logic resumes without a tight hold→sleep→hold loop.

**Default:** `thermalAutoSleep = true` (safety-first). It is inert until a mode is enabled
*and* the lid is closed under Tier 2, so defaulting on is harmless for Off users.

---

## 6. Components & files

### New — pure model (unit-tested in `ShepherdModelTests`)
- **`SleepPolicy.swift`** — the `CaffeinateMode` enum (`.off`/`.whileAgents`/`.always`) and
  the pure decision:
  ```
  func shouldStayAwake(mode: CaffeinateMode,
                       hasBusyAgent: Bool,
                       thermalSuppressed: Bool) -> Bool
  ```
  `.off` → false; `thermalSuppressed` → false; `.always` → true; `.whileAgents` →
  `hasBusyAgent`. Deterministic, no AppKit/IOKit.

### New — app side
- **`SleepGuard.swift`** (`@MainActor`, singleton) — owns the `@Published` mode + thermal
  toggle, the active mechanism (`none`/`assertion`/`pmset`), the IOKit assertion handle,
  the `pmset` subprocess calls (`Process`, `sudo -n`), the release-grace timer, the
  launch/quit reconcile, and the active-tier readout. Wires `ClamshellMonitor` +
  `ThermalMonitor` and feeds their state into the pure `SleepPolicy`.
- **`ClamshellMonitor.swift`** — IOKit lid-state watcher (see §4).
- **`ThermalMonitor.swift`** — `ProcessInfo` thermal-state watcher (see §5).

### Edits
- **`AgentStore.swift`** — add `var hasBusyAgent: Bool` (scan all workspaces) and call
  `SleepGuard.shared.update(hasBusyAgent:)` everywhere it already calls `updateDockBadge()`
  (`apply`, `closePane`, `closeTabInWorkspace`, `deleteWorkspace`, `didFocus`).
- **`ShepherdApp.swift` / `AppDelegate.swift`** — the menu (§7), launch reconcile, and
  quit cleanup (`applicationWillTerminate`).
- **`project.yml`** — link **`IOKit`** framework (for the assertion + clamshell APIs); add
  `SleepPolicy.swift` to the `ShepherdModelTests` target. `xcodegen generate` after adding
  files.

---

## 7. UI (control surface)

A small menu group (in `ShepherdApp`'s command menus) containing:
- Three **radio** items for the mode (Off / While agents working / Always), checkmark on
  the active one, bound to `SleepGuard.shared.mode`.
- A **checkbox** item: "Sleep if running hot under a closed lid" → `thermalAutoSleep`.
- A non-interactive status line showing the active tier: "Clamshell survival: on" /
  "Clamshell survival: unavailable (using idle-sleep guard)".

Controls stay `.focusable(false)` per the sidebar convention so focus stays on the
terminal. No keybinding in v1.

---

## 8. One-time setup (documented, user-driven)

For Tier 2, the user adds passwordless sudo for `pmset` once:

```sh
echo "$(whoami) ALL=(root) NOPASSWD: /usr/bin/pmset" | sudo tee /etc/sudoers.d/shepherd-pmset >/dev/null
sudo visudo -cf /etc/sudoers.d/shepherd-pmset      # validate
sudo -n pmset -g >/dev/null 2>&1 && echo "PASSWORDLESS OK" || echo "blocked"
```

If this isn't present (or an MDM reverts it), Shepherd runs on Tier 1 automatically. To be
documented in `README.md` / `CLAUDE.md`. (Confirmed working on the target machine.)

---

## 9. Testing

- **`SleepPolicyTests`** (in `ShepherdModelTests`) — exhaustive truth table over
  `shouldStayAwake`: every mode × `hasBusyAgent` × `thermalSuppressed`, including the
  precedence (`thermalSuppressed`/`.off` beat everything).
- **`AgentStore.hasBusyAgent`** — extend existing model tests: shell/idle → false;
  working/blocked/needsCheck/error → true; busy pane in a *hidden* workspace still counts.
- SleepGuard / ClamshellMonitor / ThermalMonitor touch IOKit + subprocess + hardware
  events and are **not** unit-tested; they're kept thin over the tested policy and
  verified manually (lid close/open, thermal via `sudo pmset … ` or load, sudoers
  present/absent, crash-then-relaunch reconcile).

---

## 10. State / decision summary

| Decision | Choice |
|---|---|
| Privilege path | Tier 2 `pmset disablesleep` (confirmed available); Tier 1 IOKit assertion fallback; auto-degrade |
| Modes | Off (default) / While agents working / Always |
| "Busy" | working ∪ blocked ∪ needsCheck ∪ error (not idle, not shell), across all workspaces |
| Release grace | 120s, `.whileAgents` only |
| Clamshell display-blank | in v1, Tier 2 only, `pmset displaysleepnow` on lid-close |
| Thermal auto-sleep | separate toggle (default on), clamshell-gated, fires at `.serious`, monitor lifecycle-scoped to clamshell-held window |
| Crash cleanup | launch-reconcile + quit-teardown; hard-crash stranding accepted/documented |
