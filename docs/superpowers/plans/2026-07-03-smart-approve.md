# Smart Approve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the phone answer a blocked agent with taps (radio/checkbox buttons) instead of arrow-key TUI navigation, by forwarding the structured prompt to the phone and synthesizing the answering PTY keystrokes.

**Architecture:** The host hook forwards `AskUserQuestion` structure on the socket; `AgentStore` broadcasts a new `ControlMessage.prompt` when a pane blocks; the phone caches it, renders a `PromptPanel` (replacing the terminal), and on submit runs a pure keystroke-synthesis module whose bytes go through the existing input path. Buttons are additive — the raw terminal remains the fallback.

**Tech Stack:** Swift host + `shepherdd` helper + `ShepherdModelTests`; Kotlin/Android (Compose, kotlinx-serialization, JUnit); Termux terminal view (existing).

## Global Constraints

- **Wire codec:** `[u32 BE len][json]`; Swift enum-Codable single-key-object shape (`{"prompt":{…}}`); nil fields omitted; JSON keys `paneID`/`kind`/`detail`/`questions`/`prompt`/`header`/`options`/`multiSelect`. Kotlin must match byte-for-byte.
- **`report.sh` stays pure bash**, exits 0, never blocks Claude; only the already-parsed blocked events do `jq` work. `detail` semantics UNCHANGED (still `tool_name` for `PreToolUse`).
- **Buttons are additive:** any failure (no/garbled prompt, unknown kind, unpinned keys) → show only the terminal (today's behavior).
- **Keystroke model (confirmed):** every question loads with **option 0 highlighted by default**, so the cursor starts at index 0 — **no cursor reset needed**. Single-select = `Down × index` then `Enter`; multi-select = from index 0, `Down` to each chosen option + `Space` to toggle, then `Enter`; `Enter` advances to the next question (which again starts at index 0).
- **Byte vocabulary:** `Up`=`1b 5b 41`, `Down`=`1b 5b 42`, `Enter`=`0d`, `Space`=`20`.
- **Don't launch/kill the live macOS app**; verify host by unit tests. Android JDK 17 (`/opt/homebrew/opt/openjdk@17`). Commits end with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` line.
- Branch: `smart-approve` (off `master`).

## File structure

- `claude-plugin/hooks/report.sh` — add optional `payload` (AskUserQuestion questions).
- `spike/seam1/Sources/RemoteProtocol.swift` — `PromptQuestion` + `ControlMessage.prompt`.
- `spike/seam1/Sources/SocketServer.swift` — parse `payload`, widen `onEvent`.
- `spike/seam1/Sources/AgentStore.swift` — thread `payload`, broadcast `.prompt` on block.
- `android/.../protocol/ControlMessage.kt` + `WireCodec.kt` — Kotlin `Prompt`/`PromptQuestion`.
- `android/.../terminal/PromptKeystrokes.kt` (new) — pure synthesis.
- `android/.../ui/AgentViewModel.kt` — observe inbound prompt, expose `prompt` state.
- `android/.../ui/PromptPanel.kt` (new) + `AgentScreen.kt` — render + submit.

---

### Task 1: Host hook — forward AskUserQuestion questions as `payload`

**Files:**
- Modify: `claude-plugin/hooks/report.sh`
- Test: `claude-plugin/hooks/askquestion-payload.jq` (extract the filter so it's testable) + a shell assertion.

**Interfaces:**
- Produces: socket message gains optional `"payload"` = a compact JSON array
  `[{"prompt":str,"header":str,"options":[str],"multiSelect":bool}]`, ONLY for `PreToolUse` with `tool_name=="AskUserQuestion"`. `detail` stays `"AskUserQuestion"`.

- [ ] **Step 1: Write the failing test.** Create `claude-plugin/hooks/test-payload.sh`:

```bash
#!/usr/bin/env bash
set -eu
dir="$(cd "$(dirname "$0")" && pwd)"
fixture='{"tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Pick one","header":"H","options":[{"label":"A"},{"label":"B"}],"multiSelect":false},{"question":"Pick many","header":"M","options":[{"label":"X"},{"label":"Y"},{"label":"Z"}],"multiSelect":true}]}}'
out="$(printf '%s' "$fixture" | jq -cf "$dir/askquestion-payload.jq")"
expected='[{"prompt":"Pick one","header":"H","options":["A","B"],"multiSelect":false},{"prompt":"Pick many","header":"M","options":["X","Y","Z"],"multiSelect":true}]'
[ "$out" = "$expected" ] || { echo "FAIL:\n got: $out\n exp: $expected"; exit 1; }
echo PASS
```

- [ ] **Step 2: Run — expect FAIL** (`askquestion-payload.jq` missing):
`bash claude-plugin/hooks/test-payload.sh` → Expected: error, no such file.

- [ ] **Step 3: Implement the filter.** Create `claude-plugin/hooks/askquestion-payload.jq`:

```jq
[.tool_input.questions[]? | {prompt: .question, header: (.header // ""), options: [.options[].label], multiSelect: (.multiSelect // false)}]
```

- [ ] **Step 4: Wire it into `report.sh`.** After the existing `case "$event"` reason block, add payload extraction and include it in the printf. Replace the final emit block:

```bash
# Structured prompt payload — only AskUserQuestion carries one.
payload=""
if [ "$event" = "PreToolUse" ] && [ "$detail" = "AskUserQuestion" ] && [ -n "$payload_src" ] && command -v jq >/dev/null 2>&1; then
  payload="$(printf '%s' "$payload_src" | jq -cf "$(dirname "$0")/askquestion-payload.jq" 2>/dev/null)"
fi

esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
if [ -n "$payload" ]; then
  printf '{"tab_id":"%s","event":"%s","detail":"%s","payload":"%s"}\n' \
    "$(esc "$SHEPHERD_TAB_ID")" "$(esc "$event")" "$(esc "$detail")" "$(esc "$payload")"
else
  printf '{"tab_id":"%s","event":"%s","detail":"%s"}\n' \
    "$(esc "$SHEPHERD_TAB_ID")" "$(esc "$event")" "$(esc "$detail")"
fi | nc -U "$SHEPHERD_SOCK" 2>/dev/null || true
exit 0
```
Also capture the raw payload before the reason parse (rename the existing `payload="$(cat …)"` read to `payload_src="$(cat …)"` and update the reason-parse references from `$payload` to `$payload_src`). The `detail` for `PreToolUse` is already `tool_name`, so `[ "$detail" = "AskUserQuestion" ]` is the gate.

- [ ] **Step 5: Run — expect PASS.** `bash claude-plugin/hooks/test-payload.sh` → `PASS`. Sanity-check a non-AskUserQuestion event emits no `payload` (grep the fixture path mentally / add a second assertion for `tool_name":"Bash"` → empty payload → 3-field message).

- [ ] **Step 6: Commit.** `git add claude-plugin/hooks/ && git commit -m "feat(plugin): forward AskUserQuestion questions on the socket payload"`

---

### Task 2: Host — `ControlMessage.prompt` + socket payload plumb + broadcast on block

**Files:**
- Modify: `spike/seam1/Sources/RemoteProtocol.swift` (enum + a `PromptQuestion` struct)
- Modify: `spike/seam1/Sources/SocketServer.swift:12,16,74` (widen `onEvent` with `payload`)
- Modify: `spike/seam1/Sources/AgentStore.swift:95,359,394` (thread payload, broadcast `.prompt`)
- Test: `spike/seam1/Tests/RemoteProtocolTests.swift`

**Interfaces:**
- Produces:
  - `struct PromptQuestion: Codable, Equatable { let prompt: String; let header: String; let options: [String]; let multiSelect: Bool }`
  - `ControlMessage.prompt(paneID: String, kind: String, detail: String?, questions: [PromptQuestion]?)`
  - `SocketServer.onEvent: (String, String, String, String?) -> Void`  (4th arg = payload JSON string or nil)

- [ ] **Step 1: Write the failing test** in `RemoteProtocolTests.swift`:

```swift
func testPromptRoundTrips() throws {
    let q = [PromptQuestion(prompt: "Pick one", header: "H", options: ["A","B"], multiSelect: false)]
    let m = ControlMessage.prompt(paneID: "p1", kind: "askUserQuestion", detail: nil, questions: q)
    XCTAssertEqual(try FrameDecoder().feed(try FrameCodec.encode(m)), [m])
}
func testPromptPermissionOmitsQuestions() throws {
    let m = ControlMessage.prompt(paneID: "p1", kind: "permission", detail: "Bash", questions: nil)
    let json = String(data: try JSONEncoder().encode(m), encoding: .utf8)!
    XCTAssertFalse(json.contains("questions"))   // nil omitted
    XCTAssertTrue(json.contains("\"kind\":\"permission\""))
}
```

- [ ] **Step 2: Run — expect FAIL** (`build test -scheme ShepherdModelTests`): missing symbols.

- [ ] **Step 3: Implement.** In `RemoteProtocol.swift` add the struct (near `PaneInfo`) and the case (after `.paneRenamed`):

```swift
struct PromptQuestion: Codable, Equatable {
    let prompt: String; let header: String; let options: [String]; let multiSelect: Bool
}
// in enum ControlMessage:
case prompt(paneID: String, kind: String, detail: String?, questions: [PromptQuestion]?)
```

- [ ] **Step 4: Plumb the socket payload.** `SocketServer.swift`: change the property + init + call:

```swift
private let onEvent: (String, String, String, String?) -> Void
init(path: String, onEvent: @escaping (String, String, String, String?) -> Void) { … }
// in acceptLoop, after `let detail = …`:
let payload = obj["payload"] as? String
DispatchQueue.main.async { [weak self] in self?.onEvent(tab, event, detail, payload) }
```

- [ ] **Step 5: Broadcast on block.** `AgentStore.swift`: update the `SocketServer(...)` closure (line ~95) to `{ [weak self] paneID, event, detail, payload in self?.apply(event: event, detail: detail, paneID: paneID, payload: payload) }`; change `func apply(event:detail:paneID:)` to also take `payload: String?`. After the existing `.state` broadcast (line ~394), add:

```swift
if res.state == .blocked {
    let kind: String? = {
        switch detail {
        case "AskUserQuestion": return "askUserQuestion"
        case "ExitPlanMode":    return "plan"
        default: return event == "PermissionRequest" ? "permission" : nil
        }
    }()
    if let kind {
        let questions: [PromptQuestion]? = (kind == "askUserQuestion")
            ? payload.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode([PromptQuestion].self, from: $0) }
            : nil
        remoteServer?.broadcast(.prompt(paneID: paneID, kind: kind,
            detail: kind == "permission" ? detail : nil, questions: questions))
    }
}
```
(`detail` for permission is the tool name via `PermissionRequest`'s `tool_name`.)

- [ ] **Step 6: Run — expect PASS.** `xcodebuild … build test` — ModelTests green (incl. the 2 new); Remote/Helper unchanged.

- [ ] **Step 7: Commit.** `feat(remote): ControlMessage.prompt + socket payload plumb + block-time broadcast`

---

### Task 3: Android — `ControlMessage.Prompt` codec (byte-pinned)

**Files:**
- Modify: `android/.../protocol/ControlMessage.kt`, `android/.../protocol/WireCodec.kt`
- Test: `android/.../protocol/WireCodecTest.kt`

**Interfaces:**
- Consumes: host `.prompt` wire shape (Task 2).
- Produces:
  - `data class PromptQuestion(val prompt: String, val header: String, val options: List<String>, val multiSelect: Boolean)`
  - `data class Prompt(val paneId: String, val kind: String, val detail: String?, val questions: List<PromptQuestion>?) : ControlMessage`

- [ ] **Step 1: Write the failing test** in `WireCodecTest.kt`:

```kotlin
@Test fun decodesPrompt() {
    val m = decodeOne("""{"prompt":{"paneID":"p1","kind":"askUserQuestion","questions":[{"prompt":"Pick one","header":"H","options":["A","B"],"multiSelect":false}]}}""") as ControlMessage.Prompt
    assertEquals("p1", m.paneId); assertEquals("askUserQuestion", m.kind); assertNull(m.detail)
    assertEquals(1, m.questions!!.size)
    assertEquals(PromptQuestion("Pick one","H",listOf("A","B"),false), m.questions!![0])
}
@Test fun decodesPermissionPromptNoQuestions() {
    val m = decodeOne("""{"prompt":{"paneID":"p1","kind":"permission","detail":"Bash"}}""") as ControlMessage.Prompt
    assertEquals("permission", m.kind); assertEquals("Bash", m.detail); assertNull(m.questions)
}
```

- [ ] **Step 2: Run — expect FAIL:** `./gradlew :app:testDebugUnitTest --tests '*WireCodecTest'`.

- [ ] **Step 3: Implement.** `ControlMessage.kt`: add the two types. `WireCodec.kt`: add to `parse` (before `else`):

```kotlin
"prompt" -> ControlMessage.Prompt(
    b.getValue("paneID").jsonPrimitive.content,
    b.getValue("kind").jsonPrimitive.content,
    b["detail"]?.jsonPrimitive?.contentOrNull,
    b["questions"]?.jsonArray?.map { q -> val o = q.jsonObject
        PromptQuestion(o.getValue("prompt").jsonPrimitive.content, o.getValue("header").jsonPrimitive.content,
            o.getValue("options").jsonArray.map { it.jsonPrimitive.content }, o.getValue("multiSelect").jsonPrimitive.boolean) })
```
(The phone only ever RECEIVES `prompt`, so no encoder arm is required — but if `bodyJson` has an exhaustive `when`, add a `putJsonObject("prompt")` arm mirroring the shape to satisfy the compiler.)

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `feat(android): ControlMessage.Prompt codec byte-pinned to host`

---

### Task 4: Android — `PromptKeystrokes` synthesis (AskUserQuestion)

**Files:**
- Create: `android/.../terminal/PromptKeystrokes.kt`
- Test: `android/.../terminal/PromptKeystrokesTest.kt`

**Interfaces:**
- Consumes: `PromptQuestion` (Task 3).
- Produces: `object PromptKeystrokes { fun askUserQuestion(questions: List<PromptQuestion>, selections: List<List<Int>>): ByteArray }` — `selections[i]` = chosen option indices for question i (single-select = one index).

- [ ] **Step 1: Write the failing test** `PromptKeystrokesTest.kt`:

```kotlin
class PromptKeystrokesTest {
    private val UP = byteArrayOf(0x1b,'['.code.toByte(),'A'.code.toByte())
    private val DOWN = byteArrayOf(0x1b,'['.code.toByte(),'B'.code.toByte())
    private val ENTER = byteArrayOf(0x0d); private val SPACE = byteArrayOf(0x20)
    private fun q(n: Int, multi: Boolean) = PromptQuestion("q","h",(0 until n).map { "o$it" }, multi)

    @Test fun singleSelectSecondOption() {
        // cursor starts at option 0 (highlighted by default): Down×1, Enter
        val exp = DOWN + ENTER
        assertArrayEquals(exp, PromptKeystrokes.askUserQuestion(listOf(q(2,false)), listOf(listOf(1))))
    }
    @Test fun multiSelectTwoOfThree() {
        // from idx0: toggle idx0 (Space); Down to idx2 (Down×2) Space; Enter
        val exp = SPACE + DOWN+DOWN + SPACE + ENTER
        assertArrayEquals(exp, PromptKeystrokes.askUserQuestion(listOf(q(3,true)), listOf(listOf(0,2))))
    }
    @Test fun mixedTwoQuestionsChainWithEnterBetween() {
        // Q1 single idx0 → just Enter (already on option 0); Q2 multi idx0 → Space, Enter
        val exp = ENTER + (SPACE + ENTER)
        assertArrayEquals(exp, PromptKeystrokes.askUserQuestion(listOf(q(2,false), q(3,true)), listOf(listOf(0), listOf(0))))
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `PromptKeystrokes.kt`:

```kotlin
package com.eshaan.shepherd.terminal
import com.eshaan.shepherd.protocol.PromptQuestion

object PromptKeystrokes {
    private val ESC = 0x1b.toByte()
    private val DOWN = byteArrayOf(ESC, '['.code.toByte(), 'B'.code.toByte())
    private val ENTER = byteArrayOf(0x0d)
    private val SPACE = byteArrayOf(0x20)

    // Each question loads with option 0 highlighted, so the cursor starts at index 0 — no reset.
    fun askUserQuestion(questions: List<PromptQuestion>, selections: List<List<Int>>): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        questions.forEachIndexed { qi, q ->
            val chosen = (selections.getOrNull(qi) ?: emptyList()).sorted()
            var cursor = 0
            if (q.multiSelect) {
                for (idx in chosen) { repeat(idx - cursor) { out.write(DOWN) }; cursor = idx; out.write(SPACE) }
                out.write(ENTER)
            } else {
                repeat(chosen.firstOrNull() ?: 0) { out.write(DOWN) }   // Down from index 0
                out.write(ENTER)
            }
        }
        return out.toByteArray()
    }
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `feat(android): PromptKeystrokes — AskUserQuestion answer synthesis`

---

### Task 5: Android — `AgentViewModel` observes the prompt; clears on unblock

**Files:**
- Modify: `android/.../ui/AgentViewModel.kt`
- Test: `android/.../ui/AgentViewModelTest.kt`

**Interfaces:**
- Consumes: `controlConn.inbound` (a `SharedFlow<ControlMessage>`), `ControlMessage.Prompt`/`StateMsg`.
- Produces: `val prompt: StateFlow<ControlMessage.Prompt?>` on `AgentViewModel` — set when a `Prompt` for THIS `paneId` arrives; cleared when a `StateMsg` for this pane has `state != "blocked"`.

- [ ] **Step 1: Write the failing test** in `AgentViewModelTest.kt` (mirror the existing control+data loopback setup): feed an inbound `Prompt(paneId=this,kind=askUserQuestion,questions=[…])` → assert `vm.prompt.value` set; feed `StateMsg(this,"working",null)` → assert `vm.prompt.value == null`.

- [ ] **Step 2: Run — expect FAIL** (no `prompt` member).

- [ ] **Step 3: Implement.** Add to `AgentViewModel`:

```kotlin
private val _prompt = MutableStateFlow<ControlMessage.Prompt?>(null)
val prompt: StateFlow<ControlMessage.Prompt?> = _prompt
// in attach() (or an init collector on the same scope):
scope.launch {
    controlConn.inbound.collect { m ->
        when (m) {
            is ControlMessage.Prompt -> if (m.paneId == paneId) _prompt.value = m
            is ControlMessage.StateMsg -> if (m.paneId == paneId && m.state != "blocked") _prompt.value = null
            else -> {}
        }
    }
}
```
(Use the VM's existing coroutine scope; cancel with the rest on `detach()`.)

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `feat(android): AgentViewModel tracks the pane's active prompt`

---

### Task 6: Android — `PromptPanel` UI, replaces the terminal when a prompt is active

**Files:**
- Create: `android/.../ui/PromptPanel.kt`
- Modify: `android/.../ui/AgentScreen.kt`
- Test: pure selection-state helper in `PromptPanel.kt` unit-tested; render is on-device (Task 7).

**Interfaces:**
- Consumes: `ControlMessage.Prompt`, `PromptKeystrokes.askUserQuestion`, `RemoteTerminalSession.sendInput`.
- Produces: `@Composable fun PromptPanel(prompt: ControlMessage.Prompt, onAnswer: (ByteArray) -> Unit, onUseTerminal: () -> Unit)`.

- [ ] **Step 1: Write the failing test** for the selection→bytes glue (a pure helper so it's testable):

```kotlin
// in PromptPanelTest.kt
@Test fun buildsBytesFromSelectionState() {
    val qs = listOf(PromptQuestion("q","h",listOf("A","B"),false))
    assertArrayEquals(PromptKeystrokes.askUserQuestion(qs, listOf(listOf(1))),
        answerBytes(qs, mapOf(0 to setOf(1))))   // answerBytes: pure top-level fn in PromptPanel.kt
}
```

- [ ] **Step 2: Run — expect FAIL** (`answerBytes` missing).

- [ ] **Step 3: Implement.** In `PromptPanel.kt` add the pure helper + the composable:

```kotlin
fun answerBytes(questions: List<PromptQuestion>, selections: Map<Int, Set<Int>>): ByteArray =
    PromptKeystrokes.askUserQuestion(questions, questions.indices.map { (selections[it] ?: emptySet()).toList() })
```
Then the composable: for `kind=="askUserQuestion"`, one section per question — single-select renders option buttons that **immediately** call `onAnswer(answerBytes(...))` when it's the sole question, else toggle a radio in `selections`; multi-select renders checkboxes into `selections`; a **Submit** appears when the form isn't a lone single-select. For `kind=="permission"` render `detail`-labelled **Approve/Deny**; for `kind=="plan"` render **Approve/Keep planning** (their `onAnswer` bytes are wired in Task 7). Always show a small **"Use terminal"** text button calling `onUseTerminal()`.

- [ ] **Step 4: Wire into `AgentScreen`.** Collect `vm.prompt`; when non-null, render `PromptPanel(prompt, onAnswer = { session?.sendInput(it) }, onUseTerminal = { /* local override flag → show terminal */ })` **instead of** the `TerminalView`; when null, the terminal as today. A `remember { mutableStateOf(false) }` "force terminal" flag lets `onUseTerminal` drop to the terminal without waiting for unblock.

- [ ] **Step 5: Run — expect PASS** (the `answerBytes` test; UI compiles).
- [ ] **Step 6: Commit.** `feat(android): PromptPanel — tappable answers replacing the terminal while blocked`

---

### Task 7: On-device — pin permission/plan keys, verify all four end-to-end

**Files:**
- Modify: `android/.../terminal/PromptKeystrokes.kt` (add `permission(...)` / `plan(...)`), `PromptPanel.kt` (wire their `onAnswer`).
- Verification: adb device `45acdfe7`; host Shepherd running the current build.

This task is **observe-then-implement** — the permission/plan menus' key bindings are read off a live pane (Shepherd tees the PTY), not guessed.

- [ ] **Step 1: Observe.** In a Shepherd pane, trigger (a) a Bash permission prompt and (b) `ExitPlanMode`; from the phone's terminal note which keys select Approve vs Deny / Keep-planning (arrow+enter vs a number/letter). Record the exact byte sequences.
- [ ] **Step 2: Implement** `PromptKeystrokes.permission(approve: Boolean)` and `.plan(approve: Boolean)` returning those sequences; add golden-byte unit tests with the observed values; run them (`:app:testDebugUnitTest`).
- [ ] **Step 3: Wire** the permission/plan buttons' `onAnswer` in `PromptPanel` to these.
- [ ] **Step 4: Device verify** (`installDebug`, relaunch): answer via buttons — a single-select, a multi-select, a mixed multi-question `AskUserQuestion`, a Bash permission, a plan approval; confirm each advances the agent and the terminal returns. Confirm garbled/unknown → terminal fallback.
- [ ] **Step 5: Commit.** `feat(android): permission/plan answer synthesis + on-device verification`

---

## Self-Review

**Spec coverage:** §4[1] hook payload → Task 1. §4[2] transport → Tasks 2 (Swift) + 3 (Kotlin). §4[3] synthesis → Task 4 (AskUserQuestion) + Task 7 (permission/plan). §4[4] PromptPanel replacing terminal → Task 6. §4[5] detection reuse → Task 2 Step 5. §5 fallback → Task 2 (nil-safe decode), Task 6 (no-prompt→terminal, "Use terminal"), Task 7 Step 4. §6 testing → per-task tests + Task 7 device pass. All four prompt kinds covered (AskUserQuestion Tasks 1–6; permission/plan Task 7).

**Placeholder scan:** none — AskUserQuestion path is fully coded; permission/plan keys are deliberately an observe-then-implement task (their exact bytes are unknowable without the live menu), not a "TODO" in shipped code.

**Type consistency:** `PromptQuestion{prompt,header,options,multiSelect}` identical Swift↔Kotlin (Tasks 2/3). `ControlMessage.prompt(paneID,kind,detail,questions)` ↔ Kotlin `Prompt(paneId,kind,detail,questions)` with JSON key `paneID`. `PromptKeystrokes.askUserQuestion(questions, selections: List<List<Int>>)` consistent Tasks 4/6. `AgentViewModel.prompt: StateFlow<ControlMessage.Prompt?>` consistent Tasks 5/6. Byte vocab (Up/Down/Enter/Space) identical across Tasks 4/7 and the tests.
