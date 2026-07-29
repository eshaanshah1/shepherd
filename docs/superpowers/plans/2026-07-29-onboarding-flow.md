# Onboarding Flow Implementation Plan

> **Executed 2026-07-29 on `onboarding-flow`.** All eight tasks are complete and
> committed; 720 model tests pass, 0 failures. The tour shipped at **18 steps**, not the
> 11 planned here, and several names in Tasks 5–7 were wrong in this document — see
> §7.7 "Deviations from this spec, as built" in the design doc for the full list. Read
> that section before treating any code block below as current.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first-run flow that installs the Claude Code plugin, builds a real local git sandbox, and runs a linear coach-mark tour which performs each feature it describes, then deletes the sandbox.

**Architecture:** Three pure models (`OnboardingPolicy` — the step script as data; `OnboardingPlacement` — card geometry; `OnboardingDemoRepo` — the sandbox manifest + a git shell) under a `@MainActor` `OnboardingController` that interprets each step's action against `AgentStore`, and a SwiftUI overlay that draws the dimmed backdrop, spotlight, card and arrow. Anchors are published by real views through a `PreferenceKey`, the same mechanism `SidebarView` already uses for `FolderCentersKey`.

**Tech Stack:** Swift 5, SwiftUI + AppKit, XCTest, xcodegen, real `git` via `Process`.

**Spec:** [`docs/superpowers/specs/2026-07-29-onboarding-flow-design.md`](../specs/2026-07-29-onboarding-flow-design.md)

## Global Constraints

Every task's requirements implicitly include all of these.

- **Never `killall` or relaunch Shepherd.** The user runs it as their daily terminal while this work happens. Verify with **compile + unit tests only** and defer all runtime checks to the user. Do not `open` the app, do not screenshot it.
- **Run `xcodegen generate` after adding or removing any file**, or the new file is not compiled and you get `cannot find X in scope` at build time.
- **New pure sources must be added to the `ShepherdModelTests` target's explicit `sources:` list** in `spike/seam1/project.yml`. `Tests/` itself is a glob and picks up new test files automatically; `Sources/` for the test target is not.
- **A test pass counts only when the test count moves.** `-only-testing:` on a suite the project does not know about matches nothing and reports `** TEST SUCCEEDED **`. Always confirm with `grep -c "Test Case .* passed"`.
- **SourceKit lies in this repo.** Ignore editor "cannot find type" noise; `xcodebuild` is ground truth.
- **The onboarding overlay must NOT be added to `isFrontPane`'s full-takeover-overlay check** (`AgentStore.swift:1031`). This is load-bearing — see spec §7.2.
- **`injectText` is single-line only.** A typed newline is an Enter press. Every prompt this feature types is one line by design.
- **Comment style:** never narrate the change or recap bug history. One short line is the ceiling for a genuinely non-obvious why; otherwise no comment.
- **Every commit message ends with:** `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

**Build:**
```bash
cd spike/seam1
xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
```

**Test** (substitute the suite name):
```bash
cd spike/seam1
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  test -only-testing:ShepherdModelTests/OnboardingPolicyTests 2>&1 | tee /tmp/ob-test.log
grep -c "Test Case .* passed" /tmp/ob-test.log
```

## File Structure

| File | Responsibility |
|---|---|
| `Sources/OnboardingPolicy.swift` | **pure.** The step script as data; types; `steps(for:)` filtering + substitute cards |
| `Sources/OnboardingPlacement.swift` | **pure.** Card origin + arrow edge from an anchor rect; keeps the card on screen |
| `Sources/OnboardingDemoRepo.swift` | **pure** manifest + a `Process` git shell. Build and tear down the sandbox |
| `Sources/OnboardingAnchorKey.swift` | The `PreferenceKey` and the `.onboardingAnchor(_:)` modifier |
| `Sources/OnboardingOverlayView.swift` | Backdrop, spotlight cutout, card, drawn arrow, Skip/Next, Esc |
| `Sources/OnboardingWelcomeView.swift` | The welcome card's three rows: plugin, notifications, theme |
| `Sources/OnboardingController.swift` | `@MainActor` state machine; preflight; action execution; teardown |
| `Tests/OnboardingPolicyTests.swift` | Step filtering, substitutes, ids, anchors, bounds |
| `Tests/OnboardingPlacementTests.swift` | Card stays in container; arrow faces the anchor |
| `Tests/OnboardingDemoRepoTests.swift` | Real git: sandbox shape, then teardown leaves nothing |

Modified: `ContentView.swift`, `SidebarView.swift`, `SplitContainer.swift`, `UpdatePillView.swift`, `Workbench/WorkbenchView.swift`, `ShepherdApp.swift`, `AppDelegate.swift`, `AgentStore.swift`, `project.yml`.

---

### Task 1: `OnboardingPolicy` — the step script as data

**Files:**
- Create: `spike/seam1/Sources/OnboardingPolicy.swift`
- Test: `spike/seam1/Tests/OnboardingPolicyTests.swift`
- Modify: `spike/seam1/project.yml` (add `Sources/OnboardingPolicy.swift` to `ShepherdModelTests` → `sources:`, after the `Sources/ShortcutCatalog.swift` line at ~179)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `struct OnboardingRequirement: OptionSet` with `.sandbox`, `.liveAgent`
  - `enum OnboardingAnchor: Hashable` — `.centered`, `.terminalArea`, `.folderHeader`, `.tabRow(Int)`, `.stateDot(Int)`, `.workbenchRail`, `.sidebarFooter`
  - `enum OnboardingAction: Equatable` — `.none`, `.buildSandbox`, `.createDemoWorkspace`, `.splitDemoTab`, `.startClaude`, `.promptWatched`, `.promptUnwatched`, `.openWorkbench`, `.addWorktreeTab`, `.teardown`
  - `struct Preflight` — `claudePath: String?`, `pluginInstalled: Bool`, `gitAvailable: Bool`, `sandboxBuilt: Bool`; `var available: OnboardingRequirement`
  - `struct OnboardingStep: Identifiable, Equatable` — `id: String`, `title: String`, `body: String`, `anchor: OnboardingAnchor`, `action: OnboardingAction`, `requires: OnboardingRequirement`
  - `enum OnboardingPolicy` — `static let script: [OnboardingStep]`, `static func steps(for: Preflight) -> [OnboardingStep]`

> **Deviation from spec §3.1, deliberate:** the spec sketched `enum OnboardingRequirement { case always, liveAgent }`, but §6 requires filtering on a *second, independent* axis (sandbox build failed). An `OptionSet` expresses both without a combinatorial enum. Note this in the commit body.

- [ ] **Step 1: Write the failing tests**

Create `spike/seam1/Tests/OnboardingPolicyTests.swift`:

```swift
import XCTest
@testable import Shepherd

final class OnboardingPolicyTests: XCTestCase {

    private func preflight(claude: Bool, plugin: Bool, sandbox: Bool) -> Preflight {
        Preflight(claudePath: claude ? "/opt/homebrew/bin/claude" : nil,
                  pluginInstalled: plugin,
                  gitAvailable: true,
                  sandboxBuilt: sandbox)
    }

    func testFullPreflightYieldsTheWholeScriptAndNoSubstitutes() {
        let steps = OnboardingPolicy.steps(for: preflight(claude: true, plugin: true, sandbox: true))
        XCTAssertEqual(steps.map(\.id), OnboardingPolicy.script.map(\.id))
        XCTAssertFalse(steps.contains { $0.id == "agentLegend" })
        XCTAssertFalse(steps.contains { $0.id == "noSandbox" })
    }

    // Missing claude, missing plugin, or both — same outcome: the three live-agent
    // steps go, one legend card replaces them.
    func testLiveAgentStepsCollapseToOneLegendCard() {
        for (c, p) in [(false, true), (true, false), (false, false)] {
            let steps = OnboardingPolicy.steps(for: preflight(claude: c, plugin: p, sandbox: true))
            let ids = steps.map(\.id)
            XCTAssertFalse(ids.contains("agentStart"), "claude=\(c) plugin=\(p)")
            XCTAssertFalse(ids.contains("agentWatched"), "claude=\(c) plugin=\(p)")
            XCTAssertFalse(ids.contains("agentUnwatched"), "claude=\(c) plugin=\(p)")
            XCTAssertEqual(ids.filter { $0 == "agentLegend" }.count, 1, "claude=\(c) plugin=\(p)")
        }
    }

    func testLegendCardSitsWhereTheAgentStepsWere() {
        let steps = OnboardingPolicy.steps(for: preflight(claude: false, plugin: false, sandbox: true))
        let ids = steps.map(\.id)
        XCTAssertEqual(ids.firstIndex(of: "agentLegend")! - 1, ids.firstIndex(of: "split")!)
    }

    func testFailedSandboxDropsEveryRepoStepAndAddsOneCard() {
        let steps = OnboardingPolicy.steps(for: preflight(claude: true, plugin: true, sandbox: false))
        let ids = steps.map(\.id)
        for dropped in ["terminal", "sidebar", "split", "workbench", "worktree",
                        "agentStart", "agentWatched", "agentUnwatched"] {
            XCTAssertFalse(ids.contains(dropped), "\(dropped) survived a failed sandbox")
        }
        XCTAssertEqual(ids.filter { $0 == "noSandbox" }.count, 1)
        XCTAssertEqual(ids.first, "welcome")
        XCTAssertEqual(ids.last, "done")
    }

    // A failed sandbox already removed the agent steps; a second substitute card
    // explaining the same absence would be noise.
    func testFailedSandboxDoesNotAlsoAddTheLegendCard() {
        let steps = OnboardingPolicy.steps(for: preflight(claude: false, plugin: false, sandbox: false))
        XCTAssertFalse(steps.contains { $0.id == "agentLegend" })
    }

    func testWelcomeAndDoneSurviveEveryPreflight() {
        for c in [true, false] {
            for p in [true, false] {
                for s in [true, false] {
                    let ids = OnboardingPolicy.steps(for: preflight(claude: c, plugin: p, sandbox: s)).map(\.id)
                    XCTAssertEqual(ids.first, "welcome", "c=\(c) p=\(p) s=\(s)")
                    XCTAssertEqual(ids.last, "done", "c=\(c) p=\(p) s=\(s)")
                }
            }
        }
    }

    func testTeardownIsTheLastStepsActionInEveryPreflight() {
        for s in [true, false] {
            let steps = OnboardingPolicy.steps(for: preflight(claude: true, plugin: true, sandbox: s))
            XCTAssertEqual(steps.last?.action, .teardown)
        }
    }

