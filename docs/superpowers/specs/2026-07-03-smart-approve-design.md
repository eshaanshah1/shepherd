# Smart Approve — in-app tappable answers for blocked agents

**Date:** 2026-07-03
**Status:** Design (approved in brainstorm; pending written review).
**Prereq:** builds on Android Phase 2 sub-project B (remote terminal, on `master` as `9044691`) —
the control channel, the Agent screen, and the raw-input path.

---

## 1. Goal

When an agent is **blocked** waiting on you, the phone should let you answer with **taps** instead of
navigating a TUI menu with the arrow keys. The buttons are a **convenience layer over the faithful
terminal** — the raw terminal (which already works: arrows + space + enter) stays as the fallback and
the ground truth. Buttons are strictly additive; they never block or replace the terminal path when
we can't render them.

## 2. Scope

**In (v1):**
- **In-app only** — buttons render on the Agent screen. No notification action buttons (deferred).
- **All four blocking prompt types:** `AskUserQuestion` single-select, `AskUserQuestion` multi-select
  (incl. **mixed** single+multi in one call), permission approve/deny, and plan approval (ExitPlanMode).
- Answering synthesizes **PTY keystrokes** into the existing input path (no structured answer API exists).

**Out (deferred):**
- Notification action buttons (answer without opening the app).
- Elicitation / other prompt kinds.
- Editing an in-progress selection after Submit (you re-drive the terminal if you misclick).

## 3. Decisions (from brainstorm — the "why")

- **Keystroke synthesis, not a structured answer.** The only channel to Claude is PTY bytes; the
  hook is observe-only. Confirmed key model (per user):
  - **Single-select:** arrow to the option → **Enter** (selects *and* advances to the next question).
  - **Multi-select:** **Space** to toggle each chosen option → **Enter** (submits *and* advances).
  - **Mixed multi-question:** one atomic `AskUserQuestion` call can mix single- and multi-select
    questions with varying option counts. Answered as one form: run the per-question block in order;
    each block reads its OWN `multiSelect` + option count and ends in Enter (which advances). The
    live experiment confirmed a multi-question call is a single atomic interaction returning all
    answers together.
- **Panel replaces the terminal until answered.** When a pane is blocked and we have a prompt, the
  Agent screen swaps the terminal for the prompt panel; the terminal returns once answered (state
  leaves `blocked`).
- **Single tap = submit** for a **lone single-select** question (fewest taps). Any **multi-select**
  or **multi-question** form accumulates selections behind one **Submit** (you can't fire Q1 before
  Q2 exists).
- **Synthesis is one isolated, replaceable module.** The key tables live in a single pure unit so a
  Claude CLI TUI change is a one-file edit, and it's unit-tested against golden byte sequences.

## 4. Architecture — five isolated units

```
Claude blocks (AskUserQuestion / permission / ExitPlanMode)
  → hook fires → report.sh  [1] forwards the structured prompt on the socket
  → AgentStore                  caches it per pane + broadcasts ControlMessage.prompt  [2]
  → phone RemoteConnection      receives prompt, caches against paneID
  → Agent screen  [4]           renders the prompt panel (replaces terminal); you tap
  → PromptKeystrokes.synthesize [3]  → bytes → existing DataChannel.input → host PTY
  → agent advances → state leaves blocked → panel dismisses, terminal returns
```

### [1] Hook payload extension — `claude-plugin/hooks/report.sh`
Add an optional **`payload`** field to the socket message (today `{tab_id, event, detail}`), carrying
structured prompt data. `detail` is UNCHANGED (still `tool_name` for `PreToolUse` — the state machine
still keys off it). Only `PreToolUse[AskUserQuestion]` populates `payload`: parse `tool_input.questions`
to a compact JSON array of `{prompt, header, options:[label...], multiSelect}` (via `jq`, only on this
blocked event — same discipline as the `Stop` `background_tasks` parse). Permission/plan carry no
payload — their prompt is fully described by the event + `tool_name` (see [5]). Fails safe: no/garbled
`payload` → no buttons, terminal fallback.

