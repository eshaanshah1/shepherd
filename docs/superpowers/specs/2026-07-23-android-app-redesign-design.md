# Android app redesign — design

**Date:** 2026-07-23
**Status:** approved design, pre-implementation
**Scope:** all three Android screens (Pairing, Fleet, Agent) — a mobile-native
premium reskin plus the interaction wins that fall out naturally. No transport,
protocol, or view-model re-architecture.

## Problem

The Android client works end-to-end but looks like stock Material3 on true black:
default `TopAppBar`s with "Back"/"Refresh" text buttons, flat `LazyColumn` rows,
bare `OutlinedButton`/`OutlinedTextField` controls. It reads as unfinished, and
its state palette **disagrees with the Mac app** (Android: working=amber,
needs-check=blue, idle=green; Mac `Theme.swift`: working=blue, done=green,
blocked=amber, idle=gray). So the two feel like different, less-considered
products.

## Goal

A coherent, premium mobile client that is unmistakably the same Shepherd as the
desktop — restrained, dark, elevation-by-tint — but laid out for a phone used
**like an inbox**: the agents that need you are big and descriptive at the top;
everything else is a thin scannable row.

## Direction (locked)

- **Aesthetic:** mobile-native premium. Coherent with the Mac's restrained dark
  feel and its exact palette, but phone-idiomatic layout (bigger targets, cards,
  pull-to-refresh, inbox model) — **not** a literal port of the desktop chrome.
- **Theme mode:** dark-only for v1. (Light/warm parity with the Mac is deferred.)
- **Typography:** bundle **DM Sans** as the UI typeface (matches the Mac chrome).
  The terminal grid stays `Typeface.MONOSPACE` for v1.

## Approach (locked)

**Token system + a small component library**, then rebuild the three screens on
top — mirroring how the Mac centralizes everything in `Theme.swift`, so phone and
desktop can't drift and future screens are cheap. (Rejected: in-place per-screen
restyle — reproduces the one-off drift that made today's UI feel "mid".)

---

## Section 1 — Foundation (tokens)

New `ui/theme/` foundation, ported verbatim from the Mac `Theme.swift` dark
palette.

### Color tokens
Surfaces separate by **tint, not borders/shadows** (Linear discipline):

| Token | Hex | Use |
|---|---|---|
| `ground` | `0x0F0F11` | app background |
| `surface1` | `0x141417` | bars, cards, key bar |
| `surface2` | `0x1A1A1E` | raised cards, input field, manual-entry card |
| `surface3` | `0x212127` | pressed/hover |
| `hairline` | `0x232327` | the terminal pane border |
| `divider` | white @ 5% | inter-group washes |
| `textPrimary` | `0xEDEDED` | titles |
| `textSecondary` | `0x8C8C92` | subtitles |
| `textDim` | `0x5F5F66` | labels, chevrons, workspace field |

### State colors (realigned to the Mac's semantics — the current mismatch is fixed)

| State | Hex | Meaning |
|---|---|---|
| working | `0x5B9DF8` (blue) | busy — leave it |
| needsCheck | `0x43C988` (green) | done — ready for you |
| blocked | `0xE5A23D` (amber) | your move |
| error | `0xE5645D` (red) | broke |
| idle | `0x8C8C92` (gray) | between turns |
| shell | `0x5F5F66` (dim) | no agent |

`accent` = working blue, spent sparingly. `ShepherdColors.dot(state)` is rewired
to these values; nothing else references the old ones.

### Type
Bundle DM Sans as a font resource; a `FontFamily` + a Compose `Typography` with
DM Sans across styles, **medium (500) default weight** (matching the Mac's
`Font.ui`). Terminal stays `MONOSPACE`.

### Shape / spacing
- Corner radius: ~14dp cards, ~10dp controls.
- Spacing scale: 4 / 8 / 12 / 16 / 24 dp.

### Components (reusable composables)
`StateDot` (with optional slow pulse), `StatusPill`, `ConnectionChip`,
`AttentionCard`, `AgentRow`, `ShepherdTopBar`, `PrimaryButton`, `OptionCard`,
`KeyPill`, `SwipeNavStrip`. Screens compose only these.

---

## Section 2 — Fleet screen (the inbox)

**Workspace stops being a grouping axis** — it becomes a *field on each item*.
The list is one **globally-sorted inbox** across all workspaces, in two tiers.

### Top bar (`surface1`, custom — not Material `TopAppBar`)
- Large "Agents" title (DM Sans).
- A **`ConnectionChip`** on the right: tiny state dot + `Connected` /
  `Reconnecting…` / `Offline`. Replaces both the old `"Agents (offline)"` title
  hack and the "Refresh" button.
- When ≥1 agent wants attention, a quiet summary line under the title —
  e.g. `2 need you` — in the blocked amber. This line effectively titles Zone 1.

**Refresh** → **pull-to-refresh** on the list. The button is removed.