    func testScriptIDsAreUnique() {
        let ids = OnboardingPolicy.script.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count, "duplicate step ids in the script")
    }

    func testEveryStepHasCopy() {
        for s in OnboardingPolicy.script + [OnboardingPolicy.agentLegendCard, OnboardingPolicy.noSandboxCard] {
            XCTAssertFalse(s.title.isEmpty, "\(s.id) has no title")
            XCTAssertFalse(s.body.isEmpty, "\(s.id) has no body")
        }
    }

    // Pane/tab indices the tour anchors to must exist by the time their step runs:
    // the split step creates pane 1, the worktree step creates tab 1.
    func testAnchorIndicesNeverExceedOne() {
        for s in OnboardingPolicy.script {
            switch s.anchor {
            case .stateDot(let i): XCTAssertLessThanOrEqual(i, 1, "\(s.id) anchors past pane 1")
            case .tabRow(let i):   XCTAssertLessThanOrEqual(i, 1, "\(s.id) anchors past tab 1")
            default: break
            }
        }
    }

    func testLiveAgentStepsAlsoRequireTheSandbox() {
        for s in OnboardingPolicy.script where s.requires.contains(.liveAgent) {
            XCTAssertTrue(s.requires.contains(.sandbox), "\(s.id) runs claude without a repo")
        }
    }
}
```

- [ ] **Step 2: Run the tests and confirm they fail to compile**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  test -only-testing:ShepherdModelTests/OnboardingPolicyTests 2>&1 | tail -30
```
Expected: **BUILD FAILED**, `cannot find 'OnboardingPolicy' in scope`. A `** TEST SUCCEEDED **` here means the suite was not registered — re-run `xcodegen generate`.

- [ ] **Step 3: Write `OnboardingPolicy.swift`**

```swift
import Foundation

/// What a step needs in order to be worth showing. Two independent axes: whether the
/// scratch repo exists, and whether a real Claude session can be started in it.
struct OnboardingRequirement: OptionSet, Equatable {
    let rawValue: Int
    static let sandbox   = OnboardingRequirement(rawValue: 1 << 0)
    static let liveAgent = OnboardingRequirement(rawValue: 1 << 1)
}

/// A real UI element a card can point an arrow at. `.centered` means no arrow.
/// Indices are into the demo workspace only.
enum OnboardingAnchor: Hashable {
    case centered
    case terminalArea
    case folderHeader
    case tabRow(Int)
    case stateDot(Int)
    case workbenchRail
    case sidebarFooter
}

/// The side effect a step performs when it becomes current.
enum OnboardingAction: Equatable {
    case none
    case buildSandbox
    case createDemoWorkspace
    case splitDemoTab
    case startClaude
    case promptWatched
    case promptUnwatched
    case openWorkbench
    case addWorktreeTab
    case teardown
}

struct Preflight: Equatable {
    var claudePath: String?
    var pluginInstalled: Bool
    var gitAvailable: Bool
    var sandboxBuilt: Bool

    var liveAgentPossible: Bool { claudePath != nil && pluginInstalled }

    var available: OnboardingRequirement {
        var r: OnboardingRequirement = []
        if gitAvailable && sandboxBuilt { r.insert(.sandbox) }
        if liveAgentPossible { r.insert(.liveAgent) }
        return r
    }
}

struct OnboardingStep: Identifiable, Equatable {
    let id: String
    let title: String
    let body: String
    let anchor: OnboardingAnchor
    let action: OnboardingAction
    let requires: OnboardingRequirement
}

enum OnboardingPolicy {

    static let script: [OnboardingStep] = [
        OnboardingStep(
            id: "welcome",
            title: "Welcome to Shepherd",
            body: "Shepherd is a terminal that treats Claude Code sessions as tracked agents. "
                + "Two things to set up, then a short tour in a throwaway sandbox.",
            anchor: .centered, action: .buildSandbox, requires: []),

        OnboardingStep(
            id: "terminal",
            title: "It's a terminal first",
            body: "A real shell on a real grid — mouse, scroll, selection and copy/paste all "
                + "behave the way you expect. Nothing here is a simulation.",
            anchor: .terminalArea, action: .createDemoWorkspace, requires: [.sandbox]),

        OnboardingStep(
            id: "sidebar",
            title: "The sidebar is your agent list",
            body: "Tabs take their name from their directory and group into workspace folders. "
                + "⌃⇥ cycles workspaces; ⌘⇧[ and ⌘⇧] move between tabs.",
            anchor: .folderHeader, action: .none, requires: [.sandbox]),

        OnboardingStep(
            id: "split",
            title: "⌘D splits a tab — each pane is its own agent",
            body: "⌘⇧D stacks instead of side-by-side, ⌘⇧↩ zooms the focused pane, and "
                + "⌘⌥ plus an arrow key moves focus. Every pane is tracked separately.",
            anchor: .stateDot(1), action: .splitDemoTab, requires: [.sandbox]),

        OnboardingStep(
            id: "agentStart",
            title: "Start an agent",
            body: "That dot appeared because Claude Code fired a lifecycle hook into Shepherd. "
                + "Panes are matched by an env var injected into the shell, never by guessing "
                + "at process trees.",
            anchor: .stateDot(0), action: .startClaude, requires: [.sandbox, .liveAgent]),

        OnboardingStep(
            id: "agentWatched",
            title: "Watch a turn",
            body: "Amber means working. When it finishes you'll see it settle to plain idle "
                + "rather than done — because you were looking straight at it, so there is "
                + "nothing left to tell you.",
            anchor: .stateDot(0), action: .promptWatched, requires: [.sandbox, .liveAgent]),

        OnboardingStep(
            id: "agentUnwatched",
            title: "And when you're not looking",
            body: "Same agent, same prompt, but focus moved away — so this one lands as done, "
                + "with a dock badge and a notification. ⌘⇧A jumps to whoever needs you next, "
                + "across every workspace.",
            anchor: .stateDot(0), action: .promptUnwatched, requires: [.sandbox, .liveAgent]),

        OnboardingStep(
            id: "workbench",
            title: "⌘G opens the workbench",
            body: "Review what an agent changed without leaving the app. ⌃1–⌃4 switch between "
                + "the working tree, a diff against the base branch, files, and this branch's "
                + "commits. ⌘⏎ stages your selection, and the buffer is editable — ⌘S writes.",
            anchor: .workbenchRail, action: .openWorkbench, requires: [.sandbox]),

        OnboardingStep(
            id: "worktree",
            title: "One branch, one directory, one agent",
            body: "Shepherd just ran git worktree add and opened the result. Closing a worktree "
                + "tab offers to archive your uncommitted work instead of losing it; archives "
                + "expire after 90 days.",
            anchor: .tabRow(1), action: .addWorktreeTab, requires: [.sandbox]),

        OnboardingStep(
            id: "rest",
            title: "The rest",
            body: "⌘, opens Settings — theme, font, worktree hooks, remote devices. Updates "
                + "arrive as a pill down here. With the gh CLI installed, idle agents show "
                + "their pull request's status. ⌘/ lists every shortcut.",
            anchor: .sidebarFooter, action: .none, requires: []),

        OnboardingStep(
            id: "done",
            title: "That's it",
            body: "Removing the sandbox now — its workspace, tabs, worktree and scratch repo all "
                + "go. Open a directory of your own and start an agent. Help → Shepherd Tour "
                + "replays this any time.",
            anchor: .centered, action: .teardown, requires: []),
    ]

    /// Shown in place of the three live-agent steps when Claude Code or the plugin is absent.
    static let agentLegendCard = OnboardingStep(
        id: "agentLegend",
        title: "Agent states need Claude Code",
        body: "The live demo needs both the claude CLI on your PATH and Shepherd's plugin "
              + "installed, so it's skipped. For reference, a pane's dot reads: grey shell, "
              + "amber working, red blocked and waiting on you, green done, plain idle.",
        anchor: .folderHeader, action: .none, requires: [.sandbox])

    /// Shown when the scratch repo could not be created — everything needing a repo is gone.
    static let noSandboxCard = OnboardingStep(
        id: "noSandbox",
        title: "No sandbox this time",
        body: "Shepherd couldn't create its scratch git repository, so the hands-on steps are "
              + "skipped. Everything below still applies to a directory of your own.",
        anchor: .centered, action: .none, requires: [])

    static func steps(for p: Preflight) -> [OnboardingStep] {
        let avail = p.available
        var out = script.filter { $0.requires.isSubset(of: avail) }

        // A missing sandbox already removed the agent steps; only one card should
        // explain the absence.
        if !avail.contains(.sandbox) {
            out.insert(noSandboxCard, at: 1)
        } else if !avail.contains(.liveAgent) {
            let after = out.firstIndex { $0.id == "split" }.map { $0 + 1 } ?? out.count - 1
            out.insert(agentLegendCard, at: after)
        }
        return out
    }
}
```

- [ ] **Step 4: Add the source to the test target and regenerate**

In `spike/seam1/project.yml`, inside `ShepherdModelTests:` → `sources:`, immediately after the `- path: Sources/ShortcutCatalog.swift` line, add:

```yaml
      - path: Sources/OnboardingPolicy.swift
```

Then:
```bash
cd spike/seam1 && xcodegen generate
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
cd spike/seam1
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  test -only-testing:ShepherdModelTests/OnboardingPolicyTests 2>&1 | tee /tmp/ob-test.log | tail -20
grep -c "Test Case .* passed" /tmp/ob-test.log
```
Expected: `** TEST SUCCEEDED **` and a count of **11**. A count of 0 means the suite is unregistered, not that it passed.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/OnboardingPolicy.swift \
        spike/seam1/Tests/OnboardingPolicyTests.swift \
        spike/seam1/project.yml
git commit -F - <<'EOF'
feat(onboarding): the tour script as filtered data

Requirements are an OptionSet rather than the spec's enum: a missing repo and
a missing Claude Code install are independent axes, and both need to filter.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: `OnboardingPlacement` — card geometry

**Files:**
- Create: `spike/seam1/Sources/OnboardingPlacement.swift`
- Test: `spike/seam1/Tests/OnboardingPlacementTests.swift`
- Modify: `spike/seam1/project.yml` (add to `ShepherdModelTests` → `sources:`)

**Interfaces:**
- Consumes: nothing from Task 1 (deliberately independent — it takes a `CGRect?`, not an `OnboardingAnchor`, so it never needs to know what the anchors mean).
- Produces:
  - `enum ArrowEdge { case leading, trailing, top, bottom }` — the card edge the arrow leaves from
  - `struct CardPlacement: Equatable` — `origin: CGPoint`, `arrowFrom: ArrowEdge?`
  - `enum OnboardingPlacement` — `static func place(anchor: CGRect?, card: CGSize, container: CGSize, gap: CGFloat = 18, margin: CGFloat = 16) -> CardPlacement`

