# 0020. "The user is viewing this pane" is one predicate, and the state machine consults it

Status: Accepted
Date: 2026-07-29

## Context
An agent that finished its turn in the pane you were **already looking at** went to
`need-to-check` ("done"), not `idle`: the dot flipped to amber, the dock badge
incremented, the chime played, and it stayed that way until you clicked into some
other pane and back. The banner, meanwhile, correctly did not fire.

Two separate causes, one shape:

1. **`applyEvent` has no notion of focus.** `Stop` mid-turn with no background
   tasks set `.needsCheck`, unconditionally. The only `needsCheck → idle` path is
   `didFocus`, which fires on a focus *transition* — `select(tabID:)`, `focusPane`,
   ⌘⇧A, a notification click. A pane that was already focused when `Stop` landed
   produced no transition, so nothing cleared it. Worse, `focusPane` early-returns
   when the pane is already the tab's focused pane, so clicking or typing *into*
   that pane didn't clear it either.

2. **The focus check lived only in the notification.** `notifyAttention` carried
   its own `guard !NSApp.isActive || hidden`. That is the whole reason the banner
   behaved while the dot didn't — the app had exactly one place that asked "is the
   user looking at this?", and it was the presentation layer. That guard was also
   coarser than it read: `hidden` was workspace-level only, so an agent blocking on
   a **different tab of the same workspace** while Shepherd was frontmost fired no
   banner at all, despite having no dot in front of you. And `playAttentionSound`
   sat outside the guard entirely, so the done chime played while you watched.

`need-to-check` means *you have not seen the result yet*. That is a claim about the
user's attention, so anything that acts on it — the state itself, the badge, the
banner, the chime, the push — has to read the same predicate, or they drift.

## Decision
One predicate, computed once per event, threaded everywhere.

- **`AgentStore.isFrontPane(_:)`** — the pane whose terminal your eyes could be on:
  focused pane of the selected tab in the selected workspace (`tabs`/`selectedTab`
  are already workspace-scoped), on screen rather than starved by a zoomed sibling
  (`Tab.isShowing`), and not covered by a full-takeover overlay (`diffPanelOpen` /
  `codeSurface`). An ephemeral pane never qualifies.
- **`AgentStore.isViewing(_:)`** = `NSApp.isActive && isFrontPane(_:)`.
- **`applyEvent(..., viewing:)`** — a finished `Stop` lands on `.idle` when
  `viewing`, `.needsCheck` otherwise. `blocked` / `error` deliberately ignore it:
  an unanswered question does not answer itself because the tab is on screen.
- **`StateTransition.turnFinished`** — set by both landings. Side effects keyed off
  "a turn ended" (`diffTurnPane`/`diffTurnTick`, the workbench's refresh signal)
  read this, never `state == .needsCheck`, which would now miss the viewing case.
- **`notifyAttention` lost its guard**; the caller gates banner, chime *and* push
  on the one `!viewing`. So the tab-in-another-tab case now correctly notifies.
- **`applicationDidBecomeActive` → `AgentStore.didBecomeActive()`** — coming back
  to Shepherd counts as looking, so the front pane's finished turn clears without
  demanding a click. It calls `didFocus`, whose overlay teardown is a no-op here
  because `isFrontPane` already required no overlay. It deliberately uses
  `isFrontPane`, not `isViewing`: `NSApp.isActive` at the moment that delegate
  callback runs is not something to depend on.

The away→present FCM catch-up replay gets the same `!isViewing` filter — the lid
opening is a different edge from app activation, so it could otherwise banner the
pane you are looking at.

## Consequences
- A turn that finishes under your eyes reads `idle`, contributes nothing to the
  dock badge, and is skipped by ⌘⇧A. That is the point.
- More banners than before in one case: Shepherd frontmost, pane needing you on a
  **different tab of the current workspace**. Previously silent, which was a bug —
  that tab's dot is not what you're looking at.
- `viewing` is a *proxy* for attention, not attention. Frontmost-and-focused does
  not prove the user is at the keyboard, so a turn finishing while they are away
  from the desk with Shepherd frontmost will read `idle` and go unflagged. This is
  the same assumption the notification guard already made, now applied
  consistently rather than in one layer.
- Don't reintroduce a second focus/visibility check anywhere. If a new surface
  needs one, call `isViewing` / `isFrontPane`.

## Lesson
When one state's *meaning* is a claim about the user ("you haven't seen this yet"),
every channel that acts on it must share one predicate. Putting the check in the
notification alone doesn't produce a partial fix — it produces a system whose dot
and whose banner tell different stories, and only the visible half looks correct.