### [2] Transport — `ControlMessage.prompt` (Swift `RemoteProtocol.swift` + Kotlin, byte-pinned)
New additive control message, host→phone:
```
prompt(paneID: String, kind: String, detail: String?, questions: [PromptQuestion]?)
  kind ∈ "askUserQuestion" | "permission" | "plan"
  detail    — permission: the tool name ("Bash"); else nil
  questions — askUserQuestion only: [{ prompt, header, options: [String], multiSelect: Bool }]
```
`AgentStore` sends it when a pane transitions to `blocked` for one of the three kinds (reusing the
same broadcast path as `.state`). The phone caches `prompt` against the paneID; a subsequent `.state`
that leaves `blocked` clears it. Wire shape mirrors existing enum-Codable single-key framing.

### [3] Keystroke synthesis — `PromptKeystrokes` (Kotlin, pure, unit-tested)
`fun synthesize(kind, questions, selections): ByteArray`. Byte vocabulary: `Up`=`ESC [ A`,
`Down`=`ESC [ B`, `Enter`=`\r` (0x0D), `Space`=0x20.
- **askUserQuestion:** every question loads with **option 0 highlighted by default**, so the cursor
  starts at index 0 — no reset needed. For each question in order:
  - **single-select:** `Down × chosenIndex` → `Enter`,
  - **multi-select:** from index 0, for each chosen index ascending, `Down ×` (delta from current
    cursor) → `Space`; then `Enter`,
  - (Enter advances to the next question — which again starts at index 0; the final Enter submits.)
- **permission:** the approve / deny key sequence for the permission menu (its own 2–3 choice table).
- **plan:** approve / keep-planning sequence.
The permission/plan key tables are confirmed against a live pane during implementation (on-device
test); if a kind's table is unknown, that kind falls back to the terminal (§8).

### [4] Agent-screen UI — `PromptPanel` (Compose)
When the pane is `blocked` AND a cached prompt exists, replace the `TerminalView` with a `PromptPanel`:
- **askUserQuestion:** one group per question — single-select → radio-style buttons; multi-select →
  checkboxes. A lone single-select question submits on tap; otherwise a **Submit** button sends the
  whole form via `synthesize(...)` → `DataChannel.input`.
- **permission:** the question/`detail` ("Approve running Bash?") + **Approve** / **Deny** (and, if
  the menu offers it, **Approve & don't ask again**).
- **plan:** the prompt + **Approve** / **Keep planning**.
- A small **"Use terminal instead"** toggle always lets you drop to the raw terminal.
On `.state` leaving `blocked`, the panel dismisses and the terminal returns.

### [5] Prompt-type detection (host)
Reuses the shipped state machine: `PreToolUse[AskUserQuestion]` → `blocked` + payload; `PermissionRequest`
→ `blocked`, `kind=permission`, `detail=tool_name`; `PreToolUse[ExitPlanMode]` → `blocked`, `kind=plan`.
No new detection logic — just emit `.prompt` alongside the existing `.state` broadcast.

## 5. Error handling / graceful degradation

Buttons are additive. In every failure mode the phone shows **just the terminal** (today's behavior):
no cached prompt, unrecognized kind, empty/garbled payload, or a prompt-type whose keystroke table
isn't pinned. A mismatch (synthesis lands on the wrong option) is recoverable — the terminal reflects
the real TUI state, so you see it and can correct by hand.

## 6. Testing

- **`report.sh`:** feed an `AskUserQuestion` `tool_input` fixture → assert the emitted `payload` JSON
  (questions/options/multiSelect); assert permission/plan emit no payload and unchanged `detail`.
- **Codec parity:** `ControlMessage.prompt` round-trips identically Swift↔Kotlin (golden vectors).
- **`PromptKeystrokes` (the core):** golden byte sequences — single-select index k; multi-select set;
  a mixed 3-question form; permission approve/deny; plan approve. Assert cursor-reset + exact bytes.
- **VM/UI:** blocked + cached prompt → panel shown with correct controls per question; state-leaves-
  blocked → panel dismissed.
- **On-device (adb):** answer a real single-select, a real multi-select, a mixed multi-question form,
  a Bash permission, and a plan approval — each via buttons; confirm the agent advances. Pin the
  permission/plan key tables here.

## 7. Deferred (post-v1)
- Notification action buttons (Approve/Deny + ≤3-option single-selects) so you can answer without
  opening the app.
- Elicitation and any other prompt kinds.
- "Approve & don't ask again" nuances beyond what the menu trivially exposes.