Coordinate space is SwiftUI's: origin top-left, y grows downward.

- [ ] **Step 1: Write the failing tests**

Create `spike/seam1/Tests/OnboardingPlacementTests.swift`:

```swift
import XCTest
@testable import Shepherd

final class OnboardingPlacementTests: XCTestCase {

    private let container = CGSize(width: 1400, height: 900)
    private let card = CGSize(width: 340, height: 200)

    private func rect(_ x: CGFloat, _ y: CGFloat) -> CGRect {
        CGRect(x: x, y: y, width: 12, height: 12)
    }

    func testCenteredWhenThereIsNoAnchor() {
        let p = OnboardingPlacement.place(anchor: nil, card: card, container: container)
        XCTAssertNil(p.arrowFrom)
        XCTAssertEqual(p.origin.x, (1400 - 340) / 2, accuracy: 0.5)
        XCTAssertEqual(p.origin.y, (900 - 200) / 2, accuracy: 0.5)
    }

    // The real failure mode: an anchor near an edge pushing the card off screen.
    func testCardStaysFullyInsideForAnchorsAllOverTheContainer() {
        let xs: [CGFloat] = [0, 8, 200, 700, 1200, 1392, 1400]
        let ys: [CGFloat] = [0, 8, 200, 450, 700, 892, 900]
        for x in xs {
            for y in ys {
                let p = OnboardingPlacement.place(anchor: rect(x, y), card: card, container: container)
                XCTAssertGreaterThanOrEqual(p.origin.x, 0, "anchor \(x),\(y) pushed the card off the left")
                XCTAssertGreaterThanOrEqual(p.origin.y, 0, "anchor \(x),\(y) pushed the card off the top")
                XCTAssertLessThanOrEqual(p.origin.x + card.width, container.width,
                                         "anchor \(x),\(y) pushed the card off the right")
                XCTAssertLessThanOrEqual(p.origin.y + card.height, container.height,
                                         "anchor \(x),\(y) pushed the card off the bottom")
            }
        }
    }

    // A sidebar anchor has room on its right, so the card goes right and the arrow
    // leaves from the card's leading edge.
    func testAnchorOnTheLeftPutsTheCardRightWithALeadingArrow() {
        let p = OnboardingPlacement.place(anchor: rect(120, 300), card: card, container: container)
        XCTAssertEqual(p.arrowFrom, .leading)
        XCTAssertGreaterThan(p.origin.x, 120)
    }

    func testAnchorOnTheRightPutsTheCardLeftWithATrailingArrow() {
        let p = OnboardingPlacement.place(anchor: rect(1340, 300), card: card, container: container)
        XCTAssertEqual(p.arrowFrom, .trailing)
        XCTAssertLessThan(p.origin.x + card.width, 1340)
    }

    // Narrow container: neither side fits, so it must fall back to below/above.
    func testFallsBackToVerticalWhenNeitherSideFits() {
        let narrow = CGSize(width: 380, height: 900)
        let p = OnboardingPlacement.place(anchor: rect(190, 120), card: card, container: narrow)
        XCTAssertEqual(p.arrowFrom, .top)
        XCTAssertGreaterThan(p.origin.y, 120)
        XCTAssertGreaterThanOrEqual(p.origin.x, 0)
        XCTAssertLessThanOrEqual(p.origin.x + card.width, narrow.width)
    }

    func testFallsBackToAboveWhenBelowIsAlsoTooTight() {
        let narrow = CGSize(width: 380, height: 900)
        let p = OnboardingPlacement.place(anchor: rect(190, 820), card: card, container: narrow)
        XCTAssertEqual(p.arrowFrom, .bottom)
        XCTAssertLessThan(p.origin.y + card.height, 820)
    }

    // A card larger than its container can't satisfy anything; it must still be
    // deterministic rather than producing a negative origin.
    func testCardBiggerThanContainerClampsToTheOrigin() {
        let p = OnboardingPlacement.place(anchor: rect(10, 10),
                                          card: CGSize(width: 900, height: 900),
                                          container: CGSize(width: 400, height: 400))
        XCTAssertEqual(p.origin.x, 0, accuracy: 0.5)
        XCTAssertEqual(p.origin.y, 0, accuracy: 0.5)
    }
}
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  test -only-testing:ShepherdModelTests/OnboardingPlacementTests 2>&1 | tail -20
```
Expected: **BUILD FAILED**, `cannot find 'OnboardingPlacement' in scope`.

- [ ] **Step 3: Write `OnboardingPlacement.swift`**

```swift
import CoreGraphics

/// The card edge an arrow leaves from, pointing back at the anchor.
enum ArrowEdge: Equatable { case leading, trailing, top, bottom }

struct CardPlacement: Equatable {
    var origin: CGPoint
    var arrowFrom: ArrowEdge?
}

/// Where a coach-mark card sits relative to the element it describes. Tries the four
/// sides in order of how much room each has, then clamps so the card is always fully
/// on screen — an anchor in a corner must not push the card out of the window.
enum OnboardingPlacement {

    static func place(anchor: CGRect?,
                      card: CGSize,
                      container: CGSize,
                      gap: CGFloat = 18,
                      margin: CGFloat = 16) -> CardPlacement {

        guard let a = anchor else {
            return CardPlacement(origin: centered(card, in: container), arrowFrom: nil)
        }

        let roomRight  = container.width  - a.maxX - gap - margin
        let roomLeft   = a.minX - gap - margin
        let roomBelow  = container.height - a.maxY - gap - margin
        let roomAbove  = a.minY - gap - margin

        var origin: CGPoint
        var edge: ArrowEdge

        if roomRight >= card.width {
            origin = CGPoint(x: a.maxX + gap, y: a.midY - card.height / 2); edge = .leading
        } else if roomLeft >= card.width {
            origin = CGPoint(x: a.minX - gap - card.width, y: a.midY - card.height / 2); edge = .trailing
        } else if roomBelow >= card.height {
            origin = CGPoint(x: a.midX - card.width / 2, y: a.maxY + gap); edge = .top
        } else if roomAbove >= card.height {
            origin = CGPoint(x: a.midX - card.width / 2, y: a.minY - gap - card.height); edge = .bottom
        } else {
            // Nothing fits beside the anchor — take the roomiest side and let the
            // clamp below decide, so the card is still readable and on screen.
            let best = max(roomRight, roomLeft, roomBelow, roomAbove)
            if best == roomRight {
                origin = CGPoint(x: a.maxX + gap, y: a.midY - card.height / 2); edge = .leading
            } else if best == roomLeft {
                origin = CGPoint(x: a.minX - gap - card.width, y: a.midY - card.height / 2); edge = .trailing
            } else if best == roomBelow {
                origin = CGPoint(x: a.midX - card.width / 2, y: a.maxY + gap); edge = .top
            } else {
                origin = CGPoint(x: a.midX - card.width / 2, y: a.minY - gap - card.height); edge = .bottom
            }
        }

        origin.x = clamp(origin.x, card.width, container.width, margin)
        origin.y = clamp(origin.y, card.height, container.height, margin)
        return CardPlacement(origin: origin, arrowFrom: edge)
    }

    private static func centered(_ card: CGSize, in container: CGSize) -> CGPoint {
        CGPoint(x: max(0, (container.width - card.width) / 2),
                y: max(0, (container.height - card.height) / 2))
    }

    private static func clamp(_ v: CGFloat, _ size: CGFloat,
                              _ containerSize: CGFloat, _ margin: CGFloat) -> CGFloat {
        // A card wider than its container has no valid range; pin it at 0 rather
        // than letting max() hand back a negative origin.
        guard size + 2 * margin <= containerSize else { return 0 }
        return min(max(v, margin), containerSize - size - margin)
    }
}
```

- [ ] **Step 4: Add to the test target and regenerate**

In `project.yml`, after `- path: Sources/OnboardingPolicy.swift`, add:
```yaml
      - path: Sources/OnboardingPlacement.swift
```
Then `cd spike/seam1 && xcodegen generate`.

- [ ] **Step 5: Run and confirm pass**

```bash
cd spike/seam1
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  test -only-testing:ShepherdModelTests/OnboardingPlacementTests 2>&1 | tee /tmp/ob-test.log | tail -20
grep -c "Test Case .* passed" /tmp/ob-test.log
```
Expected: `** TEST SUCCEEDED **`, count **7**.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/OnboardingPlacement.swift \
        spike/seam1/Tests/OnboardingPlacementTests.swift \
        spike/seam1/project.yml
git commit -F - <<'EOF'
feat(onboarding): place a coach-mark card without pushing it off screen

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: `OnboardingDemoRepo` — the git sandbox

**Files:**
- Create: `spike/seam1/Sources/OnboardingDemoRepo.swift`
- Test: `spike/seam1/Tests/OnboardingDemoRepoTests.swift`
- Modify: `spike/seam1/project.yml` (add to `ShepherdModelTests` → `sources:`)

**Interfaces:**
- Consumes: `WorktreeService.run(_:in:env:) -> (code: Int32, out: String, err: String)` (`Sources/WorktreeService.swift:70`), already in the test target's sources.
- Produces:
  - `struct DemoRepoPaths: Equatable` — `root: String`, `origin: String`, `clone: String`, `repoName: String`; `static func standard() -> DemoRepoPaths`
  - `enum OnboardingDemoRepo` — `static func build(at: DemoRepoPaths) -> Result<Void, DemoRepoError>`, `static func teardown(at: DemoRepoPaths, worktreeBase: String)`
  - `struct DemoRepoError: Error, Equatable` — `command: String`, `message: String`
  - `static let branch = "feature/greeting"`, `static let baseBranch = "main"`

**Why a bare origin:** `WorktreeService` runs `git fetch origin` and aborts if it fails (`WorktreeService.swift:114`), then reads `refs/remotes/origin/HEAD`. A plain `git init` repo has neither, so Task 7's worktree step would abort. A local bare repo satisfies both offline.

**Why per-command git config:** every invocation carries `-c user.name` / `-c user.email` / `-c commit.gpgsign=false` / `-c init.defaultBranch=main`. A user with no `user.name` set gets a build that fails; one with GPG signing on gets a build that blocks on a passphrase prompt with no UI.

- [ ] **Step 1: Write the failing tests**

Create `spike/seam1/Tests/OnboardingDemoRepoTests.swift`:

```swift
import XCTest
@testable import Shepherd

/// Real git. The sandbox has to satisfy `WorktreeService`, which fetches origin and
/// reads `origin/HEAD` — a locally-init'd repo with no remote would abort worktree
/// creation, and only real git can prove it doesn't.
final class OnboardingDemoRepoTests: XCTestCase {

    private var paths: DemoRepoPaths!
    private var worktreeBase: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        let tmp = NSTemporaryDirectory() + "shepherd-onboarding-" + UUID().uuidString
        paths = DemoRepoPaths(root: tmp,
                              origin: tmp + "/origin.git",
                              clone: tmp + "/tour-repo",
                              repoName: "tour-repo")
        worktreeBase = NSTemporaryDirectory() + "shepherd-onboarding-wt-" + UUID().uuidString
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: paths.root)
        try? FileManager.default.removeItem(atPath: worktreeBase)
        try super.tearDownWithError()
    }

    @discardableResult
    private func git(_ args: String..., in dir: String? = nil) -> String {
        WorktreeService.run(args, in: dir ?? paths.clone).out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func build() throws {
        if case .failure(let e) = OnboardingDemoRepo.build(at: paths) {
            XCTFail("sandbox build failed at `\(e.command)`: \(e.message)")
            throw e
        }
    }

    func testBuildCreatesABareOriginWhoseHeadResolves() throws {
        try build()
        XCTAssertTrue(FileManager.default.fileExists(atPath: paths.origin + "/HEAD"))
        XCTAssertEqual(git("symbolic-ref", "--short", "refs/remotes/origin/HEAD"), "origin/main")
    }

    // The actual gate: WorktreeService aborts the whole worktree add if this fails.
    func testFetchOriginSucceedsOffline() throws {
        try build()
        XCTAssertEqual(WorktreeService.run(["fetch", "origin"], in: paths.clone).code, 0)
    }

    func testMainHasThreeCommitsAndTheBranchIsTwoAhead() throws {
        try build()
        XCTAssertEqual(git("rev-list", "--count", "main"), "3")
        XCTAssertEqual(git("rev-list", "--count", "main..\(OnboardingDemoRepo.branch)"), "2")
    }

    func testTheCheckedOutBranchIsTheFeatureBranch() throws {
        try build()
        XCTAssertEqual(git("rev-parse", "--abbrev-ref", "HEAD"), OnboardingDemoRepo.branch)
    }

    // The workbench needs all three rail sections to have content on first open.
    func testWorkingTreeHasOneStagedOneUnstagedAndOneUntrackedChange() throws {
        try build()
        let status = git("status", "--porcelain")
        let lines = status.split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.filter { $0.hasPrefix("M ") }.count, 1, "expected one staged edit in:\n\(status)")
        XCTAssertEqual(lines.filter { $0.hasPrefix(" M") }.count, 1, "expected one unstaged edit in:\n\(status)")
        XCTAssertEqual(lines.filter { $0.hasPrefix("??") }.count, 1, "expected one untracked file in:\n\(status)")
    }

    // A single-hunk diff wouldn't exercise the workbench's gap expansion or its
    // deletion bands, which is half of what the tour is showing off.
    func testTheStagedDiffHasTwoHunksAndARemovedLine() throws {
        try build()
        let diff = git("diff", "--cached", "-U3")
        XCTAssertEqual(diff.components(separatedBy: "\n@@").count - 1, 2, "expected 2 hunks in:\n\(diff)")
        XCTAssertTrue(diff.split(separator: "\n").contains { $0.hasPrefix("-") && !$0.hasPrefix("---") },
                      "expected a removed line in:\n\(diff)")
    }

    func testBuildIsIdempotentOverAnExistingSandbox() throws {
        try build()
        try build()
        XCTAssertEqual(git("rev-list", "--count", "main"), "3")
    }

    func testTeardownLeavesNothingBehind() throws {
        try build()
        OnboardingDemoRepo.teardown(at: paths, worktreeBase: worktreeBase)
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.root))
    }

    // The worktree lands outside the sandbox dir, so rm -rf on the sandbox alone
    // would leave both the directory and a stale registration behind.
    func testTeardownRemovesAWorktreeCreatedOutsideTheSandbox() throws {
        try build()
        let wt = worktreeBase + "/tour-repo/demo-branch"
        try FileManager.default.createDirectory(atPath: worktreeBase + "/tour-repo",
                                               withIntermediateDirectories: true)
        XCTAssertEqual(WorktreeService.run(["worktree", "add", "-b", "demo-branch", wt, "main"],
                                           in: paths.clone).code, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: wt))

        OnboardingDemoRepo.teardown(at: paths, worktreeBase: worktreeBase)
        XCTAssertFalse(FileManager.default.fileExists(atPath: wt))
        XCTAssertFalse(FileManager.default.fileExists(atPath: worktreeBase + "/tour-repo"))
    }

    func testTeardownOnAnAbsentSandboxIsANoOp() {
        OnboardingDemoRepo.teardown(at: paths, worktreeBase: worktreeBase)
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.root))
    }
}
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  test -only-testing:ShepherdModelTests/OnboardingDemoRepoTests 2>&1 | tail -20
```
Expected: **BUILD FAILED**, `cannot find 'DemoRepoPaths' in scope`.

- [ ] **Step 3: Write `OnboardingDemoRepo.swift`**

```swift
import Foundation

struct DemoRepoPaths: Equatable {
    let root: String
    let origin: String
    let clone: String
    let repoName: String

    /// `~/.shepherd/demo` (or `~/.shepherd/dev/demo` on a dev build).
    static func standard() -> DemoRepoPaths {
        let root = AppMode.supportPath("demo")
        return DemoRepoPaths(root: root,
                             origin: (root as NSString).appendingPathComponent("origin.git"),
                             clone: (root as NSString).appendingPathComponent("tour-repo"),
                             repoName: "tour-repo")
    }
}

struct DemoRepoError: Error, Equatable {
    let command: String
    let message: String
}

/// The throwaway git repository the tour operates in: a bare "remote" plus a working
/// clone, generated locally so it is offline and identical for every user.
enum OnboardingDemoRepo {

    static let baseBranch = "main"
    static let branch = "feature/greeting"

    // Identity and settings ride every invocation rather than `git config`, so the
    // sandbox neither depends on nor inherits the user's global git setup — an unset
    // user.name fails the build, and GPG signing blocks it on a passphrase prompt.
    private static let cfg = [
        "-c", "user.name=Shepherd Tour",
        "-c", "user.email=tour@shepherd.local",
        "-c", "commit.gpgsign=false",
        "-c", "init.defaultBranch=main",
        "-c", "advice.detachedHead=false",
    ]

    // MARK: - Contents

    private static let readme = """
    # tour-repo

    A throwaway repository Shepherd generated for its onboarding tour.
    It is deleted when the tour ends.
    """

    private static let greeterV1 = """
    def greet(name):
        return "Hello, " + name


    def farewell(name):
        return "Bye, " + name


    def main():
        print(greet("world"))
        print(farewell("world"))


    if __name__ == "__main__":
        main()
    """

    private static let greeterV2 = greeterV1.replacingOccurrences(
        of: "return \"Bye, \" + name",
        with: "return \"Goodbye, \" + name")

    private static let notesV1 = """
    # Notes

    - the greeter takes a name
    - `main` prints both messages
    """

    private static let greeterOnBranch = greeterV2 + """


    def shout(name):
        return greet(name).upper()
    """

    private static let notesOnBranch = notesV1 + "\n- a branch adds `shout`\n"

    // Two edits far apart in the file (so the diff has two hunks) and one line
    // removed (so the workbench renders a deletion band).
    private static let greeterStaged = greeterOnBranch
        .replacingOccurrences(of: "return \"Hello, \" + name",
                              with: "return f\"Hello, {name}!\"")
        .replacingOccurrences(of: "        print(farewell(\"world\"))\n", with: "")

    private static let notesUnstaged = notesOnBranch + "- edited, not staged\n"

    private static let scratch = "Untracked. Nothing tracks this file yet.\n"

    // MARK: - Build

    static func build(at p: DemoRepoPaths) -> Result<Void, DemoRepoError> {
        teardownFiles(at: p)
        do {
            let fm = FileManager.default
            try fm.createDirectory(atPath: p.clone, withIntermediateDirectories: true)

            try git(["init"], in: p.clone, p)
            try commit(files: ["README.md": readme], "Add a README", p)
            try commit(files: ["greeter.py": greeterV1], "Add the greeter", p)
            try commit(files: ["notes.md": notesV1, "greeter.py": greeterV2],
                       "Add notes; say goodbye properly", p)

            try git(["checkout", "-b", branch], in: p.clone, p)
            try commit(files: ["greeter.py": greeterOnBranch], "Add shout()", p)
            try commit(files: ["notes.md": notesOnBranch], "Note the new helper", p)

            try git(["init", "--bare", p.origin], in: p.root, p)
            try git(["remote", "add", "origin", p.origin], in: p.clone, p)
            try git(["push", "origin", baseBranch, branch], in: p.clone, p)
            try git(["remote", "set-head", "origin", baseBranch], in: p.clone, p)

            try write(greeterStaged, "greeter.py", p)
            try git(["add", "greeter.py"], in: p.clone, p)
            try write(notesUnstaged, "notes.md", p)
            try write(scratch, "scratch.md", p)

            return .success(())
        } catch let e as DemoRepoError {
            return .failure(e)
        } catch {
            return .failure(DemoRepoError(command: "filesystem", message: error.localizedDescription))
        }
    }

    // MARK: - Teardown

    /// Idempotent. Removes the worktree the tour created (which lives *outside* the
    /// sandbox, so `rm -rf` on the sandbox alone leaves a stale registration), then
    /// the sandbox itself.
    static func teardown(at p: DemoRepoPaths, worktreeBase: String) {
        let fm = FileManager.default
        if fm.fileExists(atPath: p.clone) {
            for dir in worktreeDirs(in: p.clone) {
                _ = WorktreeService.run(cfg + ["worktree", "remove", "--force", dir], in: p.clone)
            }
            _ = WorktreeService.run(cfg + ["worktree", "prune"], in: p.clone)
        }
        let repoWorktrees = (worktreeBase as NSString).appendingPathComponent(p.repoName)
        try? fm.removeItem(atPath: repoWorktrees)
        teardownFiles(at: p)
    }

    private static func teardownFiles(at p: DemoRepoPaths) {
        try? FileManager.default.removeItem(atPath: p.root)
    }

    /// Linked worktrees only — the main checkout is the first `worktree` record and
    /// must not be handed to `worktree remove`.
    private static func worktreeDirs(in clone: String) -> [String] {
        let out = WorktreeService.run(cfg + ["worktree", "list", "--porcelain"], in: clone).out
        return out.split(separator: "\n")
            .filter { $0.hasPrefix("worktree ") }
            .map { String($0.dropFirst("worktree ".count)) }
            .filter { $0 != clone }
    }

    // MARK: - Shell

    private static func git(_ args: [String], in dir: String, _ p: DemoRepoPaths) throws {
        let r = WorktreeService.run(cfg + args, in: dir)
        guard r.code == 0 else {
            throw DemoRepoError(command: "git " + args.joined(separator: " "),
                                message: r.err.isEmpty ? r.out : r.err)
        }
    }

    private static func write(_ contents: String, _ name: String, _ p: DemoRepoPaths) throws {
        let path = (p.clone as NSString).appendingPathComponent(name)
        try contents.write(toFile: path, atomically: true, encoding: .utf8)
    }

    private static func commit(files: [String: String], _ message: String,
                               _ p: DemoRepoPaths) throws {
        for (name, contents) in files.sorted(by: { $0.key < $1.key }) {
            try write(contents, name, p)
            try git(["add", name], in: p.clone, p)
        }
        try git(["commit", "-m", message], in: p.clone, p)
    }
}
```

