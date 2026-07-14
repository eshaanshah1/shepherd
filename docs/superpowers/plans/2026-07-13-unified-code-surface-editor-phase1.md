# Unified Code Surface — Phase 1: Editor Foundation (Edit Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed a native `CodeEditSourceEditor` in Shepherd as an overlay so you can open a file (`⌘O`), edit it with tree-sitter syntax highlighting, and save (`⌘S`) — the "minor edits" half of the code surface.

**Architecture:** A transient overlay over the content area (same presentation model as the diff panel), rendered by one wrapped editor component (`CodeSurfaceView`). A pure `CodeSurfaceState` model holds mode/target/file/dirty. This phase ships edit mode only; diff-mode rendering and the comment overlay layer are Phase 2 (spike-gated on the geometry/decoration wiring proven here).

**Tech Stack:** Swift, SwiftUI/AppKit, `CodeEditSourceEditor` (SPM), `CodeEditLanguages` (`CodeLanguage`), xcodegen, xcodebuild.

**Spec:** [`../specs/2026-07-13-unified-code-surface-editor-design.md`](../specs/2026-07-13-unified-code-surface-editor-design.md)

## Global Constraints

- Stay native Swift + libghostty. No Rust/Electron/web runtime.
- Deployment target stays **macOS 13.0** — CESE declares `platforms: [.macOS(.v13)]`, so no bump.
- Pin CESE to commit **`1fa4d3c`** (2025-12-31); pin `CodeEditLanguages` **exact `0.1.20`** (the version CESE itself requires — avoids resolution conflict).
- All CESE use goes through `CodeSurfaceView` so the library is swappable.
- Build: from `spike/seam1`, run `xcodegen generate` after any file/target change, then the CLAUDE.md build command. **Never `killall`/relaunch Shepherd** (it is the user's daily driver) — AppKit/view tasks are verified by a green build; the user does the runtime check.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- App target globs `Sources/` (new source files auto-compile after `xcodegen generate`). The `ShepherdModelTests` target lists sources **explicitly** — a new pure file tested there must be added to its `sources:` list.

**Note:** CESE ships a SwiftLint build-tool plugin, so all `xcodebuild` invocations
need `-skipPackagePluginValidation` (else non-interactive builds fail at the plugin
trust gate). The repo's `CLAUDE.md` manual build command needs this flag added too.

**Build command (referenced as `BUILD` below), run from `spike/seam1`:**
```sh
xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache -skipPackagePluginValidation build
```
**Test command (`TEST`), run from `spike/seam1`:** (model tests run through the
`Shepherd` scheme's test action — there is no standalone `ShepherdModelTests` scheme;
`-only-testing` scopes to the pure-model bundle)
```sh
xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -skipPackagePluginValidation -only-testing:ShepherdModelTests test
```

---

### Task 1: Add the CodeEditSourceEditor dependency

**Files:**
- Modify: `spike/seam1/project.yml` (`packages:` map, and the `Shepherd` target `dependencies:`)

**Interfaces:**
- Produces: the `CodeEditSourceEditor` and `CodeEditLanguages` modules become importable in the app target.

- [ ] **Step 1: Add the two packages to `project.yml`**

Under the existing `packages:` map (which currently holds `Highlighter`), add:
```yaml
  CodeEditSourceEditor:
    url: https://github.com/CodeEditApp/CodeEditSourceEditor
    revision: 1fa4d3c
  CodeEditLanguages:
    url: https://github.com/CodeEditApp/CodeEditLanguages
    exact: 0.1.20
```

- [ ] **Step 2: Link both products in the `Shepherd` target**

In `targets: Shepherd: dependencies:`, after `- package: Highlighter`, add:
```yaml
      - package: CodeEditSourceEditor
        product: CodeEditSourceEditor
      - package: CodeEditLanguages
        product: CodeEditLanguages
```

- [ ] **Step 3: Resolve + build**

Run `BUILD`.
Expected: SPM resolves CESE + transitive deps (CodeEditTextView, CodeEditSymbols, TextFormation) and the app builds green (nothing uses the modules yet). First resolve may take a few minutes.

- [ ] **Step 4: Commit**

```sh
git add spike/seam1/project.yml
git commit -m "build: add CodeEditSourceEditor dependency (pinned)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `CodeSurfaceState` pure model (TDD)

**Files:**
- Create: `spike/seam1/Sources/CodeSurfaceState.swift`
- Create: `spike/seam1/Tests/CodeSurfaceStateTests.swift`
- Modify: `spike/seam1/project.yml` (`ShepherdModelTests` sources list)

**Interfaces:**
- Produces:
  - `struct CodeSurfaceState: Equatable` with `var mode: Mode`, `var targetPaneID: String?`, `var filePath: String?`, `var isDirty: Bool`
  - `enum Mode: Equatable { case edit, diff }`
  - `static func editing(_ path: String, pane: String?) -> CodeSurfaceState`
  - `mutating func markDirty()`, `mutating func clearDirty()`
  - `var displayName: String` (file's last path component, or "Untitled")

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/CodeSurfaceStateTests.swift`:
```swift
import XCTest
@testable import Shepherd

final class CodeSurfaceStateTests: XCTestCase {
    func testEditingFactorySetsFields() {
        let s = CodeSurfaceState.editing("/tmp/foo/bar.swift", pane: "p1")
        XCTAssertEqual(s.mode, .edit)
        XCTAssertEqual(s.filePath, "/tmp/foo/bar.swift")
        XCTAssertEqual(s.targetPaneID, "p1")
        XCTAssertFalse(s.isDirty)
        XCTAssertEqual(s.displayName, "bar.swift")
    }

    func testDirtyToggles() {
        var s = CodeSurfaceState.editing("/tmp/x.txt", pane: nil)
        s.markDirty()
        XCTAssertTrue(s.isDirty)
        s.clearDirty()
        XCTAssertFalse(s.isDirty)
    }

    func testDisplayNameFallsBackToUntitled() {
        let s = CodeSurfaceState(mode: .edit, targetPaneID: nil, filePath: nil, isDirty: false)
        XCTAssertEqual(s.displayName, "Untitled")
    }
}
```

- [ ] **Step 2: Add the test + source to the model test target**

In `project.yml` under `ShepherdModelTests: sources:`, add (before the `- path: Tests` glob line if present, otherwise anywhere in the list):
```yaml
      - path: Sources/CodeSurfaceState.swift
```
(`Tests/` is already globbed, so the new test file needs no entry.)

- [ ] **Step 3: Run the test to verify it fails**

Run `TEST`.
Expected: FAIL — `cannot find 'CodeSurfaceState' in scope`.

- [ ] **Step 4: Write the minimal implementation**

Create `spike/seam1/Sources/CodeSurfaceState.swift`:
```swift
import Foundation

/// Transient state of the code surface overlay. Pure model (no AppKit).
struct CodeSurfaceState: Equatable {
    enum Mode: Equatable { case edit, diff }

    var mode: Mode
    var targetPaneID: String?
    var filePath: String?
    var isDirty: Bool

    static func editing(_ path: String, pane: String?) -> CodeSurfaceState {
        CodeSurfaceState(mode: .edit, targetPaneID: pane, filePath: path, isDirty: false)
    }

    mutating func markDirty() { isDirty = true }
    mutating func clearDirty() { isDirty = false }

    var displayName: String {
        guard let filePath, !filePath.isEmpty else { return "Untitled" }
        return (filePath as NSString).lastPathComponent
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run `TEST`.
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```sh
git add spike/seam1/Sources/CodeSurfaceState.swift spike/seam1/Tests/CodeSurfaceStateTests.swift spike/seam1/project.yml
git commit -m "feat(code-surface): pure CodeSurfaceState model

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `CodeSurfaceView` — edit-mode editor wrapper + theme

**Files:**
- Create: `spike/seam1/Sources/CodeSurfaceView.swift`

**Interfaces:**
- Consumes: `Theme` color tokens (`Theme.ground`, `.raised`, `.textPrimary`, `.working`, etc. — but as `NSColor`, via the local `NSColor(hex:)` helper below).
- Produces: `struct CodeSurfaceView: View` with `init(filePath: String, onDirty: @escaping () -> Void, onSave: @escaping (String) -> Void)` and an imperatively-callable save via a bound `text`.

> This is an AppKit-integration task against the pinned CESE revision. The shape is fixed (text binding + detected language + config with theme/font + `isEditable` + state binding). If a sub-initializer label differs in revision `1fa4d3c`, adjust to what the compiler reports — do **not** change the shape.

- [ ] **Step 1: Write the view**

Create `spike/seam1/Sources/CodeSurfaceView.swift`:
```swift
import SwiftUI
import AppKit
import CodeEditSourceEditor
import CodeEditLanguages

/// Our seam around CodeEditSourceEditor. All editor use goes through here so the
/// underlying library stays swappable.
struct CodeSurfaceView: View {
    let filePath: String
    var onDirty: () -> Void
    var onSave: (String) -> Void

    @State private var text: String = ""
    @State private var editorState = SourceEditorState()

    private var language: CodeLanguage {
        CodeLanguage.detectLanguageFrom(url: URL(fileURLWithPath: filePath))
    }

    private var configuration: SourceEditorConfiguration {
        // Verified against pinned CESE: `appearance` is required (no empty init);
        // Appearance requires theme/font/wrapLines.
        SourceEditorConfiguration(
            appearance: .init(
                theme: shepherdEditorTheme,
                font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
                wrapLines: false
            ),
            behavior: .init(isEditable: true)
        )
    }

    var body: some View {
        SourceEditor(
            $text,
            language: language,
            configuration: configuration,
            state: $editorState
        )
        .onAppear { text = (try? String(contentsOfFile: filePath, encoding: .utf8)) ?? "" }
        .onChange(of: text) { _ in onDirty() }
        .onReceive(NotificationCenter.default.publisher(for: .shepherdSaveCodeSurface)) { _ in
            onSave(text)
        }
    }
}

extension Notification.Name {
    static let shepherdSaveCodeSurface = Notification.Name("shepherd.codeSurface.save")
}

/// Shepherd's editor theme, mirroring Theme.swift's palette (kept as NSColors here
/// because EditorTheme is AppKit).
private var shepherdEditorTheme: EditorTheme {
    func attr(_ hex: UInt32) -> EditorTheme.Attribute { .init(color: NSColor(hex: hex)) }
    return EditorTheme(
        text: attr(0xEDEDED),
        insertionPoint: NSColor(hex: 0xEDEDED),
        invisibles: attr(0x5F5F66),
        background: NSColor(hex: 0x0F0F11),
        lineHighlight: NSColor(hex: 0x1A1A1E),
        selection: NSColor(hex: 0x232327),
        keywords: attr(0xE5A23D),
        commands: attr(0x5B9DF8),
        types: attr(0x43C988),
        attributes: attr(0x8C8C92),
        variables: attr(0xEDEDED),
        values: attr(0x5B9DF8),
        numbers: attr(0x5B9DF8),
        strings: attr(0x43C988),
        characters: attr(0x43C988),
        comments: attr(0x5F5F66)
    )
}

private extension NSColor {
    convenience init(hex: UInt32) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}
```

- [ ] **Step 2: Build**

Run `BUILD`.
Expected: green. If `EditorTheme.Attribute` label, `SourceEditorConfiguration()` default init, or a color parameter name differs in the pinned revision, fix to the compiler-reported name (the shape stays). Common adjustment: `SourceEditorConfiguration` may require explicit sub-structs — construct `SourceEditorConfiguration(appearance:behavior:layout:peripherals:)` if the empty init is unavailable.

- [ ] **Step 3: Commit**

```sh
git add spike/seam1/Sources/CodeSurfaceView.swift
git commit -m "feat(code-surface): CodeSurfaceView edit-mode wrapper over CodeEditSourceEditor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Wire edit mode into the app (store + overlay + ⌘O/⌘S/Esc)

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift` (add surface state + open/save/close)
- Modify: `spike/seam1/Sources/ContentView.swift` (present the overlay)
- Modify: `spike/seam1/Sources/ShepherdApp.swift` (menu commands / keybindings)

**Interfaces:**
- Consumes: `CodeSurfaceState` (Task 2), `CodeSurfaceView` (Task 3), existing `store.selectedTab?.focusedPaneID`, existing `Pane.cwd`.
- Produces: `AgentStore.openFile(_ path: String)`, `AgentStore.saveCodeSurface(_ text: String)`, `AgentStore.closeCodeSurface()`, `@Published var codeSurface: CodeSurfaceState?`.

- [ ] **Step 1: Add surface state + actions to `AgentStore`**

Near the existing `@Published var diffPanelOpen` / `diffPanelPaneID` (around `AgentStore.swift:32`), add:
```swift
    @Published var codeSurface: CodeSurfaceState? = nil

    func openFile(_ path: String) {
        codeSurface = .editing(path, pane: selectedTab?.focusedPaneID)
    }

    func closeCodeSurface() { codeSurface = nil }

    func saveCodeSurface(_ text: String) {
        guard let path = codeSurface?.filePath else { return }
        try? text.write(toFile: path, atomically: true, encoding: .utf8)
        codeSurface?.clearDirty()
    }
```

- [ ] **Step 2: Present the overlay in `ContentView`**

In `ContentView.swift`, next to the existing diff overlay block (`if store.diffPanelOpen { DiffPanelView() }`, around line 30), add a sibling:
```swift
                    if let surface = store.codeSurface {
                        CodeSurfaceView(
                            filePath: surface.filePath ?? "",
                            onDirty: { store.codeSurface?.markDirty() },
                            onSave: { store.saveCodeSurface($0) }
                        )
                        .transition(.opacity)
                    }
```
And add `store.codeSurface` to the existing `.animation(...)` value list (line ~47) so it fades like the diff panel:
```swift
        .animation(.easeOut(duration: 0.16), value: store.diffPanelOpen)
        .animation(.easeOut(duration: 0.16), value: store.codeSurface != nil)
```

- [ ] **Step 3: Add `⌘O` / `⌘S` / `Esc` commands in `ShepherdApp`**

In `ShepherdApp.swift` near the existing "Review Diff" button (line ~75), add:
```swift
                Button("Open File…") {
                    let panel = NSOpenPanel()
                    panel.canChooseFiles = true
                    panel.canChooseDirectories = false
                    panel.allowsMultipleSelection = false
                    if let cwd = AgentStore.shared.selectedTab?.root.pane(AgentStore.shared.selectedTab?.focusedPaneID ?? "")?.cwd {
                        panel.directoryURL = URL(fileURLWithPath: cwd)
                    }
                    if panel.runModal() == .OK, let url = panel.url {
                        AgentStore.shared.openFile(url.path)
                    }
                }
                .keyboardShortcut("o", modifiers: .command)

                Button("Save") {
                    NotificationCenter.default.post(name: .shepherdSaveCodeSurface, object: nil)
                }
                .keyboardShortcut("s", modifiers: .command)
                .disabled(AgentStore.shared.codeSurface == nil)
```
For `Esc` to dismiss: in the `CodeSurfaceView` overlay in `ContentView` (Step 2), add after `.transition`:
```swift
                        .background(KeyCatcher { store.closeCodeSurface() })
```
If no `KeyCatcher` helper exists in the codebase, dismiss via a small close button in the overlay instead (a `Button` calling `store.closeCodeSurface()`); do not add a new global `Esc` monitor that could steal keys from the PTY (ADR 0009).

- [ ] **Step 4: Build**

Run `BUILD`.
Expected: green.

- [ ] **Step 5: Runtime verification (deferred to the user — do NOT relaunch Shepherd)**

Report to the reviewer: build is green; please, in your next Shepherd session, press `⌘O`, pick a source file, confirm it opens with syntax highlighting, edit + `⌘S`, and confirm the file changed on disk. (Automated/unit verification is not possible for the AppKit surface; the model + build are the machine-checkable gates.)

- [ ] **Step 6: Commit**

```sh
git add spike/seam1/Sources/AgentStore.swift spike/seam1/Sources/ContentView.swift spike/seam1/Sources/ShepherdApp.swift
git commit -m "feat(code-surface): edit-mode overlay wired to ⌘O/⌘S/dismiss

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 2 (separate plan — write after Task 3 lands)

Not in this plan; captured so it is not lost. Written once `CodeSurfaceView` proves the wiring to reach the underlying `TextViewController.textView.layoutManager.rectForOffset(_:)` (via a `TextViewCoordinator` or a held controller ref) and how to apply per-line decoration:
1. **Comment overlay layer** — `CommentLayer` positioning `CommentBubble`/`CommentComposer` by line geometry; collapsed-to-icon, expand-on-hover/focus (per spec §4).
2. **Diff mode in CESE** — render the unified diff as a read-only decorated buffer; click a hunk → open editable.
3. **Fold the diff overlay into the code surface** and re-home `submitReview` → the comment layer, retiring `DiffPanelView`'s bespoke row renderer.

## Self-Review

- **Spec coverage:** Phase 1 covers spec §2 (overlay), §3 (one renderer, edit mode), §5 (open/save/dismiss), §6 (unaffected systems — nothing here touches panes/state/attention/remote), §7 (transient state, no layout persistence), §10 (native decision recorded in spec). Spec §4 (comments) and the diff half of §3 are explicitly Phase 2 — flagged above, not dropped.
- **Placeholder scan:** none — every code step carries complete code; the two adjustment notes (Task 3 Step 2, Task 4 Step 3) name the exact fallback, not a vague "handle it."
- **Type consistency:** `CodeSurfaceState`/`.editing`/`markDirty`/`clearDirty`/`filePath` used identically in Tasks 2 and 4; `.shepherdSaveCodeSurface` notification defined in Task 3, posted in Task 4; `openFile`/`saveCodeSurface`/`closeCodeSurface`/`codeSurface` consistent across store, view, and app.
