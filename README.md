# Shepherd

An agent-native macOS terminal built on **libghostty**. It behaves like a normal
terminal (iTerm/Ghostty-style) until you start a **Claude Code** session in a
tab — then that session becomes a first-class, tracked **agent** with a live
state, surfaced in a sidebar, so you can run several at once without babysitting
any of them.

- **[`SPEC.md`](SPEC.md)** — the v1 design (state model, hook-driven engine,
  sidebar, build approach, deferred scope).
- **[`spike/`](spike/)** — the throwaway three-seam spike that de-risks the
  architecture before real building starts. Seams 2 & 3 (socket + Claude plugin)
  run today; seam 1 (libghostty surface) needs Xcode + GhosttyKit.

> v1 = single window, tabs (≤1 agent each), agent-state sidebar, attention-routing
> navigation, dock badge + backgrounded alerts. Everything else is v1.x — see
> SPEC.md §6.

## Setup

### Optional: clamshell-survival (Tier 2)

Shepherd's "Stay Awake" feature keeps the Mac awake while agents run. Out of the box it
uses an IOKit idle assertion (no setup) which holds while the lid is open. To also survive
**closing the lid**, grant Shepherd passwordless `pmset` once:

```sh
echo "$(whoami) ALL=(root) NOPASSWD: /usr/bin/pmset" | sudo tee /etc/sudoers.d/shepherd-pmset >/dev/null
sudo visudo -cf /etc/sudoers.d/shepherd-pmset      # validate
sudo -n pmset -g >/dev/null 2>&1 && echo "PASSWORDLESS OK" || echo "blocked"
```

If absent (or reverted by MDM), Shepherd auto-degrades to the idle assertion. The "Stay
Awake" menu shows which tier is active. A hard crash while holding can leave the kernel
`SleepDisabled` flag set until Shepherd's next launch (which clears it) or a reboot.

## Remote push (FCM) — host setup

Shepherd can wake a paired phone over Firebase Cloud Messaging when an agent
needs you and you're away from the Mac (lid shut, no external display). Setup is
one-time and shared with the Android client (step 3).

1. Create a free Firebase project at <https://console.firebase.google.com>.
2. **Project Settings → Service accounts → Generate new private key** → download the JSON.
3. Save it as `~/.config/shepherd/fcm-service-account.json`.

That's all — `project_id` is read from the key. With no key present, push is
silently disabled (Shepherd alerts locally as usual). The key is a send-only
FCM credential; treat it as a secret. Pushes carry only `{paneID, state, urgent}` — no
terminal content ever transits Google.