`commit(files:)` writes *and* stages its own files, so nothing should be written to the clone outside of it until the dirty-tree step at the end — a file written before its commit would sit untracked in the commit that was supposed to introduce it.

- [ ] **Step 4: Add to the test target and regenerate**

In `project.yml`, after `- path: Sources/OnboardingPlacement.swift`, add:
```yaml
      - path: Sources/OnboardingDemoRepo.swift
      - path: Sources/AppMode.swift
```
(`AppMode` is needed by `DemoRepoPaths.standard()`. If it is already listed, do not add it twice — check first with `grep -n "AppMode" project.yml`.)

Then `cd spike/seam1 && xcodegen generate`.

- [ ] **Step 5: Run and confirm pass**

```bash
cd spike/seam1
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  test -only-testing:ShepherdModelTests/OnboardingDemoRepoTests 2>&1 | tee /tmp/ob-test.log | tail -30
grep -c "Test Case .* passed" /tmp/ob-test.log
```
Expected: `** TEST SUCCEEDED **`, count **10**.

If `testTheStagedDiffHasTwoHunksAndARemovedLine` fails with 1 hunk, the two edits in `greeterStaged` are within 3 context lines of each other and git merged them — move them further apart in `greeterV1` (add filler functions between `greet` and `main`) rather than loosening the assertion.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/OnboardingDemoRepo.swift \
        spike/seam1/Tests/OnboardingDemoRepoTests.swift \
        spike/seam1/project.yml
git commit -F - <<'EOF'
feat(onboarding): a local git sandbox the tour can really operate on

Bare origin plus a working clone, because worktree creation fetches origin
and reads origin/HEAD, and aborts if either is missing. Every git call
carries its own identity and gpgsign=false so the build neither depends on
nor inherits the user's global config.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: Anchor publishing

**Files:**
- Create: `spike/seam1/Sources/OnboardingAnchorKey.swift`
- Modify: `spike/seam1/Sources/SidebarView.swift`, `spike/seam1/Sources/SplitContainer.swift`, `spike/seam1/Sources/UpdatePillView.swift`, `spike/seam1/Sources/Workbench/WorkbenchView.swift`

**Interfaces:**
- Consumes: `OnboardingAnchor` (Task 1).
- Produces:
  - `struct OnboardingAnchorKey: PreferenceKey` with `defaultValue: [OnboardingAnchor: Anchor<CGRect>]`
  - `extension View { func onboardingAnchor(_ a: OnboardingAnchor) -> some View }`

A view that forgets the modifier degrades to a `.centered` card (Task 5 resolves a missing anchor to `nil`), never a crash.

- [ ] **Step 1: Create `OnboardingAnchorKey.swift`**

```swift
import SwiftUI

/// Real UI elements publish their bounds so a coach-mark card can point an arrow at
/// them. Same mechanism `SidebarView` uses for `FolderCentersKey`.
struct OnboardingAnchorKey: PreferenceKey {
    static var defaultValue: [OnboardingAnchor: Anchor<CGRect>] = [:]
    static func reduce(value: inout [OnboardingAnchor: Anchor<CGRect>],
                       nextValue: () -> [OnboardingAnchor: Anchor<CGRect>]) {
        value.merge(nextValue(), uniquingKeysWith: { _, b in b })
    }
}

extension View {
    func onboardingAnchor(_ a: OnboardingAnchor) -> some View {
        anchorPreference(key: OnboardingAnchorKey.self, value: .bounds) { [a: $0] }
    }
}
```

- [ ] **Step 2: Publish the sidebar anchors**

In `SidebarView.swift`:

1. On the `WorkspaceFolderHeader`'s outermost view inside the workspace loop, add — gated so only the demo workspace publishes, since the anchor is a single slot:
   ```swift
   .onboardingAnchor(.folderHeader)
   ```
   Apply it conditionally with a small helper so non-demo folders don't overwrite the slot:
   ```swift
   .modifier(OnboardingAnchorIf(anchor: .folderHeader,
                                active: ws.id == store.onboarding.demoWorkspaceID))
   ```
2. On each `TabRow`/`SplitTabGroup` in that same loop, using the tab's index within the workspace:
   ```swift
   .modifier(OnboardingAnchorIf(anchor: .tabRow(idx),
                                active: ws.id == store.onboarding.demoWorkspaceID && idx <= 1))
   ```
3. On the state dot inside `TabRow` and on each pip inside `SplitTabGroup`, using the pane's index within the tab:
   ```swift
   .modifier(OnboardingAnchorIf(anchor: .stateDot(paneIdx),
                                active: tab.tabID == store.onboarding.demoTabID && paneIdx <= 1))
   ```
4. On the sidebar's footer container (the `VStack` that holds `UpdatePillView`):
   ```swift
   .onboardingAnchor(.sidebarFooter)
   ```

Add the conditional modifier to `OnboardingAnchorKey.swift`:

```swift
/// Anchors are single slots, so only the demo workspace's rows may claim one —
/// otherwise the last folder drawn wins and the arrow points at a stranger's tab.
struct OnboardingAnchorIf: ViewModifier {
    let anchor: OnboardingAnchor
    let active: Bool
    func body(content: Content) -> some View {
        if active { content.onboardingAnchor(anchor) } else { content }
    }
}
```

- [ ] **Step 3: Publish the terminal and workbench anchors**

In `SplitContainer.swift`, on the outermost container of the recursive render:
```swift
.onboardingAnchor(.terminalArea)
```

In `Workbench/WorkbenchView.swift`, on the rail column's outermost view:
```swift
.onboardingAnchor(.workbenchRail)
```

- [ ] **Step 4: Build**

`store.onboarding` does not exist until Task 7, so this step will not compile yet. Comment out the three `OnboardingAnchorIf` call sites' `active:` expressions to `active: false` **temporarily**, build to prove the modifier and key compile, then restore them and leave the build red until Task 7 lands.

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -15
```
Expected with `active: false`: `** BUILD SUCCEEDED **`.

> Because this task cannot end green with its real call sites, **do Task 4 and Task 7 back to back** and treat them as one review gate if working task-by-task.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/OnboardingAnchorKey.swift \
        spike/seam1/Sources/SidebarView.swift \
        spike/seam1/Sources/SplitContainer.swift \
        spike/seam1/Sources/Workbench/WorkbenchView.swift
git commit -F - <<'EOF'
feat(onboarding): let real views publish where a coach-mark arrow should point

Only the demo workspace's rows claim an anchor slot; a stranger's tab at the
same index would otherwise win the arrow.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: `OnboardingOverlayView` — backdrop, spotlight, card, arrow

**Files:**
- Create: `spike/seam1/Sources/OnboardingOverlayView.swift`

**Interfaces:**
- Consumes: `OnboardingStep`, `OnboardingAnchor` (Task 1); `OnboardingPlacement`, `CardPlacement`, `ArrowEdge` (Task 2); `OnboardingAnchorKey` (Task 4); `OnboardingController` (Task 7) via `@EnvironmentObject`.
- Produces: `struct OnboardingOverlayView: View`, rendered from `ContentView` in Task 8.

Verification is compile-only per the global constraints; the user checks appearance at runtime.

- [ ] **Step 1: Create the file**

```swift
import SwiftUI

/// The tour's chrome: a dimmed backdrop with a spotlight cut out of it, one card, and
/// an elbow arrow from the card to the element. The cutout is visual only — the dim
/// layer eats every click so the user cannot wander into a state the script does not
/// expect; the card's own controls are the only interaction.
struct OnboardingOverlayView: View {
    @EnvironmentObject var onboarding: OnboardingController

    private let cardWidth: CGFloat = 360

    var body: some View {
        GeometryReader { geo in
            if let step = onboarding.currentStep {
                overlayPreferenceReader(step: step, container: geo.size)
            }
        }
        .ignoresSafeArea()
        .background(escHandler)
    }

    private func overlayPreferenceReader(step: OnboardingStep, container: CGSize) -> some View {
        Color.clear.overlayPreferenceValue(OnboardingAnchorKey.self) { anchors in
            GeometryReader { proxy in
                let spot: CGRect? = {
                    guard step.anchor != .centered, let a = anchors[step.anchor] else { return nil }
                    return proxy[a]
                }()
                content(step: step, spot: spot, container: container)
            }
        }
    }

    private func content(step: OnboardingStep, spot: CGRect?, container: CGSize) -> some View {
        let card = CGSize(width: cardWidth, height: estimatedHeight(step))
        let place = OnboardingPlacement.place(anchor: spot, card: card, container: container)

        return ZStack(alignment: .topLeading) {
            backdrop(spot: spot)

            if let spot, let edge = place.arrowFrom {
                ArrowShape(from: cardEdgePoint(place: place, card: card, edge: edge), to: nearestEdge(of: spot, from: edge))
                    .stroke(Theme.accent.opacity(0.9), style: .init(lineWidth: 1.5, lineCap: .round))
                    .allowsHitTesting(false)
            }

            cardView(step: step)
                .frame(width: cardWidth)
                .offset(x: place.origin.x, y: place.origin.y)
        }
    }

    /// Full-screen dim with the anchor punched out, so the element being described
    /// keeps its real colours instead of reading through 45% black.
    private func backdrop(spot: CGRect?) -> some View {
        Canvas { ctx, size in
            var p = Path(CGRect(origin: .zero, size: size))
            if let spot {
                p.addPath(Path(roundedRect: spot.insetBy(dx: -6, dy: -4),
                               cornerRadius: 6, style: .continuous))
            }
            ctx.fill(p, with: .color(.black.opacity(0.55)), style: FillStyle(eoFill: true))
        }
        .contentShape(Rectangle())
        .onTapGesture { }   // swallow, never dismiss — Skip is an explicit button
    }

    private func cardView(step: OnboardingStep) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(step.title)
                .font(.ui(14, .semibold))
                .foregroundColor(Theme.textPrimary)