### Global sort
`wantsAttention` first, then by urgency:
`blocked → error → needsCheck → working → idle → shell`.

### Zone 1 — "Needs you" (large `AttentionCard`s, top)
Everything with `wantsAttention` (blocked / error / needsCheck). Each card
(`surface1`, rounded 14dp, no border):

```
┌────────────────────────────────────────┐
│  ●  agent title                         │   ● large state dot
│     shepherd · android-app-redesign     │   workspace field, dim
│     blocked — approve Bash              │   reason, in the state color
└────────────────────────────────────────┘
```

Tapping opens the Agent screen. Reason falls back to the raw state word when
`PaneInfo.reason` is null.

### Zone 2 — everything else (thin `AgentRow`s)
working / idle / shell, sorted working → idle → shell:

```
●  agent title              shepherd  ›
```

state dot + name + workspace (dim, right-aligned) + chevron. The **working dot
pulses** subtly (slow opacity breath); idle/shell dots are static.

The two zones separate on whitespace — no loud section headers.

### States
- **Empty** (no agents): centered glyph + "No agents running" + a one-line hint.
- **Loading** (connecting, list empty): a few shimmer skeleton rows, not a blank
  screen.

---

## Section 3 — Agent screen

### Top bar (`surface1`)
Back **chevron icon** (not "Back" text) · agent title · a **`StatusPill`** on the
right (state dot + word: `Working` / `Blocked` / `Ready`) that absorbs the old
`Connecting…` / `Disconnected` labels.

### Terminal — contained pane
Wrap the Termux `TerminalView` in a defined pane: rounded corners (~12dp), a
`hairline 0x232327` border, and a small inset from the chrome, so the black grid
clearly starts and ends instead of bleeding edge-to-edge. Grid sizing already
measures the view's own allocated area (`pushGridSize`), so the inset just
recomputes cols×rows cleanly — no cut-off. Terminal behavior is otherwise
unchanged.

### Extra-keys bar — one slim line
`surface1` bar, a single row:

```
┌─────────────────────────────────────────────┐
│  Esc  ^C  Tab  ↵          ╭───────────╮   ⌄  │
│                           │ ‹ swipe ›  │      │
│                           ╰───────────╯      │
└─────────────────────────────────────────────┘
```

- **Left:** `Esc` `Ctrl-C` `Tab` `Enter` as `KeyPill`s (the constantly-used keys),
  always visible.
- **Right:** a **`SwipeNavStrip`** — a trackpad-style pad you swipe in any
  direction to emit the corresponding arrow key; holding at an edge auto-repeats.
  Replaces the four loose arrow buttons; stays on one line.
- **`⌄` handle:** collapses the whole key bar to hand full height to the terminal;
  tap to restore.

### Input field
A rounded `surface2` text field + a **circular accent send button** (paper-plane
icon) instead of the boxed "Send". IME Send still submits.

### Prompt panel (blocked agent) — the mobile centerpiece
`AskUserQuestion` becomes proper **`OptionCard`s**:
- Question text prominent (DM Sans primary).
- Each option = a large tappable card; selected = accent-tinted fill + left
  accent bar + check. Multi-select cards toggle; a full-width **Submit** below.
- A lone single-select still submits on one tap (keeps today's behavior).
- Permission / plan kinds: a clean info card ("Answer in the terminal") — behavior
  unchanged.
- **Sending** state: an inline progress card (not a bare spinner + text).
- **"Use terminal instead":** a quiet text button pinned at the bottom.

---

## Section 4 — Pairing screen

A real onboarding layout instead of a left-aligned `Column`:
- Vertically centered; a Shepherd **wordmark** up top.
- Headline + one-line instruction ("On the Mac: ⋯ → Connect a phone… → scan").
- A big primary **"Scan QR to pair"** button (accent, QR icon).
- **Manual entry** behind a quiet "Enter host manually" toggle → a `surface2`
  card with restyled host/port fields + a Pair button.
- Connection states (`Connecting…` / `Waiting for approval` / error) render as a
  **`StatusPill`/chip** — state dot + spinner; error in red.

Pairing logic (QR parse, manual pair, state machine) is unchanged.

---

## Non-goals / deferred

- Light & warm theme parity with the Mac (dark-only for v1).
- Bundling JetBrains Mono for the terminal grid (stays `MONOSPACE`; changing it
  touches grid metrics — separate, riskier slice).
- Any transport / protocol / view-model changes. Redesign is view-layer only:
  `ui/*.kt` + `ui/theme/*.kt` + font/vector resources.
- Gesture navigation between screens, swipe actions on rows, a home dashboard
  (bigger UX bets, out of scope for this pass).

## Testing

- Existing view-model / protocol unit tests must stay green (no logic changes).
- Pure helpers introduced (sort/partition of panes into the two inbox zones,
  any state→label/color mapping) are extracted so they're unit-testable without
  Compose, and covered.
- Visual verification is on-device by the user (emulator/phone screenshots),
  consistent with how the Mac app defers runtime UI checks.