            Text(step.body)
                .font(.ui(12))
                .foregroundColor(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)

            if step.id == "welcome" {
                OnboardingWelcomeView()
                    .environmentObject(onboarding)
            }

            HStack {
                Text("\(onboarding.stepNumber) / \(onboarding.stepCount)")
                    .font(.ui(11))
                    .foregroundColor(Theme.textDim)
                Spacer()
                Button("Skip") { onboarding.skip() }
                    .buttonStyle(.plain)
                    .font(.ui(12))
                    .foregroundColor(Theme.textDim)
                    .focusable(false)
                Button(onboarding.isLastStep ? "Finish" : "Next") { onboarding.advance() }
                    .keyboardShortcut(.defaultAction)
                    .focusable(false)
            }
        }
        .padding(20)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Theme.surface1)
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Theme.hairline, lineWidth: 1))
        )
        .shadow(color: .black.opacity(0.4), radius: 26, y: 12)
    }

    private var escHandler: some View {
        Button("") { onboarding.skip() }
            .keyboardShortcut(.cancelAction)
            .opacity(0)
            .frame(width: 0, height: 0)
            .focusable(false)
    }

    // Placement needs a height before the card is laid out, so approximate from the
    // copy; over-estimating only widens the gap to the anchor.
    private func estimatedHeight(_ step: OnboardingStep) -> CGFloat {
        let lines = ceil(CGFloat(step.body.count) / 46)
        return 96 + lines * 16 + (step.id == "welcome" ? 140 : 0)
    }

    private func cardEdgePoint(place: CardPlacement, card: CGSize, edge: ArrowEdge) -> CGPoint {
        let o = place.origin
        switch edge {
        case .leading:  return CGPoint(x: o.x, y: o.y + card.height / 2)
        case .trailing: return CGPoint(x: o.x + card.width, y: o.y + card.height / 2)
        case .top:      return CGPoint(x: o.x + card.width / 2, y: o.y)
        case .bottom:   return CGPoint(x: o.x + card.width / 2, y: o.y + card.height)
        }
    }

    private func nearestEdge(of spot: CGRect, from edge: ArrowEdge) -> CGPoint {
        switch edge {
        case .leading:  return CGPoint(x: spot.maxX, y: spot.midY)
        case .trailing: return CGPoint(x: spot.minX, y: spot.midY)
        case .top:      return CGPoint(x: spot.midX, y: spot.maxY)
        case .bottom:   return CGPoint(x: spot.midX, y: spot.minY)
        }
    }
}

/// An elbow rather than a straight line: a diagonal across the chrome reads as a
/// stray hairline, a right-angled one reads as pointing.
private struct ArrowShape: Shape {
    let from: CGPoint
    let to: CGPoint

    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: from)
        let mid = CGPoint(x: (from.x + to.x) / 2, y: from.y)
        p.addLine(to: mid)
        p.addLine(to: CGPoint(x: mid.x, y: to.y))
        p.addLine(to: to)

        let head: CGFloat = 4
        let dx: CGFloat = to.x >= mid.x ? -1 : 1
        p.move(to: CGPoint(x: to.x + dx * head, y: to.y - head))
        p.addLine(to: to)
        p.addLine(to: CGPoint(x: to.x + dx * head, y: to.y + head))
        return p
    }
}
```

- [ ] **Step 2: Check the Theme tokens exist**

```bash
cd spike/seam1/Sources && grep -n "static var accent\|static var surface1\|static var hairline\|static var textDim\|static var textPrimary" Theme.swift
grep -n "func ui(" Theme.swift ShepherdUI.swift
```
If `Theme.accent` does not exist, use the nearest existing emphasis token from the grep output rather than inventing one.

- [ ] **Step 3: Build** — will not compile until Task 7 provides `OnboardingController` and `OnboardingWelcomeView`. Land Tasks 5, 6 and 7 together as one gate; the first green build is at the end of Task 7.

- [ ] **Step 4: Commit**

```bash
git add spike/seam1/Sources/OnboardingOverlayView.swift
git commit -F - <<'EOF'
feat(onboarding): the coach-mark overlay — dim, spotlight, card, elbow arrow

The cutout is visual only; the dim layer swallows clicks so the tour cannot be
walked out from under itself.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 6: `OnboardingWelcomeView` — plugin, notifications, theme

**Files:**
- Create: `spike/seam1/Sources/OnboardingWelcomeView.swift`

**Interfaces:**
- Consumes: `ClaudePluginInstaller.currentState() -> PluginInstallState` and `ClaudePluginInstaller.install() throws` (`Sources/ClaudePluginInstaller.swift:85,103`); `ShepherdConfigWriter.set(_ edits: [ConfigEdit]) throws` and `ConfigEdit` (`Sources/ShepherdConfigWriter.swift:93,10`); `GhosttyApp.reloadConfig()`.
- Produces: `struct OnboardingWelcomeView: View`, embedded in the welcome card by Task 5.

- [ ] **Step 1: Read how Settings already does these three things**

```bash
cd spike/seam1/Sources
grep -n "ClaudePluginInstaller\|PluginInstallState" SettingsView.swift | head
grep -n "ConfigEdit(\|reloadConfig\|theme" SettingsView.swift | head -20
grep -n "UNUserNotificationCenter\|requestAuthorization\|getNotificationSettings" AppDelegate.swift
```
Reuse those call shapes verbatim — the theme round-trip in particular already knows the `# shepherd: theme` comment-key convention.

- [ ] **Step 2: Create the file**

```swift
import SwiftUI
import UserNotifications

/// The welcome card's three rows. The plugin row is the load-bearing one: without it
/// no hook fires and no pane ever leaves `shell`.
struct OnboardingWelcomeView: View {
    @EnvironmentObject var onboarding: OnboardingController

    @State private var pluginState = ClaudePluginInstaller.currentState()
    @State private var pluginError: String?
    @State private var notifAuthorized = false
    @State private var theme = "dark"

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            pluginRow
            notificationRow
            themeRow
        }
        .task {
            let s = await UNUserNotificationCenter.current().notificationSettings()
            notifAuthorized = s.authorizationStatus == .authorized
        }
    }

    private var pluginRow: some View {
        HStack(spacing: 8) {
            dot(installed: isPluginInstalled)
            VStack(alignment: .leading, spacing: 2) {
                Text("Claude Code plugin")
                    .font(.ui(12))
                    .foregroundColor(Theme.textPrimary)
                Text(pluginError ?? pluginSubtitle)
                    .font(.ui(10))
                    .foregroundColor(pluginError == nil ? Theme.textDim : Theme.stateError)
            }
            Spacer()
            if case .notInstalled = pluginState {
                Button("Install") { installPlugin() }
                    .font(.ui(11))
                    .focusable(false)
            }
        }
    }

    private var notificationRow: some View {
        HStack(spacing: 8) {
            dot(installed: notifAuthorized)
            Text("Notifications")
                .font(.ui(12))
                .foregroundColor(Theme.textPrimary)
            Spacer()
            Text(notifAuthorized ? "allowed" : "System Settings → Notifications")
                .font(.ui(10))
                .foregroundColor(Theme.textDim)
        }
    }

    private var themeRow: some View {
        HStack(spacing: 8) {
            dot(installed: true)
            Text("Theme")
                .font(.ui(12))
                .foregroundColor(Theme.textPrimary)
            Spacer()
            Picker("", selection: $theme) {
                Text("Dark").tag("dark")
                Text("Light").tag("light")
                Text("Warm").tag("warm")
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .frame(width: 180)
            .focusable(false)
            .onChange(of: theme) { _, new in applyTheme(new) }
        }
    }

    private var isPluginInstalled: Bool {
        if case .installed = pluginState { return true }
        return false
    }

    private var pluginSubtitle: String {
        switch pluginState {
        case .installed:            return "installed — agent states will work"
        case .notInstalled:         return "needed for agent states"
        case .unavailable:          return "not bundled in this build"
        case .linkedElsewhere(let p): return "another checkout is linked: \(p)"
        case .occupied:             return "something else already sits at ~/.claude/skills/shepherd"
        }
    }

    private func installPlugin() {
        do {
            try ClaudePluginInstaller.install()
            pluginError = nil
        } catch {
            pluginError = error.localizedDescription
        }
        pluginState = ClaudePluginInstaller.currentState()
        onboarding.refreshPreflight()
    }

    private func applyTheme(_ value: String) {
        try? ShepherdConfigWriter.set([ConfigEdit(key: "theme", value: value, kind: .shepherd)])
        onboarding.reloadConfig()
    }

    private func dot(installed: Bool) -> some View {
        Circle()
            .fill(installed ? Theme.stateIdle : Theme.textDim.opacity(0.4))
            .frame(width: 6, height: 6)
    }
}
```

- [ ] **Step 3: Reconcile the invented names against reality**

The `ConfigEdit` initialiser, `Theme.stateIdle`/`Theme.stateError`, and the exact `PluginInstallState` payloads above are written from the greps in Task 6 Step 1. Before building, confirm each:

```bash
cd spike/seam1/Sources
sed -n '5,20p' ShepherdConfigWriter.swift        # ConfigEdit's real init
grep -n "static var state" Theme.swift          # real state colour token names
sed -n '11,25p' ClaudePluginInstaller.swift      # real PluginInstallState cases
```
Fix any mismatch in the code above rather than adding a shim. `pickerStyle(.segmented)` inside a card is fine; if the theme picker fights the card's dark background at runtime, that is a follow-up for the user to report, not a reason to change approach now.

- [ ] **Step 4: Build** — green build arrives at the end of Task 7. Commit as-is.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/OnboardingWelcomeView.swift
git commit -F - <<'EOF'
feat(onboarding): the welcome card's plugin, notification and theme rows

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 7: `OnboardingController` — the state machine

**Files:**
- Create: `spike/seam1/Sources/OnboardingController.swift`
- Modify: `spike/seam1/Sources/AgentStore.swift` (add the `onboarding` reference and the turn-finished notification)

**Interfaces:**
- Consumes: `OnboardingPolicy.steps(for:)`, `Preflight`, `OnboardingStep`, `OnboardingAction` (Task 1); `DemoRepoPaths`, `OnboardingDemoRepo.build/teardown` (Task 3). From `AgentStore`: `newWorkspace() -> String` (:259), `renameWorkspace(_:to:)` (:279), `selectWorkspace(_:)` (:269), `setWorkspaceDirectory(_:to:)` (:345), `newTab(inWorkspace:cwd:sessionID:) -> String` (:951), `select(tabID:inWorkspace:)` (:939), `splitFocused(_:)` (:1394), `focusPane(_:)` (:1330), `injectText(_:intoPane:)` (:1132), `toggleDiffPanel()` (:1072), `newWorktreeTab(inWorkspace:name:)` (:380), `selectNextAttention()` (:882), `deleteWorkspace(_:)` (:307), `persist()`, `tabs`, `workspaces`.
- Produces:
  - `@MainActor final class OnboardingController: ObservableObject`
  - `@Published var phase: OnboardingPhase` where `enum OnboardingPhase: Equatable { case dormant, running(Int), finished }`
  - `var currentStep: OnboardingStep?`, `var stepNumber: Int`, `var stepCount: Int`, `var isLastStep: Bool`
  - `var demoWorkspaceID: String?`, `var demoTabID: String?`
  - `func startIfFirstRun()`, `func start()`, `func advance()`, `func skip()`, `func refreshPreflight()`, `func reloadConfig()`, `func reconcileAtLaunch()`, `func teardownNow()`
  - `func noteTurnFinished(paneID: String)` — called from `AgentStore.applyTransition`

**Two hazards this task must respect:**
- Detect turn completion off `StateTransition.turnFinished` (`StopPolicy.swift:15`), **never** `state == .needsCheck`. Step `agentWatched` is specifically the viewing landing, where `needsCheck` never occurs — polling for it hangs forever.
- Do **not** add the overlay to `isFrontPane` (`AgentStore.swift:1031`). Spec §7.2.

- [ ] **Step 1: Create `OnboardingController.swift`**

```swift
import SwiftUI
import AppKit

enum OnboardingPhase: Equatable { case dormant, running(Int), finished }

/// Drives the first-run tour: resolves what's available, performs each step's real
/// action against the store, and removes its own sandbox on every exit path.
@MainActor
final class OnboardingController: ObservableObject {

    @Published private(set) var phase: OnboardingPhase = .dormant
    @Published private(set) var preflight = Preflight(claudePath: nil, pluginInstalled: false,
                                                      gitAvailable: false, sandboxBuilt: false)

    private(set) var demoWorkspaceID: String?
    private(set) var demoTabID: String?

    private weak var store: AgentStore?
    private var steps: [OnboardingStep] = []
    private let paths = DemoRepoPaths.standard()
    private var turnContinuation: CheckedContinuation<Void, Never>?
    private var awaitingTurnFor: String?

    private static let completedKey = "shepherd.onboarding.completedVersion"

    init(store: AgentStore) { self.store = store }

    // MARK: - Lifecycle

    /// A dev build seeds its layout from the daily app, so "fresh install" is never
    /// true there; the Help menu item still works.
    func startIfFirstRun() {
        guard !AppMode.isDev,
              UserDefaults.standard.string(forKey: Self.completedKey) == nil,
              UserDefaults.standard.data(forKey: "shepherd.workspaces.v1") == nil
        else { return }
        start()
    }

    func start() {
        preflight = resolvePreflight(sandboxBuilt: false)
        steps = OnboardingPolicy.steps(for: preflight)
        phase = .running(0)
        run(steps[0].action)
    }

    /// A sandbox on disk with no tour running is the residue of a crash mid-tour.
    func reconcileAtLaunch() {
        guard phase == .dormant,
              FileManager.default.fileExists(atPath: paths.root) else { return }
        OnboardingDemoRepo.teardown(at: paths, worktreeBase: WorktreeService.configuredBase())
    }

    // MARK: - Navigation

    var currentStep: OnboardingStep? {
        guard case .running(let i) = phase, steps.indices.contains(i) else { return nil }
        return steps[i]
    }
    var stepNumber: Int { if case .running(let i) = phase { return i + 1 }; return 0 }
    var stepCount: Int { steps.count }
    var isLastStep: Bool { if case .running(let i) = phase { return i == steps.count - 1 }; return false }

    func advance() {
        guard case .running(let i) = phase else { return }
        let next = i + 1
        guard next < steps.count else { return finish() }
        phase = .running(next)
        run(steps[next].action)
    }

    func skip() {
        guard case .running = phase else { return }
        finish()
    }

    private func finish() {
        teardownNow()
        phase = .finished
    }

    // MARK: - Preflight

    func refreshPreflight() {
        preflight = resolvePreflight(sandboxBuilt: preflight.sandboxBuilt)
    }

    /// A GUI .app misses Homebrew's PATH, so `claude` has to be resolved the way
    /// `GH.executablePath` resolves `gh` rather than assumed present.
    private func resolvePreflight(sandboxBuilt: Bool) -> Preflight {
        var plugin = false
        if case .installed = ClaudePluginInstaller.currentState() { plugin = true }
        return Preflight(claudePath: Self.resolve("claude"),
                         pluginInstalled: plugin,
                         gitAvailable: Self.resolve("git") != nil,
                         sandboxBuilt: sandboxBuilt)
    }

    private static func resolve(_ tool: String) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-lc", "command -v \(tool)"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let path = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return (p.terminationStatus == 0 && !path.isEmpty) ? path : nil
    }

    func reloadConfig() { store?.reloadConfigFromDisk() }

    // MARK: - Actions

    private func run(_ action: OnboardingAction) {
        switch action {
        case .none:
            break
        case .buildSandbox:
            Task.detached { [paths] in
                let ok = (try? OnboardingDemoRepo.build(at: paths).get()) != nil
                await MainActor.run { self.sandboxFinished(ok) }
            }
        case .createDemoWorkspace:  createDemoWorkspace()
        case .splitDemoTab:         splitDemoTab()
        case .startClaude:          Task { await startClaude() }
        case .promptWatched:        Task { await promptWatched() }
        case .promptUnwatched:      Task { await promptUnwatched() }
        case .openWorkbench:        openWorkbench()
        case .addWorktreeTab:       addWorktreeTab()
        case .teardown:             teardownNow()
        }
    }

    /// Re-filtering here rather than at start() is what lets the build run while the
    /// user reads the welcome card.
    private func sandboxFinished(_ ok: Bool) {
        preflight.sandboxBuilt = ok
        guard case .running(let i) = phase else { return }
        let currentID = steps[i].id
        steps = OnboardingPolicy.steps(for: preflight)
        if let idx = steps.firstIndex(where: { $0.id == currentID }) { phase = .running(idx) }
    }

    private func createDemoWorkspace() {
        guard let store else { return }
        let ws = store.newWorkspace()
        store.renameWorkspace(ws, to: "Shepherd Tour")
        store.setWorkspaceDirectory(ws, to: paths.clone)
        demoWorkspaceID = ws
        demoTabID = store.newTab(inWorkspace: ws, cwd: paths.clone)
        store.selectWorkspace(ws)
        if let t = demoTabID { store.select(tabID: t, inWorkspace: ws) }
    }

    /// Reuses the same store call ⌘D makes, after selecting the demo tab — no
    /// synthetic key events, and no new unscoped store surface.
    private func splitDemoTab() {
        guard let store, let ws = demoWorkspaceID, let t = demoTabID else { return }
        store.select(tabID: t, inWorkspace: ws)
        store.splitFocused(.row)
    }

    private func demoPane(_ index: Int) -> String? {
        guard let store, let ws = demoWorkspaceID, let t = demoTabID,
              let w = store.workspaces.first(where: { $0.id == ws }),
              let tab = w.tabs.first(where: { $0.tabID == t }),
              tab.paneIDs.indices.contains(index) else { return nil }
        return tab.paneIDs[index]
    }

    private func startClaude() async {
        guard let store, let pane = demoPane(0) else { return }
        store.focusPane(pane)
        store.injectText("claude\n", intoPane: pane)
    }

    /// Single-line prompts throughout: a typed newline is an Enter press, so
    /// `injectText` is only safe for one line.
    private func promptWatched() async {
        guard let store, let pane = demoPane(0) else { return }
        store.focusPane(pane)
        store.injectText("Reply with exactly: hello from Shepherd\n", intoPane: pane)
        await waitForTurn(pane)
    }

    private func promptUnwatched() async {
        guard let store, let pane = demoPane(0), let sibling = demoPane(1) else { return }
        store.focusPane(sibling)
        store.injectText("Reply with exactly: and again\n", intoPane: pane)
        await waitForTurn(pane)
        store.selectNextAttention()
    }

    /// Waits on `turnFinished`, never on `state == .needsCheck` — the watched step is
    /// the viewing landing, where needsCheck never occurs.
    private func waitForTurn(_ pane: String) async {
        awaitingTurnFor = pane
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            turnContinuation = c
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 90_000_000_000)
                await MainActor.run { self?.resumeTurnWait() }   // the agent may never answer
            }
        }
    }

    func noteTurnFinished(paneID: String) {
        guard paneID == awaitingTurnFor else { return }
        resumeTurnWait()
    }

    private func resumeTurnWait() {
        awaitingTurnFor = nil
        turnContinuation?.resume()
        turnContinuation = nil
    }

    private func openWorkbench() {
        guard let store, let pane = demoPane(0) else { return }
        store.focusPane(pane)
        store.toggleDiffPanel()
    }

    private func addWorktreeTab() {
        guard let store, let ws = demoWorkspaceID else { return }
        store.newWorktreeTab(inWorkspace: ws, name: "tour-branch")
    }

    // MARK: - Teardown

    /// Idempotent, and the sandbox must be gone before the store persists — otherwise
    /// the demo workspace, its cwds and a live Claude sessionID land in
    /// shepherd.workspaces.v1 and get --resume'd next launch into a deleted directory.
    func teardownNow() {
        if let store {
            if store.diffPanelOpen { store.toggleDiffPanel() }
            if let ws = demoWorkspaceID { store.deleteWorkspace(ws) }
        }
        demoWorkspaceID = nil
        demoTabID = nil
        OnboardingDemoRepo.teardown(at: paths, worktreeBase: WorktreeService.configuredBase())
        UserDefaults.standard.set(AppVersion.current.description, forKey: Self.completedKey)
        store?.persist()
    }
}
```

- [ ] **Step 2: Reconcile three invented call sites**

```bash
cd spike/seam1/Sources
grep -n "func reloadConfigFromDisk\|func reloadConfig" AgentStore.swift Ghostty.swift
grep -n "configuredBase\|worktree-base\|func base" WorktreeService.swift
grep -n "func persist" AgentStore.swift
grep -n "static var current" Version.swift
```
`reloadConfigFromDisk()`, `WorktreeService.configuredBase()` and `store.persist()` are the three names most likely not to exist verbatim. Use the real ones from these greps; if `persist()` is private, make it `func` (not `private func`) rather than duplicating its body.

- [ ] **Step 3: Wire the turn-finished signal in `AgentStore`**

In `AgentStore.applyTransition` (`AgentStore.swift:1210`), where the `StateTransition` is already in hand, add after the state is applied:

```swift
if t.turnFinished { onboarding?.noteTurnFinished(paneID: paneID) }
```

Add the property near the other controllers on `AgentStore`:

```swift
/// Set once at construction; nil in tests and on any build without a tour running.
weak var onboarding: OnboardingController?
```

- [ ] **Step 4: Restore Task 4's real `active:` expressions**

Change the three `OnboardingAnchorIf(... active: false)` placeholders back to the real predicates from Task 4 Step 2, now that `store.onboarding` exists. Note the property is `weak var onboarding` on the store, so the call sites read `store.onboarding?.demoWorkspaceID == ws.id`.

- [ ] **Step 5: Build**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -25
```
Expected: `** BUILD SUCCEEDED **` — the first green build across Tasks 4–7.

- [ ] **Step 6: Re-run the whole test suite for regressions**

```bash
cd spike/seam1
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  test -only-testing:ShepherdModelTests 2>&1 | tee /tmp/ob-all.log | tail -20
grep -c "Test Case .* passed" /tmp/ob-all.log
grep -c "Test Case .* failed" /tmp/ob-all.log
```
Expected: `** TEST SUCCEEDED **`, 0 failures, and a count that includes the 28 new cases from Tasks 1–3.

- [ ] **Step 7: Commit**

```bash
git add spike/seam1/Sources/OnboardingController.swift \
        spike/seam1/Sources/AgentStore.swift \
        spike/seam1/Sources/SidebarView.swift \
        spike/seam1/Sources/SplitContainer.swift
git commit -F - <<'EOF'
feat(onboarding): the tour state machine and its real actions

Turn completion is read off StateTransition.turnFinished, not state ==
needsCheck: the watched step is the viewing landing, where needsCheck never
happens and a poll would wait forever. Teardown runs before persist so the
sandbox never reaches shepherd.workspaces.v1.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 8: Wiring — overlay, menu, launch and quit

**Files:**
- Modify: `spike/seam1/Sources/ContentView.swift`, `spike/seam1/Sources/ShepherdApp.swift`, `spike/seam1/Sources/AppDelegate.swift`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: the feature, reachable.

- [ ] **Step 1: Construct the controller and expose it**

In `ShepherdApp.swift`, where `AgentStore` is created, add after it:

```swift
@StateObject private var onboarding: OnboardingController
```
Initialise it with the store in the app's `init()`, set `store.onboarding = onboarding`, and inject it alongside the store:
```swift
.environmentObject(onboarding)
```

- [ ] **Step 2: Add the overlay to `ContentView`**

In `ContentView.swift`, append after the `pendingApproval` overlay block (currently ends at line 109) — **last, so it sits above every sheet**:

```swift
        // The first-run tour. Deliberately NOT part of isFrontPane's overlay check:
        // the terminal is genuinely visible behind it, which is what makes the
        // watched-vs-unwatched steps honest.
        .overlay {
            if store.onboarding?.currentStep != nil {
                OnboardingOverlayView()
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.14), value: store.onboarding?.stepNumber ?? 0)
```

- [ ] **Step 3: Add the Help menu item**

In `ShepherdApp.swift`'s `.commands { }`, alongside the existing Help entry for the cheatsheet:

```swift
CommandGroup(replacing: .help) {
    Button("Keyboard Shortcuts") { store.showShortcuts.toggle() }
    Button("Shepherd Tour") { onboarding.start() }
}
```
Check the existing Help group first (`grep -n "CommandGroup" ShepherdApp.swift`) and extend it rather than replacing an existing one. No keyboard shortcut, so nothing is added to `ShortcutCatalog`.

- [ ] **Step 4: Launch reconcile and quit teardown**

In `AppDelegate.swift`:

```swift
func applicationDidFinishLaunching(_ n: Notification) {
    // ... existing body ...
    store?.onboarding?.reconcileAtLaunch()
    store?.onboarding?.startIfFirstRun()
}

func applicationWillTerminate(_ n: Notification) {
    store?.onboarding?.teardownNow()
}
```
`reconcileAtLaunch` must run **before** `startIfFirstRun`, or a fresh tour's sandbox is deleted the instant it is built. If `AppDelegate` has no `store` reference, add a `weak var store: AgentStore?` and assign it where the delegate is installed.

- [ ] **Step 5: Build and run the full suite**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -15
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  test -only-testing:ShepherdModelTests 2>&1 | tee /tmp/ob-all.log | tail -15
grep -c "Test Case .* failed" /tmp/ob-all.log
```
Expected: `** BUILD SUCCEEDED **`, `** TEST SUCCEEDED **`, 0 failures.

**Do not launch the app.** Report to the user that runtime verification is theirs, and list exactly what to check: the welcome card on a fresh profile, the arrow landing on the right elements, the two agent steps' idle-vs-done contrast, and that the sandbox and its worktree are gone afterward.

- [ ] **Step 6: Document it in `CLAUDE.md`**

Add to the app-source-files list:
```markdown
- **Onboarding (first run)** — `OnboardingPolicy.swift` (**pure**: the tour script as data + `steps(for:)` filtering on a `Preflight`, with substitute cards when Claude Code or the sandbox is missing), `OnboardingPlacement.swift` (**pure**: card origin + arrow edge, always on screen), `OnboardingDemoRepo.swift` (**pure** manifest + git shell: a bare origin *and* a clone under `~/.shepherd/demo`, because worktree creation fetches origin and aborts without it), `OnboardingController.swift` (`@MainActor` state machine; performs each step against the store; teardown on finish/skip/Esc/quit/launch-reconcile), `OnboardingOverlayView.swift` + `OnboardingWelcomeView.swift` + `OnboardingAnchorKey.swift` (the dim/spotlight/card/arrow, the plugin+notification+theme rows, and the `PreferenceKey` real views publish their bounds through). Auto-starts once per install (`shepherd.onboarding.completedVersion`, and only with no persisted workspaces); Help → *Shepherd Tour* replays it. In `ShepherdModelTests`. [Design](docs/superpowers/specs/2026-07-29-onboarding-flow-design.md).
```

Add to the gotchas list:
```markdown
- **The onboarding overlay is deliberately *not* a full-takeover overlay.** `isFrontPane` excludes panes hidden behind the workbench or code surface; the tour's card sits over a genuinely visible terminal, so adding it there would break the two steps the whole tour is built around — one turn finishing while you watch (lands `idle`) versus the same turn finishing while focus is elsewhere (lands `needsCheck`, badge, notification). Per ADR 0020 viewing is one predicate; don't add a second. Related: the tour waits on `StateTransition.turnFinished`, never `state == .needsCheck`, which by design never occurs for the watched step.
- **The onboarding sandbox needs a bare origin, not just `git init`.** `WorktreeService` runs `git fetch origin` and aborts the whole worktree creation if it fails, then reads `refs/remotes/origin/HEAD`. So `~/.shepherd/demo` holds `origin.git` *and* `tour-repo`. Its git calls also pass `-c user.name/-c user.email/-c commit.gpgsign=false` per-command: an unset `user.name` fails the build and GPG signing blocks it on a passphrase prompt with no UI to answer.
- **Onboarding teardown must precede `persist()`**, or the demo workspace, its cwds and a live Claude `sessionID` land in `shepherd.workspaces.v1` and get `--resume`d next launch into a directory that no longer exists. It also `git worktree remove`s the tour's worktree, which lives under `~/.shepherd/worktrees/tour-repo/` — *outside* the demo dir, so `rm -rf ~/.shepherd/demo` alone leaves a stale registration.
```

Add to **Done**: `**onboarding** (first-run welcome + a real local git sandbox + a linear coach-mark tour that performs what it describes, torn down on exit)`.

- [ ] **Step 7: Commit**

```bash
git add spike/seam1/Sources/ContentView.swift \
        spike/seam1/Sources/ShepherdApp.swift \
        spike/seam1/Sources/AppDelegate.swift \
        CLAUDE.md
git commit -F - <<'EOF'
feat(onboarding): wire the tour to first launch, the Help menu and quit

Launch reconcile runs before the first-run check, or a fresh tour deletes the
sandbox it just built.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Self-review notes

**Spec coverage:** §3 files → Tasks 1–7 (one each). §3.2 anchoring → Task 4. §3.3 trigger → Task 7 `startIfFirstRun` + Task 8 menu. §4 sandbox → Task 3. §5 step script → Task 1. §5.1 the two agent steps → Task 7 `promptWatched`/`promptUnwatched` + the `turnFinished` wiring. §6 degrading → Task 1 (`steps(for:)`, substitute cards) and Task 5 (missing anchor → centered). §7.1 no Back → Task 7 (`advance` only). §7.2 not a takeover overlay → Task 8 Step 2 comment + the CLAUDE.md gotcha. §7.3 scoped mutations → Task 7 (`demoPane`, workspace-scoped calls only). §7.4 resolve `claude` → Task 7 `resolve(_:)`. §7.5 five teardown paths → Task 7 (`finish`, `skip`, `reconcileAtLaunch`) + Task 8 (`applicationWillTerminate`); Esc is Task 5's `escHandler` → `skip()`. §7.6 backdrop swallows clicks → Task 5 `backdrop`. §8 tests → Tasks 1–3.

**Known soft spots**, flagged rather than hidden:

1. **Tasks 4–7 cannot each end on a green build.** Task 4 references `store.onboarding` before Task 7 creates it, and Task 5/6 reference `OnboardingController`. They are ordered so Task 7 Step 5 is the first green build, and Task 4 Step 4 gives an interim compile check. Treat 4–7 as one review gate.
2. **Three names in Task 7 are written from greps, not from reading the functions:** `AgentStore.reloadConfigFromDisk()`, `WorktreeService.configuredBase()`, `AgentStore.persist()`'s access level. Task 7 Step 2 is explicitly the reconciliation step for these.
3. **`Theme.accent`, `Theme.stateIdle`, `Theme.stateError` and `ConfigEdit`'s initialiser** are likewise assumed; Task 5 Step 2 and Task 6 Step 3 verify them before building.
4. **`estimatedHeight` in Task 5 approximates the card height** for placement, since placement must happen before layout. Over-estimating only widens the gap to the anchor, so it degrades gracefully — but expect the user to report arrow gaps as a polish follow-up.
5. **No unit test covers `OnboardingController`.** It is a `@MainActor` shell over `AgentStore`, and the testable decisions were pushed into `OnboardingPolicy` (Task 1) on purpose. Its correctness rests on compile plus the user's runtime pass.
6. **`WorktreeService.newWorktreeTab` surfaces git errors via an alert**; a failure at Task 7's `addWorktreeTab` shows that alert over the tour card. Acceptable for v1 — the sandbox is built to make it succeed.
