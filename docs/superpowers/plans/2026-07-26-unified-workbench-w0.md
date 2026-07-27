# Unified Workbench W0 (Editor Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor the CodeEdit text stack into Shepherd and build the block-decoration, excerpt, gutter, and theme-derivation layers on it, then re-render the existing diff review panel on that engine — so every code surface shares one tokenizer, one layout engine, and one palette.

**Architecture:** `CodeEditTextView` + `CodeEditSourceEditor` move in-tree as first-class Shepherd source (their third-party dependencies stay as SPM packages). Four pure models (`StitchMap`, `BlockMap`, `WordDiff`, `LockPolicy`) carry the logic and are unit-tested; four AppKit units (`BlockRenderer`, `DiffGutter`, `MultiHighlighter`, `EditorHost`) render it. W0 ends by deleting `DiffPanelView` and the HighlighterSwift dependency, so the duplicated renderer cannot come back.

**Tech Stack:** Swift 5, SwiftUI + AppKit, xcodegen, vendored CodeEditTextView/CodeEditSourceEditor, CodeEditLanguages (tree-sitter), XCTest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-unified-workbench-design.md`. Every task's requirements implicitly include it.
- Deployment target macOS 13.0; `SWIFT_VERSION: "5.0"`.
- **Run `xcodegen generate` after adding or removing ANY source file.** Otherwise the file is not compiled and you get `cannot find X in scope` at *build* time, not edit time.
- **Every new pure model must be added to `ShepherdModelTests`' explicit `sources:` list in `project.yml`.** Files under `Tests/` are picked up by the `- path: Tests` glob; compiled sources are not.
- **SourceKit lies in this repo.** "Cannot find type AgentState" and "'main' attribute" diagnostics are stale — the editor sees loose files, not the generated project. `xcodebuild` is ground truth.
- libghostty C API calls happen on the main thread.
- Pure models contain no AppKit import. That is what makes them testable.
- Never run `killall Shepherd` — the user runs Shepherd as their daily terminal. Verify by compile + unit tests; defer runtime checks to the user.
- Commit messages end with: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Build command (used by every task):
  ```bash
  cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
    -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
    CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
  ```
- Test command:
  ```bash
  cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
    -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
    CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -30
  ```

## Spec correction applied by this plan

Spec §5.2 lists `PatchSynth` and `ConflictParse` among W0's new units, but their
only consumers are W1 (staging) and W3 (merge). Building them in W0 would be
speculative. **Task 0 moves them in the spec to W1 and W3 respectively.** They do
not appear in this plan.

## File structure

| File | Responsibility |
|---|---|
| `Sources/Editor/**` (new, vendored) | The text stack. Upstream layout preserved verbatim so future cherry-picks stay mechanical. |
| `Sources/Theme.swift` (modify) | Gains `Theme.Diff`, `Theme.lineHeightMultiple`, and the derivation chain. |
| `Sources/Workbench/StitchMap.swift` (new, pure) | Excerpt list; stitched-line ↔ source-line mapping. |
| `Sources/Workbench/BlockMap.swift` (new, pure) | Ordered non-text rows with heights. |
| `Sources/Workbench/WordDiff.swift` (new, pure) | Intra-line word spans over `SequenceAlign`. |
| `Sources/Workbench/LockPolicy.swift` (new, pure) | The live-follow / dirty-lock decision. |
| `Sources/Workbench/SourceBuffer.swift` (new) | One file: text, blobs, dirty, watcher, tree-sitter client. |
| `Sources/Workbench/BlockRenderer.swift` (new) | Render delegate + `LineFragmentView` subclass: row tints and block rows. |
| `Sources/Workbench/DiffGutter.swift` (new) | Stage checkbox, old line no, new line no, sign columns. |
| `Sources/Workbench/MultiHighlighter.swift` (new) | `HighlightProviding` fanning out per source file. |
| `Sources/Workbench/WorkbenchSession.swift` (new) | Per-pane state owner. |
| `Sources/Workbench/WorkbenchView.swift` (new) | Rail + `EditorHost` + `WidgetLayer` shell. |
| `Sources/DiffPanelView.swift` (delete, Task 10) | Replaced by `WorkbenchView`. |

---

### Task 0: Correct the spec's unit placement

**Files:**
- Modify: `docs/superpowers/specs/2026-07-26-unified-workbench-design.md`

**Interfaces:**
- Consumes: nothing
- Produces: nothing (documentation only)

- [ ] **Step 1: Move `PatchSynth` and `ConflictParse` out of W0**

In §5.2, delete these two bullets from the "Pure" list:

```markdown
- **`PatchSynth`** — synthesizes the unified patch for `git apply --cached` from
  a hunk or an arbitrary line selection. Line-level staging is this file plus a
  selection model.
- **`ConflictParse`** — reads `git ls-files -u` into `(base, ours, theirs)` stage
  triples. **Never** scrapes `<<<<<<<` markers.
```

Then add this paragraph immediately after the "Pure" list:

```markdown
`PatchSynth` (unified-patch synthesis for `git apply --cached`, from a hunk or an
arbitrary line selection) belongs to **W1**, and `ConflictParse` (reads
`git ls-files -u` into `(base, ours, theirs)` stage triples — never scrapes
`<<<<<<<` markers) belongs to **W3**. Both are pure and unit-tested when built;
neither has a W0 consumer, so building them here would be speculative.
```

- [ ] **Step 2: Fix the §8 test table**

Remove the `PatchSynthTests` and `ConflictParseTests` rows from the §8 table and
add this line below it:

```markdown
`PatchSynthTests` and `ConflictParseTests` arrive with W1 and W3 alongside the
units they cover.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-26-unified-workbench-design.md
git commit -m "$(cat <<'EOF'
docs(spec): move PatchSynth to W1 and ConflictParse to W3

Both were listed among W0's units but their only consumers are staging (W1)
and merge resolution (W3). Building them in W0 would be speculative.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1: Vendor the editor

Mechanical port. The deliverable is a green build and an app that behaves
identically — no new features. There is no test to write first; the existing
suite plus a successful build *is* the test, and it is a real one (24,000 lines
must compile in a new module context).

**Files:**
- Create: `spike/seam1/Sources/Editor/` (copied tree)
- Modify: `spike/seam1/project.yml`
- Modify: `spike/seam1/Sources/Shepherd-Bridging.h`

**Interfaces:**
- Consumes: nothing
- Produces: the `CodeEditTextView` and `CodeEditSourceEditor` types as members of the `Shepherd` module — `TextView`, `TextLayoutManager`, `TextLineStorage`, `LineFragment`, `LineFragmentView`, `TextLayoutManagerRenderDelegate`, `TextAttachment`, `SourceEditor`, `SourceEditorConfiguration`, `SourceEditorState`, `TextViewController`, `TextViewCoordinator`, `HighlightProviding`, `HighlightRange`, `EditorTheme`, `GutterView`

- [ ] **Step 1: Record the upstream commits so future ports have a baseline**

```bash
cd spike/seam1/build/SourcePackages/checkouts
for p in CodeEditTextView CodeEditSourceEditor; do
  echo "$p $(git -C $p rev-parse HEAD)"
done | tee /tmp/vendor-baseline.txt
```

Expected: two lines, each a repo name and a 40-char SHA. `CodeEditSourceEditor`
must read `1fa4d3c...` (the revision pinned in `project.yml`).

- [ ] **Step 2: Copy the sources in, preserving upstream layout**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1
mkdir -p Sources/Editor
cp -R build/SourcePackages/checkouts/CodeEditTextView/Sources/CodeEditTextView \
      Sources/Editor/CodeEditTextView
cp -R build/SourcePackages/checkouts/CodeEditTextView/Sources/CodeEditTextViewObjC \
      Sources/Editor/CodeEditTextViewObjC
cp -R build/SourcePackages/checkouts/CodeEditSourceEditor/Sources/CodeEditSourceEditor \
      Sources/Editor/CodeEditSourceEditor
cp /tmp/vendor-baseline.txt Sources/Editor/UPSTREAM-BASELINE.txt
find Sources/Editor -name "*.swift" | wc -l
```

Expected: a file count of roughly 200. Upstream's directory names are kept
deliberately — a future `diff -r` against a fresh checkout stays readable.

- [ ] **Step 3: Strip the now-invalid cross-module imports**

The three modules are one module now, so importing them fails.

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1
find Sources/Editor -name "*.swift" -print0 | xargs -0 sed -i '' \
  -e '/^import CodeEditTextView$/d' \
  -e '/^import CodeEditSourceEditor$/d' \
  -e '/^import CodeEditTextViewObjC$/d'
grep -rn "^import CodeEdit" Sources/Editor | wc -l
```

Expected: `0`.

- [ ] **Step 4: Route the ObjC symbol through the bridging header**

`CGContextHidden.h` declares `CGContextSetFontSmoothingStyle`. Two Swift files
used to reach it via `import CodeEditTextViewObjC`; they now need it visible
through the bridging header. Delete the modulemap (Xcode does not use it) and add
the import.

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1
rm -f Sources/Editor/CodeEditTextViewObjC/include/module.modulemap
```

Append to `Sources/Shepherd-Bridging.h`:

```objc
#import "CGContextHidden.h"
```

- [ ] **Step 5: Rewrite `project.yml` packages and add the header search path**

Replace the `packages:` block (lines 7–19) with:

```yaml
packages:
  Highlighter:
    url: https://github.com/smittytone/HighlighterSwift
    from: 3.1.0
  CodeEditLanguages:
    url: https://github.com/CodeEditApp/CodeEditLanguages
    exactVersion: 0.1.20
  CodeEditSymbols:
    url: https://github.com/CodeEditApp/CodeEditSymbols
    exactVersion: 0.2.3
  TextStory:
    url: https://github.com/ChimeHQ/TextStory
    from: 0.9.0
  TextFormation:
    url: https://github.com/ChimeHQ/TextFormation
    from: 0.8.2
  SwiftCollections:
    url: https://github.com/apple/swift-collections
    majorVersion: 1.0.0
  SwiftMarkdown:
    url: https://github.com/apple/swift-markdown
    from: 0.3.0
```

`CodeEditSourceEditor` is gone from `packages:`. `Highlighter` stays for now —
Task 10 removes it. `SwiftTreeSitter` is *not* listed: it arrives transitively
through `CodeEditLanguages`, which re-exports it.

- [ ] **Step 6: Point all four consuming targets at the new dependencies**

In the `Shepherd` and `ShepherdDev` targets, replace the two `CodeEditSourceEditor`
dependency lines with the new package products. Each target's `dependencies:` must
contain:

```yaml
      - package: Highlighter
      - package: CodeEditLanguages
        product: CodeEditLanguages
      - package: CodeEditSymbols
        product: CodeEditSymbols
      - package: TextStory
        product: TextStory
      - package: TextFormation
        product: TextFormation
      - package: SwiftCollections
        product: Collections
      - package: SwiftMarkdown
        product: Markdown
```

In `ShepherdModelTests`, replace its `dependencies:` block with the same list
minus `Highlighter`, and replace the stale comment above it:

```yaml
    # `@testable import Shepherd` pulls the app module's interface, which now
    # contains the vendored editor (Sources/Editor) — the test target must be able
    # to resolve the editor's own package dependencies.
    dependencies:
      - package: CodeEditLanguages
        product: CodeEditLanguages
      - package: CodeEditSymbols
        product: CodeEditSymbols
      - package: TextStory
        product: TextStory
      - package: TextFormation
        product: TextFormation
      - package: SwiftCollections
        product: Collections
      - package: SwiftMarkdown
        product: Markdown
```

- [ ] **Step 7: Set `SWIFT_PACKAGE_NAME` and the ObjC header path**

23 declarations in the vendored code use Swift's `package` access modifier
(`package(set) public var layoutManager`, `package(set) public var range`). Outside
a Swift package this errors with *"'package' modifier used without a package
name"* unless the target declares one.

Add both settings to the `base:` block under `settings:` at the top of
`project.yml` (line 21), so all targets inherit them:

```yaml
settings:
  base:
    SWIFT_VERSION: "5.0"
    SWIFT_PACKAGE_NAME: Shepherd
    HEADER_SEARCH_PATHS: $(SRCROOT)/Sources/Editor/CodeEditTextViewObjC/include
    CLANG_CXX_LANGUAGE_STANDARD: "gnu++20"
    OTHER_LDFLAGS: "-lstdc++"
    CODE_SIGN_IDENTITY: "-"
    CODE_SIGNING_REQUIRED: "NO"
    ENABLE_HARDENED_RUNTIME: "NO"
```

- [ ] **Step 8: Regenerate and build**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1
xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -40
```

Expected: `** BUILD SUCCEEDED **`.

Two failure modes to expect, with fixes:
- *"'package' modifier used without a package name"* → Step 7's `SWIFT_PACKAGE_NAME` did not apply. Confirm it landed in `settings.base`, not inside one target.
- *"'CGContextHidden.h' file not found"* → `HEADER_SEARCH_PATHS` is wrong. Verify `Sources/Editor/CodeEditTextViewObjC/include/CGContextHidden.h` exists.
- *Duplicate symbol / redeclaration* of a common name (e.g. `Theme`) → the vendored `EditorTheme` and Shepherd's `Theme` do not collide, but if any other name does, rename the **vendored** one and note it in `UPSTREAM-BASELINE.txt` so future ports know.

- [ ] **Step 9: Run the test suite to confirm nothing regressed**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -30
```

Expected: `** TEST SUCCEEDED **`, with the same test count as before this task.

- [ ] **Step 10: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd
git add spike/seam1/Sources/Editor spike/seam1/project.yml \
        spike/seam1/Sources/Shepherd-Bridging.h
git commit -m "$(cat <<'EOF'
feat(editor): vendor CodeEditTextView + CodeEditSourceEditor in-tree

24k lines of the CodeEdit text stack move into Sources/Editor as first-class
Shepherd source, keeping upstream's layout so future cherry-picks stay
mechanical (baseline SHAs in Sources/Editor/UPSTREAM-BASELINE.txt).

Needed because the workbench requires full-row block decorations and a
diff-aware gutter, neither reachable from outside the package: there is no
block API at all, and GutterView.drawLineNumbers is private.

Third-party deps stay as packages. SWIFT_PACKAGE_NAME is set so the 23
`package`-access declarations still compile, and the ObjC helper now routes
through Shepherd-Bridging.h.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

> **What Task 1 actually took (recorded after execution, `9e1abf7`).** The steps
> above were necessary but not sufficient. Six further problems surfaced, all of
> them things that cannot exist while the code is two modules:
>
> 1. **App-side imports.** Step 3 strips imports inside `Sources/Editor` only, but
>    `Sources/CodeSurfaceView.swift` also had `import CodeEditSourceEditor`. Strip
>    app-side imports of the vendored modules too (`CodeEditLanguages` stays).
> 2. **Duplicate filenames.** `NSRange+isEmpty.swift` and `TextView+Menu.swift`
>    exist in both modules; Xcode requires unique filenames per target. Deleted the
>    redundant `NSRange+isEmpty` (identical) and renamed the CESE menu file.
> 3. **`selectedRange`.** `TextInterface` needs `var selectedRange`,
>    `NSTextInputClient` needs `func selectedRange()` — legal on one type only
>    across a module boundary. `TextInterface` moved to a `TextViewInterface`
>    forwarder; **`TextStoring` had to stay on `TextView`**, because its protocol
>    extension supplies `insertString`/`replaceString` that the controller calls
>    directly (moving it too caused a second round of errors).
> 4. **`NSColor.init(hex:alpha:)`** declared in both modules — deleted CETV's copy.
> 5. **`Highlighter`.** CESE's internal class shadowed the HighlighterSwift
>    *module* of the same name, so app code could not name the package's type at all
>    (`Highlighter.Highlighter` is circular). Renamed to `SyntaxHighlighter`.
> 6. **`Emphasis`.** CETV's type shadowed `Markdown.Emphasis` in
>    `MarkdownDiffView.swift` — qualified the two call sites.
>
> Also: stale `.swiftmodule` artifacts from the pre-vendoring build sat in the
> module search path and produced a *misleading* `unable to resolve module
> dependency: 'CodeEditTextViewObjC'` that masked the real error. Delete
> `build/Build/Products/Debug/CodeEdit*.swiftmodule` and `build/ModuleCache*`
> before trusting any failure here.
>
> And note for later tasks: **BSD `sed` does not support `\b`.** Use `[[:<:]]` /
> `[[:>:]]`. Two rename passes silently matched nothing before this was spotted.

---

### Task 2: Theme derivation chain and `Theme.Diff`

**Files:**
- Modify: `spike/seam1/Sources/Theme.swift`
- Create: `spike/seam1/Tests/ThemeDerivationTests.swift`
- Modify: `spike/seam1/project.yml` (nothing — `Theme.swift` is already in the test target)

**Interfaces:**
- Consumes: `Theme.pickHex(dark:light:warm:)`, `Theme.mode`, `ThemeMode` (existing)
- Produces:
  - `Theme.lineHeightMultiple: CGFloat` (== `1.5`)
  - `enum Theme.Diff` with `static var addition/deletion/modified/buffer/hover/separator/gutterFg/wordAdd/wordDel: UInt32`
  - `Theme.derivedTokens(for mode: ThemeMode) -> [String: UInt32]` — every derived token keyed by name, for the completeness test

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/ThemeDerivationTests.swift`:

```swift
import XCTest
@testable import Shepherd

/// The derivation chain's guarantee, made executable: every theme yields a
/// complete token set, diff colors are independent of the state-dot colors, and
/// the shared line height is the one number both the diff and the editor read.
final class ThemeDerivationTests: XCTestCase {
    private let allModes: [ThemeMode] = [.dark, .light, .warm]

    override func tearDown() {
        Theme.mode = .dark
        super.tearDown()
    }

    func testEveryModeDerivesACompleteTokenSet() {
        for mode in allModes {
            let tokens = Theme.derivedTokens(for: mode)
            XCTAssertFalse(tokens.isEmpty, "\(mode) derived no tokens")
            for (name, value) in tokens {
                XCTAssertTrue(value <= 0xFFFFFF, "\(mode).\(name) is not a 24-bit RGB value")
            }
        }
    }

    func testAllModesDeriveTheSameTokenNames() {
        let names = allModes.map { Set(Theme.derivedTokens(for: $0).keys) }
        for (idx, set) in names.enumerated().dropFirst() {
            XCTAssertEqual(set, names[0],
                           "\(allModes[idx]) has a different token set than .dark — a hole in the chain")
        }
    }

    func testDiffColorsAreNotTheStateColors() {
        // The bug this fixes: "line added" green was literally Theme.needsCheck,
        // the same green as "agent is done".
        for mode in allModes {
            Theme.mode = mode
            XCTAssertNotEqual(Theme.Diff.addition, Theme.Code.string,
                              "\(mode): diff addition collides with the syntax string color")
            XCTAssertNotEqual(Theme.Diff.deletion, Theme.Diff.addition,
                              "\(mode): addition and deletion are the same color")
            XCTAssertNotEqual(Theme.Diff.modified, Theme.Diff.addition,
                              "\(mode): modified and addition are the same color")
        }
    }

    func testLineHeightIsSharedAndMatchesTheSpec() {
        XCTAssertEqual(Theme.lineHeightMultiple, 1.5, accuracy: 0.0001)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | grep -E "error:|Diff|derivedTokens" | head
```

Expected: compile errors — `type 'Theme' has no member 'Diff'`, `no member 'derivedTokens'`, `no member 'lineHeightMultiple'`.

- [ ] **Step 3: Add the tokens and the derivation entry point**

Insert into `Sources/Theme.swift`, immediately after the closing brace of `enum Code` (currently line 106):

```swift
    /// Diff colors, deliberately independent of the state-dot ramp. Reusing
    /// `needsCheck`/`error` made "line added" the same green as "agent is done".
    enum Diff {
        static var addition  : UInt32 { pickHex(dark: 0x3FB950, light: 0x1A7F37, warm: 0x5C8A2E) }
        static var deletion  : UInt32 { pickHex(dark: 0xF85149, light: 0xCF222E, warm: 0xA83A2C) }
        static var modified  : UInt32 { pickHex(dark: 0x58A6FF, light: 0x0969DA, warm: 0x3F6E91) }
        static var buffer    : UInt32 { pickHex(dark: 0x161619, light: 0xF6F6F4, warm: 0xF5EEDC) }
        static var hover     : UInt32 { pickHex(dark: 0x1F1F24, light: 0xEAEAE7, warm: 0xE8DFC7) }
        static var separator : UInt32 { pickHex(dark: 0x232327, light: 0xDEDEDA, warm: 0xC9BFA8) }
        static var gutterFg  : UInt32 { pickHex(dark: 0x5F5F66, light: 0x9A9AA2, warm: 0xA39A86) }
        static var wordAdd   : UInt32 { pickHex(dark: 0x2B5B33, light: 0xAEE0B8, warm: 0xC3D6A4) }
        static var wordDel   : UInt32 { pickHex(dark: 0x6E2B28, light: 0xF3B7B3, warm: 0xE0B4AA) }
    }

    /// Shared row rhythm. The editor, the diff, and the gutter all read this —
    /// its absence is why `DiffMetrics.rowPad` had to exist.
    static let lineHeightMultiple: CGFloat = 1.5

    /// Every derived token for a mode, keyed by name. Exists so a test can assert
    /// the chain has no holes in any theme.
    static func derivedTokens(for mode: ThemeMode) -> [String: UInt32] {
        let previous = self.mode
        self.mode = mode
        defer { self.mode = previous }
        return [
            "code.text": Code.text, "code.comment": Code.comment,
            "code.keyword": Code.keyword, "code.string": Code.string,
            "code.number": Code.number, "code.type": Code.type,
            "code.function": Code.function, "code.variable": Code.variable,
            "code.builtin": Code.builtin,
            "diff.addition": Diff.addition, "diff.deletion": Diff.deletion,
            "diff.modified": Diff.modified, "diff.buffer": Diff.buffer,
            "diff.hover": Diff.hover, "diff.separator": Diff.separator,
            "diff.gutterFg": Diff.gutterFg,
            "diff.wordAdd": Diff.wordAdd, "diff.wordDel": Diff.wordDel,
        ]
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -20
```

Expected: `** TEST SUCCEEDED **`, four new tests passing.

- [ ] **Step 5: Point the editor theme at the shared line height**

In `Sources/CodeSurfaceView.swift`, the `shepherdEditorTheme` background is a
hardcoded hex. Replace the `background:` line inside `EditorTheme(` with:

```swift
        background: NSColor(hex: Theme.pickHex(dark: 0x0F0F11, light: 0xFBFBF9, warm: 0xFAF4E6)),
```

...to:

```swift
        background: NSColor(hex: Theme.Diff.buffer),
```

Then in both `CodeEditorView.configuration` and `CodeFieldView.configuration`, add
`lineHeightMultiple` to the appearance initializer so the editor reads the shared
token:

```swift
            appearance: .init(
                theme: shepherdEditorTheme,
                font: editorFont,
                lineHeightMultiple: Theme.lineHeightMultiple,
                wrapLines: Theme.editorWrapLines
            ),
```

- [ ] **Step 6: Build to confirm the editor still compiles**

```bash
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -10
```

Expected: `** BUILD SUCCEEDED **`. If `lineHeightMultiple` is not a parameter of
the vendored `SourceEditorConfiguration.Appearance`, check its actual label in
`Sources/Editor/CodeEditSourceEditor/SourceEditorConfiguration/` and use that.

- [ ] **Step 7: Commit**

```bash
git add spike/seam1/Sources/Theme.swift spike/seam1/Sources/CodeSurfaceView.swift \
        spike/seam1/Tests/ThemeDerivationTests.swift
git commit -m "$(cat <<'EOF'
feat(theme): add Theme.Diff tokens and a shared line-height multiple

Diff colors were derived from the state-dot ramp, so "line added" green was
literally the same green as "agent is done". Theme.Diff makes them independent.

Theme.lineHeightMultiple (1.5) becomes the one row rhythm the editor, the diff,
and the gutter all read — the number whose absence forced DiffMetrics.rowPad.

ThemeDerivationTests asserts every mode derives an identical, complete token
set, so a theme can't ship with a hole.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `StitchMap`

The excerpt model: which slices of which files appear, in what order, and how a
stitched line number maps to a source line and back. Line-based on purpose —
byte offsets are the AppKit layer's job, and lines are what tests can read.

**Files:**
- Create: `spike/seam1/Sources/Workbench/StitchMap.swift`
- Create: `spike/seam1/Tests/StitchMapTests.swift`
- Modify: `spike/seam1/project.yml`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `struct SourceID: Hashable` — `init(_ path: String)`, `var path: String`
  - `enum ExcerptKind: Equatable` — `.context`, `.hunk`, `.conflict`
  - `struct Excerpt: Equatable, Identifiable` — `id: String`, `source: SourceID`, `lineRange: Range<Int>`, `kind: ExcerptKind`
  - `struct StitchMap: Equatable` — `init(excerpts: [Excerpt])`, `var excerpts: [Excerpt]`, `var totalLines: Int`, `func sourceLocation(atStitchedLine:) -> (source: SourceID, line: Int)?`, `func stitchedLine(for:line:) -> Int?`, `func excerpt(atStitchedLine:) -> Excerpt?`, `mutating func applyEdit(in:atLine:lineDelta:)`

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/StitchMapTests.swift`:

```swift
import XCTest
@testable import Shepherd

final class StitchMapTests: XCTestCase {
    private let fileA = SourceID("A.swift")
    private let fileB = SourceID("B.swift")

    /// A.swift lines 10..<13 then B.swift lines 0..<2 → 5 stitched lines.
    private func twoFileMap() -> StitchMap {
        StitchMap(excerpts: [
            Excerpt(id: "a1", source: fileA, lineRange: 10..<13, kind: .hunk),
            Excerpt(id: "b1", source: fileB, lineRange: 0..<2, kind: .hunk),
        ])
    }

    func testTotalLinesIsTheSumOfExcerptLengths() {
        XCTAssertEqual(twoFileMap().totalLines, 5)
    }

    func testStitchedLineMapsToSourceLocation() {
        let map = twoFileMap()
        XCTAssertEqual(map.sourceLocation(atStitchedLine: 0)?.line, 10)
        XCTAssertEqual(map.sourceLocation(atStitchedLine: 2)?.line, 12)
        XCTAssertEqual(map.sourceLocation(atStitchedLine: 0)?.source, fileA)
        // Line 3 crosses into the second excerpt.
        XCTAssertEqual(map.sourceLocation(atStitchedLine: 3)?.source, fileB)
        XCTAssertEqual(map.sourceLocation(atStitchedLine: 3)?.line, 0)
        XCTAssertEqual(map.sourceLocation(atStitchedLine: 4)?.line, 1)
    }

    func testOutOfRangeStitchedLineReturnsNil() {
        XCTAssertNil(twoFileMap().sourceLocation(atStitchedLine: 5))
        XCTAssertNil(twoFileMap().sourceLocation(atStitchedLine: -1))
    }

    func testMappingRoundTripsBothWays() {
        let map = twoFileMap()
        for stitched in 0..<map.totalLines {
            let loc = map.sourceLocation(atStitchedLine: stitched)
            XCTAssertNotNil(loc, "line \(stitched) did not map")
            guard let loc else { continue }
            XCTAssertEqual(map.stitchedLine(for: loc.source, line: loc.line), stitched)
        }
    }

    func testStitchedLineForSourceLineOutsideAnyExcerptIsNil() {
        // A.swift line 5 is not shown — only 10..<13 is.
        XCTAssertNil(twoFileMap().stitchedLine(for: fileA, line: 5))
    }

    func testExcerptLookupIdentifiesTheOwningExcerpt() {
        let map = twoFileMap()
        XCTAssertEqual(map.excerpt(atStitchedLine: 1)?.id, "a1")
        XCTAssertEqual(map.excerpt(atStitchedLine: 4)?.id, "b1")
    }

    func testInsertingLinesGrowsTheEditedExcerpt() {
        var map = twoFileMap()
        map.applyEdit(in: fileA, atLine: 11, lineDelta: 2)
        XCTAssertEqual(map.totalLines, 7)
        XCTAssertEqual(map.excerpts[0].lineRange, 10..<15)
    }

    func testInsertingLinesShiftsLaterExcerptsInTheSameFile() {
        var map = StitchMap(excerpts: [
            Excerpt(id: "a1", source: fileA, lineRange: 0..<2, kind: .hunk),
            Excerpt(id: "a2", source: fileA, lineRange: 50..<52, kind: .hunk),
        ])
        map.applyEdit(in: fileA, atLine: 1, lineDelta: 3)
        XCTAssertEqual(map.excerpts[0].lineRange, 0..<5, "edited excerpt grows")
        XCTAssertEqual(map.excerpts[1].lineRange, 53..<55, "later excerpt slides down")
    }

    func testEditInOneFileLeavesOtherFilesAlone() {
        var map = twoFileMap()
        map.applyEdit(in: fileA, atLine: 11, lineDelta: 4)
        XCTAssertEqual(map.excerpts[1].lineRange, 0..<2, "B.swift must not move")
    }

    func testDeletingLinesShrinksTheExcerpt() {
        var map = twoFileMap()
        map.applyEdit(in: fileA, atLine: 11, lineDelta: -1)
        XCTAssertEqual(map.excerpts[0].lineRange, 10..<12)
        XCTAssertEqual(map.totalLines, 4)
    }

    func testAnEmptyMapMapsNothing() {
        let map = StitchMap(excerpts: [])
        XCTAssertEqual(map.totalLines, 0)
        XCTAssertNil(map.sourceLocation(atStitchedLine: 0))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | grep "error:" | head
```

Expected: `cannot find 'SourceID' in scope`, `cannot find 'Excerpt' in scope`, `cannot find 'StitchMap' in scope`.

- [ ] **Step 3: Write the implementation**

Create `spike/seam1/Sources/Workbench/StitchMap.swift`:

```swift
import Foundation

/// A file participating in a stitched multibuffer, identified by absolute path.
struct SourceID: Hashable {
    let path: String
    init(_ path: String) { self.path = path }
}

/// Why a slice of a file is on screen. `.context` is unchanged surrounding code,
/// `.hunk` is changed code, `.conflict` is an unresolved merge region.
enum ExcerptKind: Equatable { case context, hunk, conflict }

/// One contiguous slice of one file. `lineRange` is 0-based source line indices.
struct Excerpt: Equatable, Identifiable {
    let id: String
    let source: SourceID
    var lineRange: Range<Int>
    let kind: ExcerptKind
}

/// The multibuffer's excerpt list plus bidirectional line mapping. Pure: byte
/// offsets and layout belong to the AppKit layer, which reads this.
///
/// Excerpt order is presentation order and is preserved exactly as given —
/// callers decide grouping (by directory, by staged/unstaged), not this type.
struct StitchMap: Equatable {
    private(set) var excerpts: [Excerpt]

    init(excerpts: [Excerpt]) { self.excerpts = excerpts }

    var totalLines: Int { excerpts.reduce(0) { $0 + $1.lineRange.count } }

    /// The (file, source line) a stitched line shows, or nil if out of range.
    func sourceLocation(atStitchedLine line: Int) -> (source: SourceID, line: Int)? {
        guard line >= 0 else { return nil }
        var cursor = 0
        for e in excerpts {
            let count = e.lineRange.count
            if line < cursor + count {
                return (e.source, e.lineRange.lowerBound + (line - cursor))
            }
            cursor += count
        }
        return nil
    }

    /// Where a source line appears in the stitched document, or nil if it isn't
    /// shown. The first matching excerpt wins when a line appears twice.
    func stitchedLine(for source: SourceID, line: Int) -> Int? {
        var cursor = 0
        for e in excerpts {
            if e.source == source, e.lineRange.contains(line) {
                return cursor + (line - e.lineRange.lowerBound)
            }
            cursor += e.lineRange.count
        }
        return nil
    }

    /// The excerpt owning a stitched line, or nil if out of range.
    func excerpt(atStitchedLine line: Int) -> Excerpt? {
        guard line >= 0 else { return nil }
        var cursor = 0
        for e in excerpts {
            let count = e.lineRange.count
            if line < cursor + count { return e }
            cursor += count
        }
        return nil
    }

    /// Absorb an edit that changed `source`'s line count at `atLine`. The excerpt
    /// containing the edit grows or shrinks; later excerpts *in the same file*
    /// slide. Other files are untouched.
    mutating func applyEdit(in source: SourceID, atLine line: Int, lineDelta: Int) {
        guard lineDelta != 0 else { return }
        for idx in excerpts.indices where excerpts[idx].source == source {
            let r = excerpts[idx].lineRange
            if r.contains(line) {
                excerpts[idx].lineRange = r.lowerBound..<max(r.lowerBound, r.upperBound + lineDelta)
            } else if r.lowerBound > line {
                excerpts[idx].lineRange = (r.lowerBound + lineDelta)..<(r.upperBound + lineDelta)
            }
        }
    }
}
```

- [ ] **Step 4: Register the file with both targets**

Add to `project.yml`, in `ShepherdModelTests`' `sources:` list (after `- path: Sources/DiffModel.swift`):

```yaml
      - path: Sources/Workbench/StitchMap.swift
```

The app targets pick it up automatically — they glob `- path: Sources`.

Then:

```bash
cd spike/seam1 && xcodegen generate
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -20
```

Expected: `** TEST SUCCEEDED **`, 11 new tests passing.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/Workbench/StitchMap.swift \
        spike/seam1/Tests/StitchMapTests.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(workbench): add StitchMap, the multibuffer excerpt model

Maps stitched line numbers to (file, source line) and back, and absorbs edits
by growing the edited excerpt and sliding later excerpts in the same file.

Line-based rather than offset-based on purpose: byte offsets belong to the
AppKit layer, and lines are what tests can read.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `BlockMap`

Non-text rows sitting between stitched lines: file headers, deleted-line blocks,
spacers, conflict controls, rendered-markdown hosts. Sorted, with height
accounting, so lookup and shifting stay cheap when typing shifts everything below.

**Files:**
- Create: `spike/seam1/Sources/Workbench/BlockMap.swift`
- Create: `spike/seam1/Tests/BlockMapTests.swift`
- Modify: `spike/seam1/project.yml`

**Interfaces:**
- Consumes: `SourceID` (Task 3)
- Produces:
  - `enum BlockKind: Equatable` — `.fileHeader(SourceID)`, `.deletedLines(source: SourceID, lines: [String], startingOldLine: Int)`, `.spacer(rows: Int)`, `.conflictControls(SourceID)`, `.renderedMarkdown(SourceID)`
  - `struct Block: Equatable, Identifiable` — `id: String`, `kind: BlockKind`, `beforeStitchedLine: Int`, `height: CGFloat`
  - `struct BlockMap: Equatable` — `init(blocks: [Block] = [])`, `var blocks: [Block]`, `mutating func insert(_:)`, `mutating func removeAll(for: SourceID)`, `func blocks(beforeStitchedLine:) -> [Block]`, `func totalHeight(aboveStitchedLine:) -> CGFloat`, `mutating func shift(fromStitchedLine:by:)`

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/BlockMapTests.swift`:

```swift
import XCTest
@testable import Shepherd

final class BlockMapTests: XCTestCase {
    private let fileA = SourceID("A.swift")
    private let fileB = SourceID("B.swift")

    private func header(_ id: String, _ src: SourceID, at line: Int) -> Block {
        Block(id: id, kind: .fileHeader(src), beforeStitchedLine: line, height: 28)
    }

    func testInsertKeepsBlocksSortedByPosition() {
        var map = BlockMap()
        map.insert(header("h2", fileB, at: 10))
        map.insert(header("h1", fileA, at: 0))
        map.insert(header("h3", fileB, at: 5))
        XCTAssertEqual(map.blocks.map(\.id), ["h1", "h3", "h2"])
    }

    func testBlocksAtAPositionAreReturnedInInsertionOrder() {
        var map = BlockMap()
        map.insert(header("first", fileA, at: 4))
        map.insert(Block(id: "second", kind: .spacer(rows: 2),
                         beforeStitchedLine: 4, height: 30))
        XCTAssertEqual(map.blocks(beforeStitchedLine: 4).map(\.id), ["first", "second"])
    }

    func testBlocksAtAPositionWithNoneReturnsEmpty() {
        var map = BlockMap()
        map.insert(header("h1", fileA, at: 0))
        XCTAssertTrue(map.blocks(beforeStitchedLine: 7).isEmpty)
    }

    func testTotalHeightSumsOnlyBlocksStrictlyAbove() {
        var map = BlockMap()
        map.insert(header("h1", fileA, at: 0))                                  // 28
        map.insert(Block(id: "d1", kind: .deletedLines(source: fileA, lines: ["a", "b"],
                                                       startingOldLine: 40),
                         beforeStitchedLine: 3, height: 44))
        map.insert(header("h2", fileB, at: 9))                                  // 28
        XCTAssertEqual(map.totalHeight(aboveStitchedLine: 0), 0, accuracy: 0.001)
        XCTAssertEqual(map.totalHeight(aboveStitchedLine: 1), 28, accuracy: 0.001)
        XCTAssertEqual(map.totalHeight(aboveStitchedLine: 4), 72, accuracy: 0.001)
        XCTAssertEqual(map.totalHeight(aboveStitchedLine: 99), 100, accuracy: 0.001)
    }

    func testRemoveAllDropsOnlyThatFilesBlocks() {
        var map = BlockMap()
        map.insert(header("h1", fileA, at: 0))
        map.insert(Block(id: "md", kind: .renderedMarkdown(fileA),
                         beforeStitchedLine: 1, height: 200))
        map.insert(header("h2", fileB, at: 9))
        map.removeAll(for: fileA)
        XCTAssertEqual(map.blocks.map(\.id), ["h2"])
    }

    func testRemoveAllIgnoresSpacersWhichBelongToNoFile() {
        var map = BlockMap()
        map.insert(Block(id: "sp", kind: .spacer(rows: 1),
                         beforeStitchedLine: 2, height: 15))
        map.removeAll(for: fileA)
        XCTAssertEqual(map.blocks.map(\.id), ["sp"], "a spacer has no owning file")
    }

    func testShiftMovesBlocksAtOrBelowTheEditPoint() {
        var map = BlockMap()
        map.insert(header("above", fileA, at: 2))
        map.insert(header("at", fileA, at: 5))
        map.insert(header("below", fileB, at: 8))
        map.shift(fromStitchedLine: 5, by: 3)
        XCTAssertEqual(map.blocks.first { $0.id == "above" }?.beforeStitchedLine, 2)
        XCTAssertEqual(map.blocks.first { $0.id == "at" }?.beforeStitchedLine, 8)
        XCTAssertEqual(map.blocks.first { $0.id == "below" }?.beforeStitchedLine, 11)
    }

    func testShiftCannotDriveAPositionNegative() {
        var map = BlockMap()
        map.insert(header("h1", fileA, at: 2))
        map.shift(fromStitchedLine: 0, by: -10)
        XCTAssertEqual(map.blocks[0].beforeStitchedLine, 0)
    }

    func testShiftKeepsTheArraySorted() {
        var map = BlockMap()
        map.insert(header("h1", fileA, at: 1))
        map.insert(header("h2", fileB, at: 4))
        map.shift(fromStitchedLine: 4, by: -3)
        XCTAssertEqual(map.blocks.map(\.beforeStitchedLine), [1, 1])
        XCTAssertEqual(map.blocks.map(\.id), ["h1", "h2"], "stable under equal positions")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | grep "error:" | head
```

Expected: `cannot find 'BlockMap' in scope`, `cannot find 'Block' in scope`.

- [ ] **Step 3: Write the implementation**

Create `spike/seam1/Sources/Workbench/BlockMap.swift`:

```swift
import Foundation
import CoreGraphics

/// What a non-text row shows.
enum BlockKind: Equatable {
    case fileHeader(SourceID)
    /// Removed lines, rendered as a block because they exist in no current file.
    case deletedLines(source: SourceID, lines: [String], startingOldLine: Int)
    /// Alignment padding on the shorter side of a split diff.
    case spacer(rows: Int)
    case conflictControls(SourceID)
    /// Hosts the rendered-markdown diff views (ADR 0019).
    case renderedMarkdown(SourceID)
}

/// A non-text row inserted immediately above `beforeStitchedLine`.
struct Block: Equatable, Identifiable {
    let id: String
    let kind: BlockKind
    var beforeStitchedLine: Int
    let height: CGFloat
}

/// Ordered non-text rows with height accounting. Kept sorted by position so
/// lookup is a scan of a sorted array and shifting is a single pass — typing
/// moves every block below the cursor, so this runs constantly.
struct BlockMap: Equatable {
    private(set) var blocks: [Block]

    init(blocks: [Block] = []) {
        self.blocks = blocks.sorted { $0.beforeStitchedLine < $1.beforeStitchedLine }
    }

    /// Insert, preserving sort order. Blocks at the same position keep insertion
    /// order, so a file header stays above the spacer that follows it.
    mutating func insert(_ block: Block) {
        let idx = blocks.firstIndex { $0.beforeStitchedLine > block.beforeStitchedLine }
            ?? blocks.count
        blocks.insert(block, at: idx)
    }

    /// Drop every block belonging to a file. Spacers belong to no file and survive.
    mutating func removeAll(for source: SourceID) {
        blocks.removeAll { $0.kind.source == source }
    }

    func blocks(beforeStitchedLine line: Int) -> [Block] {
        blocks.filter { $0.beforeStitchedLine == line }
    }

    /// Combined height of every block strictly above a stitched line — the
    /// y-offset the text at that line has been pushed down by.
    func totalHeight(aboveStitchedLine line: Int) -> CGFloat {
        blocks.reduce(0) { $0 + ($1.beforeStitchedLine < line ? $1.height : 0) }
    }

    /// Slide blocks at or below an edit point. Positions clamp at 0.
    mutating func shift(fromStitchedLine line: Int, by delta: Int) {
        guard delta != 0 else { return }
        for idx in blocks.indices where blocks[idx].beforeStitchedLine >= line {
            blocks[idx].beforeStitchedLine = max(0, blocks[idx].beforeStitchedLine + delta)
        }
        // A negative delta can reorder only by collapsing positions together;
        // a stable sort keeps same-position blocks in their existing order.
        blocks = blocks.enumerated()
            .sorted {
                $0.element.beforeStitchedLine != $1.element.beforeStitchedLine
                    ? $0.element.beforeStitchedLine < $1.element.beforeStitchedLine
                    : $0.offset < $1.offset
            }
            .map(\.element)
    }
}

extension BlockKind {
    /// The file this block belongs to, or nil for file-agnostic blocks (spacers).
    var source: SourceID? {
        switch self {
        case .fileHeader(let s), .conflictControls(let s), .renderedMarkdown(let s):
            return s
        case .deletedLines(let s, _, _):
            return s
        case .spacer:
            return nil
        }
    }
}
```

- [ ] **Step 4: Register the file and regenerate**

Add to `ShepherdModelTests`' `sources:` in `project.yml`, after the `StitchMap.swift` line:

```yaml
      - path: Sources/Workbench/BlockMap.swift
```

```bash
cd spike/seam1 && xcodegen generate
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -20
```

Expected: `** TEST SUCCEEDED **`, 9 new tests passing.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/Workbench/BlockMap.swift \
        spike/seam1/Tests/BlockMapTests.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(workbench): add BlockMap for non-text rows

File headers, deleted-line blocks, spacers, conflict controls, and rendered
markdown hosts, kept sorted with height accounting. Typing shifts every block
below the cursor, so insert/shift/lookup all stay single-pass over a sorted
array.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `WordDiff`

Intra-line word highlighting, over the existing `SequenceAlign.lcs`. Superset
enables this by default with a 5,000-character cap so lockfiles and minified
bundles degrade instead of hanging; same here.

**Files:**
- Create: `spike/seam1/Sources/Workbench/WordDiff.swift`
- Create: `spike/seam1/Tests/WordDiffTests.swift`
- Modify: `spike/seam1/project.yml`

**Interfaces:**
- Consumes: `SequenceAlign.lcs(_:_:) -> [AlignOp]` (existing, `Sources/SequenceAlign.swift`)
- Produces:
  - `struct WordSpan: Equatable` — `range: Range<Int>` (character offsets into the line), `changed: Bool`
  - `enum WordDiff` — `static func spans(old: String, new: String, maxLength: Int = 5000) -> (old: [WordSpan], new: [WordSpan])`

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/WordDiffTests.swift`:

```swift
import XCTest
@testable import Shepherd

final class WordDiffTests: XCTestCase {
    /// Concatenate the changed spans' text, so assertions read as "what got tinted".
    private func changedText(_ line: String, _ spans: [WordSpan]) -> String {
        spans.filter(\.changed)
            .map { String(Array(line)[$0.range]) }
            .joined(separator: "|")
    }

    func testIdenticalLinesHaveNoChangedSpans() {
        let (old, new) = WordDiff.spans(old: "let a = 1", new: "let a = 1")
        XCTAssertTrue(old.allSatisfy { !$0.changed })
        XCTAssertTrue(new.allSatisfy { !$0.changed })
    }

    func testASingleChangedWordIsIsolated() {
        let o = "let a = 1", n = "let a = 2"
        let (oldSpans, newSpans) = WordDiff.spans(old: o, new: n)
        XCTAssertEqual(changedText(o, oldSpans), "1")
        XCTAssertEqual(changedText(n, newSpans), "2")
    }

    func testUnchangedPrefixAndSuffixAreNotMarked() {
        let o = "diffPanelOpen = false", n = "diffPanelOpen = true"
        let (oldSpans, newSpans) = WordDiff.spans(old: o, new: n)
        XCTAssertEqual(changedText(o, oldSpans), "false")
        XCTAssertEqual(changedText(n, newSpans), "true")
    }

    func testInsertedWordAppearsOnlyOnTheNewSide() {
        let o = "func run()", n = "func run() async"
        let (oldSpans, newSpans) = WordDiff.spans(old: o, new: n)
        XCTAssertEqual(changedText(o, oldSpans), "")
        XCTAssertEqual(changedText(n, newSpans), "async")
    }

    func testDeletedWordAppearsOnlyOnTheOldSide() {
        let o = "func run() async", n = "func run()"
        let (oldSpans, newSpans) = WordDiff.spans(old: o, new: n)
        XCTAssertEqual(changedText(o, oldSpans), "async")
        XCTAssertEqual(changedText(n, newSpans), "")
    }

    func testSpansCoverTheWholeLineWithoutGapsOrOverlap() {
        let line = "let value = compute(a, b)"
        let (_, newSpans) = WordDiff.spans(old: "let value = compute(a)", new: line)
        XCTAssertEqual(newSpans.first?.range.lowerBound, 0)
        XCTAssertEqual(newSpans.last?.range.upperBound, line.count)
        for (a, b) in zip(newSpans, newSpans.dropFirst()) {
            XCTAssertEqual(a.range.upperBound, b.range.lowerBound, "gap or overlap between spans")
        }
    }

    func testLinesOverTheCapAreMarkedWhollyChanged() {
        let o = String(repeating: "a", count: 20), n = String(repeating: "b", count: 20)
        let (oldSpans, newSpans) = WordDiff.spans(old: o, new: n, maxLength: 10)
        XCTAssertEqual(oldSpans, [WordSpan(range: 0..<20, changed: true)])
        XCTAssertEqual(newSpans, [WordSpan(range: 0..<20, changed: true)])
    }

    func testEmptyLinesProduceNoSpans() {
        let (old, new) = WordDiff.spans(old: "", new: "")
        XCTAssertTrue(old.isEmpty)
        XCTAssertTrue(new.isEmpty)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | grep "error:" | head
```

Expected: `cannot find 'WordDiff' in scope`, `cannot find 'WordSpan' in scope`.

- [ ] **Step 3: Write the implementation**

Create `spike/seam1/Sources/Workbench/WordDiff.swift`:

```swift
import Foundation

/// A run of characters within one line, flagged as changed or unchanged.
/// `range` indexes the line's characters (not UTF-16 units).
struct WordSpan: Equatable {
    let range: Range<Int>
    let changed: Bool
}

/// Intra-line word diff over `SequenceAlign.lcs`. Spans tile the line with no
/// gaps, so a renderer can walk them in order and tint as it goes.
enum WordDiff {
    /// Word-level spans for a changed line pair. Lines longer than `maxLength`
    /// are reported as wholly changed rather than aligned — the cap keeps
    /// lockfiles and minified bundles from stalling the render.
    static func spans(old: String, new: String, maxLength: Int = 5000)
        -> (old: [WordSpan], new: [WordSpan]) {
        if old.isEmpty && new.isEmpty { return ([], []) }
        if old.count > maxLength || new.count > maxLength {
            return (wholeLine(old), wholeLine(new))
        }
        let oldTokens = tokenize(old), newTokens = tokenize(new)
        let ops = SequenceAlign.lcs(oldTokens.map(\.text), newTokens.map(\.text))
        var oldChanged = Set<Int>(), newChanged = Set<Int>()
        for op in ops {
            switch op {
            case .keep: break
            case .remove(let i): oldChanged.insert(i)
            case .add(let j): newChanged.insert(j)
            }
        }
        return (merge(oldTokens, changed: oldChanged, lineLength: old.count),
                merge(newTokens, changed: newChanged, lineLength: new.count))
    }

    private static func wholeLine(_ s: String) -> [WordSpan] {
        s.isEmpty ? [] : [WordSpan(range: 0..<s.count, changed: true)]
    }

    private struct Token { let text: String; let range: Range<Int> }

    /// Split into runs of word characters and runs of non-word characters, so
    /// punctuation shifts don't smear the whole line as changed.
    private static func tokenize(_ s: String) -> [Token] {
        var out: [Token] = []
        var start = 0
        var current = ""
        var currentIsWord: Bool?
        for (idx, ch) in Array(s).enumerated() {
            let isWord = ch.isLetter || ch.isNumber || ch == "_"
            if isWord != currentIsWord, currentIsWord != nil {
                out.append(Token(text: current, range: start..<idx))
                start = idx
                current = ""
            }
            currentIsWord = isWord
            current.append(ch)
        }
        if !current.isEmpty { out.append(Token(text: current, range: start..<s.count)) }
        return out
    }

    /// Collapse adjacent tokens of the same changed-ness into contiguous spans.
    private static func merge(_ tokens: [Token], changed: Set<Int>, lineLength: Int) -> [WordSpan] {
        guard !tokens.isEmpty else { return [] }
        var out: [WordSpan] = []
        for (idx, token) in tokens.enumerated() {
            let isChanged = changed.contains(idx)
            if let last = out.last, last.changed == isChanged {
                out[out.count - 1] = WordSpan(range: last.range.lowerBound..<token.range.upperBound,
                                              changed: isChanged)
            } else {
                out.append(WordSpan(range: token.range, changed: isChanged))
            }
        }
        return out
    }
}
```

- [ ] **Step 4: Register the file and regenerate**

Add to `ShepherdModelTests`' `sources:` in `project.yml`, after the `BlockMap.swift` line:

```yaml
      - path: Sources/Workbench/WordDiff.swift
```

```bash
cd spike/seam1 && xcodegen generate
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -20
```

Expected: `** TEST SUCCEEDED **`, 8 new tests passing.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/Workbench/WordDiff.swift \
        spike/seam1/Tests/WordDiffTests.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(workbench): add intra-line word diff

Word-level spans over the existing SequenceAlign.lcs, tiling each line with no
gaps so a renderer can walk them in order. Word and punctuation runs tokenize
separately so a moved bracket doesn't smear the whole line as changed.

Lines past a 5,000-character cap report as wholly changed — the cap keeps
lockfiles and minified bundles from stalling the render.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `LockPolicy` — the live-follow decision

The spec's per-file lock, isolated as a pure decision (mirroring how
`SleepPolicy` backs `SleepGuard` and `StopPolicy` backs `AgentStore.apply`).
Task 7 is the impure shell around it.

**Files:**
- Create: `spike/seam1/Sources/Workbench/LockPolicy.swift`
- Create: `spike/seam1/Tests/LockPolicyTests.swift`
- Modify: `spike/seam1/project.yml`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `enum FollowState: Equatable` — `.following`, `.locked`, `.lockedStale`
  - `enum DiskEvent: Equatable` — `.externalWrite`, `.userEdit`, `.userSaved`, `.userDiscarded`
  - `enum LockPolicy` — `static func next(_ state: FollowState, on event: DiskEvent) -> FollowState`, `static func shouldReloadFromDisk(_ state: FollowState, on event: DiskEvent) -> Bool`

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/LockPolicyTests.swift`:

```swift
import XCTest
@testable import Shepherd

final class LockPolicyTests: XCTestCase {
    func testACleanFileFollowsExternalWrites() {
        XCTAssertEqual(LockPolicy.next(.following, on: .externalWrite), .following)
        XCTAssertTrue(LockPolicy.shouldReloadFromDisk(.following, on: .externalWrite))
    }

    func testTypingLocksTheFile() {
        XCTAssertEqual(LockPolicy.next(.following, on: .userEdit), .locked)
    }

    func testALockedFileIgnoresExternalWritesButRemembersThem() {
        XCTAssertEqual(LockPolicy.next(.locked, on: .externalWrite), .lockedStale)
        XCTAssertFalse(LockPolicy.shouldReloadFromDisk(.locked, on: .externalWrite),
                       "reloading would discard the user's unsaved edits")
    }

    func testAStaleLockedFileStaysStaleOnFurtherWrites() {
        XCTAssertEqual(LockPolicy.next(.lockedStale, on: .externalWrite), .lockedStale)
        XCTAssertFalse(LockPolicy.shouldReloadFromDisk(.lockedStale, on: .externalWrite))
    }

    func testEditingAStaleFileKeepsItStale() {
        // The agent's write is still unreconciled; typing more must not hide that.
        XCTAssertEqual(LockPolicy.next(.lockedStale, on: .userEdit), .lockedStale)
    }

    func testSavingResumesFollowing() {
        XCTAssertEqual(LockPolicy.next(.locked, on: .userSaved), .following)
        XCTAssertEqual(LockPolicy.next(.lockedStale, on: .userSaved), .following)
    }

    func testDiscardingResumesFollowingAndReloads() {
        XCTAssertEqual(LockPolicy.next(.lockedStale, on: .userDiscarded), .following)
        XCTAssertTrue(LockPolicy.shouldReloadFromDisk(.lockedStale, on: .userDiscarded),
                      "take-theirs must pull the agent's version in")
    }

    func testSavingDoesNotReloadFromDisk() {
        XCTAssertFalse(LockPolicy.shouldReloadFromDisk(.locked, on: .userSaved),
                       "we just wrote our own text; re-reading it is pointless churn")
    }

    func testUserEditNeverReloads() {
        for state in [FollowState.following, .locked, .lockedStale] {
            XCTAssertFalse(LockPolicy.shouldReloadFromDisk(state, on: .userEdit))
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | grep "error:" | head
```

Expected: `cannot find 'LockPolicy' in scope`, `cannot find 'FollowState' in scope`.

- [ ] **Step 3: Write the implementation**

Create `spike/seam1/Sources/Workbench/LockPolicy.swift`:

```swift
import Foundation

/// Whether a buffer tracks disk. `.lockedStale` means the user has unsaved edits
/// *and* an agent has written the file since — the only state needing a decision
/// from the user.
enum FollowState: Equatable { case following, locked, lockedStale }

enum DiskEvent: Equatable {
    case externalWrite   // an agent (or anything else) wrote the file
    case userEdit        // the user typed in this buffer
    case userSaved       // keep-mine: our text was written to disk
    case userDiscarded   // take-theirs: drop our edits
}

/// The live-follow / dirty-lock decision, pure so it can be exhaustively tested
/// (mirrors `SleepPolicy` behind `SleepGuard`).
///
/// Clean buffers stream agent edits. The instant the user types, that one buffer
/// stops following — never the whole workbench.
enum LockPolicy {
    static func next(_ state: FollowState, on event: DiskEvent) -> FollowState {
        switch (state, event) {
        case (_, .userSaved), (_, .userDiscarded):
            return .following
        case (.following, .externalWrite):
            return .following
        case (.following, .userEdit):
            return .locked
        case (.locked, .externalWrite), (.lockedStale, _):
            return .lockedStale
        case (.locked, .userEdit):
            return .locked
        }
    }

    /// Whether this transition should re-read the file. Only two cases: a clean
    /// buffer seeing a write, and an explicit discard.
    static func shouldReloadFromDisk(_ state: FollowState, on event: DiskEvent) -> Bool {
        switch event {
        case .externalWrite:  return state == .following
        case .userDiscarded:  return true
        case .userEdit, .userSaved: return false
        }
    }
}
```

- [ ] **Step 4: Register the file and regenerate**

Add to `ShepherdModelTests`' `sources:` in `project.yml`, after the `WordDiff.swift` line:

```yaml
      - path: Sources/Workbench/LockPolicy.swift
```

```bash
cd spike/seam1 && xcodegen generate
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -20
```

Expected: `** TEST SUCCEEDED **`, 9 new tests passing.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/Workbench/LockPolicy.swift \
        spike/seam1/Tests/LockPolicyTests.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(workbench): add LockPolicy for per-file live-follow

Clean buffers stream agent edits; typing locks that one buffer, and an agent
write to a locked buffer marks it stale rather than clobbering unsaved work.
One file's edit never freezes the rest of the workbench.

Pure so the state machine is exhaustively testable, mirroring SleepPolicy
behind SleepGuard.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `SourceBuffer` — one file, watched

The impure shell around `LockPolicy`: file text, git blobs, and a `DispatchSource`
watcher. No unit tests (it touches the filesystem); verified by build plus the
integration check in Task 11.

**Files:**
- Create: `spike/seam1/Sources/Workbench/SourceBuffer.swift`

**Interfaces:**
- Consumes: `SourceID`, `FollowState`, `DiskEvent`, `LockPolicy`, `DiffReader.fileBlob(cwd:path:side:baseLabel:)` (existing)
- Produces:
  - `@MainActor final class SourceBuffer: ObservableObject`
  - `init(source: SourceID, cwd: String, baseLabel: String?)`
  - `@Published private(set) var text: String`
  - `@Published private(set) var follow: FollowState`
  - `private(set) var baseText: String?`
  - `func apply(_ event: DiskEvent)`
  - `func replaceText(_ new: String)`
  - `func save() throws`
  - `func startWatching()` / `func stopWatching()`
  - `var onExternalWrite: (() -> Void)?`

- [ ] **Step 1: Write the implementation**

Create `spike/seam1/Sources/Workbench/SourceBuffer.swift`:

```swift
import Foundation
import Combine

/// One file in the workbench: its current text, its base blob for diffing, and a
/// watcher that drives live-follow. The follow/lock decision is `LockPolicy`'s;
/// this is the filesystem shell around it.
@MainActor
final class SourceBuffer: ObservableObject {
    let source: SourceID
    private let cwd: String
    private let baseLabel: String?

    @Published private(set) var text: String = ""
    @Published private(set) var follow: FollowState = .following

    /// The blob this buffer diffs against (HEAD, or the base branch). Read once —
    /// it only changes when the diff scope changes, which rebuilds the session.
    private(set) var baseText: String?

    /// Fired after an external write is absorbed, so the session can re-diff.
    var onExternalWrite: (() -> Void)?

    private var watcher: DispatchSourceFileSystemObject?
    private var fd: Int32 = -1

    init(source: SourceID, cwd: String, baseLabel: String?) {
        self.source = source
        self.cwd = cwd
        self.baseLabel = baseLabel
        self.text = (try? String(contentsOfFile: source.path, encoding: .utf8)) ?? ""
        let relative = Self.relativePath(source.path, cwd: cwd)
        self.baseText = DiffReader.fileBlob(cwd: cwd, path: relative,
                                            side: .old, baseLabel: baseLabel)
    }

    deinit { watcher?.cancel(); if fd >= 0 { close(fd) } }

    /// Route an event through `LockPolicy`, reloading only when it says to.
    func apply(_ event: DiskEvent) {
        if LockPolicy.shouldReloadFromDisk(follow, on: event),
           let fresh = try? String(contentsOfFile: source.path, encoding: .utf8) {
            text = fresh
        }
        follow = LockPolicy.next(follow, on: event)
    }

    /// The user edited the buffer. Locks the file via `LockPolicy`.
    func replaceText(_ new: String) {
        text = new
        follow = LockPolicy.next(follow, on: .userEdit)
    }

    func save() throws {
        try text.write(toFile: source.path, atomically: true, encoding: .utf8)
        follow = LockPolicy.next(follow, on: .userSaved)
    }

    // MARK: - Watching

    /// Watch for writes. Editors (and git) replace files rather than writing in
    /// place, so `.delete`/`.rename` must re-arm the watch on the new inode —
    /// otherwise we stop hearing about the file after the first agent edit.
    func startWatching() {
        stopWatching()
        fd = open(source.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let w = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd, eventMask: [.write, .delete, .rename], queue: .main)
        w.setEventHandler { [weak self] in
            guard let self else { return }
            let flags = w.data
            self.apply(.externalWrite)
            self.onExternalWrite?()
            if flags.contains(.delete) || flags.contains(.rename) {
                self.startWatching()   // re-arm on the replacement inode
            }
        }
        w.setCancelHandler { [fd = self.fd] in if fd >= 0 { close(fd) } }
        w.resume()
        watcher = w
    }

    func stopWatching() {
        watcher?.cancel()
        watcher = nil
        fd = -1
    }

    /// `DiffReader.fileBlob` wants a repo-relative path; we hold absolute ones.
    private static func relativePath(_ absolute: String, cwd: String) -> String {
        guard absolute.hasPrefix(cwd) else { return absolute }
        return String(absolute.dropFirst(cwd.count)).trimmingCharacters(
            in: CharacterSet(charactersIn: "/"))
    }
}
```

- [ ] **Step 2: Build to verify it compiles**

```bash
cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj \
  -scheme Shepherd -configuration Debug -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -10
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add spike/seam1/Sources/Workbench/SourceBuffer.swift
git commit -m "$(cat <<'EOF'
feat(workbench): add SourceBuffer, one watched file per source

Holds a file's text and its base blob, and drives live-follow from a
DispatchSource watcher through LockPolicy.

Re-arms the watch on .delete/.rename: editors and git replace files rather than
writing in place, so a single-shot watch stops hearing about a file after the
first agent edit.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `BlockRenderer` — row tints and block rows

Where the vendored editor earns its keep. A `TextLayoutManagerRenderDelegate`
plus a `LineFragmentView` subclass paints diff row backgrounds; CESE's own
minimap is built the same way (`Sources/Editor/CodeEditSourceEditor/Minimap/MinimapLineRenderer.swift`
is the reference to read first).

**Files:**
- Create: `spike/seam1/Sources/Workbench/BlockRenderer.swift`

**Interfaces:**
- Consumes: `StitchMap`, `BlockMap`, `WordSpan`, `Theme.Diff`, and the vendored `TextLayoutManagerRenderDelegate`, `LineFragmentView`, `LineFragment`, `TextLine`, `MarkedRanges`, `AnyTextAttachment`
- Produces:
  - `enum RowTint: Equatable` — `.none`, `.added`, `.removed`, `.conflict`
  - `final class DiffRowView: LineFragmentView` — `var tint: RowTint`, `var wordSpans: [WordSpan]`
  - `final class BlockRenderer: TextLayoutManagerRenderDelegate` — `init(tintForStitchedLine: @escaping (Int) -> RowTint, spansForStitchedLine: @escaping (Int) -> [WordSpan])`, `var lineForFragment: ((LineFragment) -> Int?)?`

- [ ] **Step 1: Read the reference implementation first**

```bash
cd spike/seam1 && sed -n 1,80p Sources/Editor/CodeEditSourceEditor/Minimap/MinimapLineRenderer.swift
```

This is the only in-tree example of a render delegate. Match its shape — in
particular how it implements `lineFragmentView(for:)` and leaves the other
protocol methods on their defaults.

- [ ] **Step 2: Write the implementation**

Create `spike/seam1/Sources/Workbench/BlockRenderer.swift`:

```swift
import AppKit

/// A diff row's background treatment.
enum RowTint: Equatable { case none, added, removed, conflict }

/// A line fragment that paints a full-width diff tint behind its text, plus
/// stronger word-level tints for the parts that actually changed.
///
/// Full-bleed: the tint fills the fragment's whole width so rows read as bands,
/// not as highlighted text.
final class DiffRowView: LineFragmentView {
    var tint: RowTint = .none
    var wordSpans: [WordSpan] = []

    override func draw(_ dirtyRect: NSRect) {
        if let bg = Self.color(for: tint) {
            bg.setFill()
            bounds.fill()
            drawWordSpans()
        }
        super.draw(dirtyRect)   // text last, so it sits on top of the tint
    }

    /// Word tints, positioned by measuring the fragment's own character advances
    /// so they line up with the glyphs regardless of font.
    private func drawWordSpans() {
        guard let fragment = lineFragment, !wordSpans.isEmpty,
              let strong = Self.wordColor(for: tint) else { return }
        strong.setFill()
        for span in wordSpans where span.changed {
            let x0 = fragment._xPos(for: span.range.lowerBound)
            let x1 = fragment._xPos(for: span.range.upperBound)
            NSRect(x: x0, y: 0, width: max(1, x1 - x0), height: bounds.height).fill()
        }
    }

    private static func color(for tint: RowTint) -> NSColor? {
        switch tint {
        case .none:      return nil
        case .added:     return NSColor(hex24: Theme.Diff.addition).withAlphaComponent(0.14)
        case .removed:   return NSColor(hex24: Theme.Diff.deletion).withAlphaComponent(0.14)
        case .conflict:  return NSColor(hex24: Theme.Diff.modified).withAlphaComponent(0.14)
        }
    }

    private static func wordColor(for tint: RowTint) -> NSColor? {
        switch tint {
        case .none:     return nil
        case .added:    return NSColor(hex24: Theme.Diff.wordAdd).withAlphaComponent(0.55)
        case .removed:  return NSColor(hex24: Theme.Diff.wordDel).withAlphaComponent(0.55)
        case .conflict: return NSColor(hex24: Theme.Diff.modified).withAlphaComponent(0.28)
        }
    }
}

/// Supplies `DiffRowView`s to the layout manager, tinted per stitched line.
///
/// `lineForFragment` is injected rather than computed here: only the session
/// knows the fragment→stitched-line mapping, and the render delegate must stay
/// ignorant of the session to avoid a retain cycle through the text view.
final class BlockRenderer: TextLayoutManagerRenderDelegate {
    private let tintForStitchedLine: (Int) -> RowTint
    private let spansForStitchedLine: (Int) -> [WordSpan]
    var lineForFragment: ((LineFragment) -> Int?)?

    init(tintForStitchedLine: @escaping (Int) -> RowTint,
         spansForStitchedLine: @escaping (Int) -> [WordSpan]) {
        self.tintForStitchedLine = tintForStitchedLine
        self.spansForStitchedLine = spansForStitchedLine
    }

    func lineFragmentView(for lineFragment: LineFragment) -> LineFragmentView {
        let view = DiffRowView()
        if let line = lineForFragment?(lineFragment) {
            view.tint = tintForStitchedLine(line)
            view.wordSpans = spansForStitchedLine(line)
        }
        return view
    }

    func estimatedLineHeight() -> CGFloat? { nil }   // defer to the text view's own metric
}

extension NSColor {
    /// #RRGGBB from a 24-bit integer, matching `Color(hex:)` in Theme.swift.
    convenience init(hex24: UInt32) {
        self.init(srgbRed: CGFloat((hex24 >> 16) & 0xFF) / 255,
                  green: CGFloat((hex24 >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex24 & 0xFF) / 255, alpha: 1)
    }
}
```

- [ ] **Step 3: Build to verify it compiles**

```bash
cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj \
  -scheme Shepherd -configuration Debug -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -20
```

Expected: `** BUILD SUCCEEDED **`.

If `_xPos(for:)` is not accessible (it is underscore-prefixed, so upstream may
have it as `package`), either widen it to `public` in the vendored
`Sources/Editor/CodeEditTextView/TextLine/LineFragment.swift` — noting the change
in `UPSTREAM-BASELINE.txt` — or drop word tints from this task and add them in
Task 11 once the session can measure text itself.

If `NSColor(hex24:)` collides with an existing extension in `CodeSurfaceView.swift`
(which has a private `NSColor(hex:)`), leave both — the private one is file-scoped.

- [ ] **Step 4: Commit**

```bash
git add spike/seam1/Sources/Workbench/BlockRenderer.swift
git commit -m "$(cat <<'EOF'
feat(workbench): add BlockRenderer for full-bleed diff row tints

A TextLayoutManagerRenderDelegate plus a LineFragmentView subclass that paints
diff row backgrounds and word-level tints behind the text, so rows read as
bands rather than highlighted text. Built the same way CESE's own minimap is.

The fragment -> stitched-line mapping is injected: only the session knows it,
and the delegate must stay ignorant of the session to avoid retaining it
through the text view.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `DiffGutter`

Four columns: stage checkbox, old line number, new line number, sign. CESE's
`GutterView.drawLineNumbers` is private, which is a founding reason for vendoring —
but rather than fork its drawing, this is a sibling view driven by `StitchMap`.

**Files:**
- Create: `spike/seam1/Sources/Workbench/DiffGutter.swift`

**Interfaces:**
- Consumes: `StitchMap`, `RowTint`, `Theme.Diff`, `Theme.monoFontName`, `Theme.lineHeightMultiple`
- Produces:
  - `struct GutterRow: Equatable` — `oldLine: Int?`, `newLine: Int?`, `sign: Character?`, `staged: Bool?`, `tint: RowTint`, `yPos: CGFloat`, `height: CGFloat`
  - `final class DiffGutterView: NSView` — `var rows: [GutterRow]`, `var onToggleStage: ((Int) -> Void)?`, `static func width(maxLineNumber: Int) -> CGFloat`

- [ ] **Step 1: Write the implementation**

Create `spike/seam1/Sources/Workbench/DiffGutter.swift`:

```swift
import AppKit

/// One gutter row, positioned in the gutter's own coordinate space. `yPos`/`height`
/// come from the layout manager so the gutter tracks text exactly — including
/// wrapped lines and block rows, which have no line number.
struct GutterRow: Equatable {
    let oldLine: Int?
    let newLine: Int?
    let sign: Character?      // "+", "-", or nil for context
    let staged: Bool?         // nil ⇒ not stageable (context / block row)
    let tint: RowTint
    let yPos: CGFloat
    let height: CGFloat
}

/// The workbench gutter: [stage] [old no] [new no] [sign].
///
/// The sign gets its own column rather than being prefixed into the text, so code
/// stays horizontally aligned between changed and context rows. Prefixing was why
/// the old diff panel shifted changed lines one character right.
final class DiffGutterView: NSView {
    var rows: [GutterRow] = [] { didSet { needsDisplay = true } }
    var onToggleStage: ((Int) -> Void)?

    override var isFlipped: Bool { true }

    private static let checkboxColumn: CGFloat = 20
    private static let signColumn: CGFloat = 14
    private static let gap: CGFloat = 6
    private static let fontSize: CGFloat = 12

    private static var font: NSFont {
        Theme.monoFontName.flatMap { NSFont(name: $0, size: fontSize) }
            ?? .monospacedSystemFont(ofSize: fontSize, weight: .regular)
    }

    /// Total width for a document whose largest line number is `maxLineNumber`.
    /// Measured from the digits rather than guessed, so it doesn't clip at 1000+.
    static func width(maxLineNumber: Int) -> CGFloat {
        let digits = String(max(1, maxLineNumber))
        let w = (digits as NSString).size(withAttributes: [.font: font]).width
        return checkboxColumn + gap + (w + gap) * 2 + signColumn + gap
    }

    private var numberColumnWidth: CGFloat {
        let maxLine = rows.compactMap { max($0.oldLine ?? 0, $0.newLine ?? 0) }.max() ?? 1
        let digits = String(max(1, maxLine))
        return (digits as NSString).size(withAttributes: [.font: Self.font]).width
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor(hex24: Theme.Diff.buffer).setFill()
        bounds.fill()

        let numberWidth = numberColumnWidth
        let dim: [NSAttributedString.Key: Any] = [
            .font: Self.font,
            .foregroundColor: NSColor(hex24: Theme.Diff.gutterFg),
        ]

        for row in rows where row.yPos + row.height >= dirtyRect.minY
                              && row.yPos <= dirtyRect.maxY {
            if let bg = tintColor(row.tint) {
                bg.setFill()
                NSRect(x: 0, y: row.yPos, width: bounds.width, height: row.height).fill()
            }

            var x = Self.checkboxColumn + Self.gap
            for value in [row.oldLine, row.newLine] {
                if let value {
                    let text = String(value) as NSString
                    let size = text.size(withAttributes: dim)
                    text.draw(at: NSPoint(x: x + numberWidth - size.width,
                                          y: row.yPos + (row.height - size.height) / 2),
                              withAttributes: dim)
                }
                x += numberWidth + Self.gap
            }

            if let sign = row.sign {
                let color = sign == "+" ? Theme.Diff.addition : Theme.Diff.deletion
                let attrs: [NSAttributedString.Key: Any] = [
                    .font: Self.font, .foregroundColor: NSColor(hex24: color),
                ]
                let text = String(sign) as NSString
                let size = text.size(withAttributes: attrs)
                text.draw(at: NSPoint(x: x, y: row.yPos + (row.height - size.height) / 2),
                          withAttributes: attrs)
            }

            if let staged = row.staged { drawCheckbox(staged, y: row.yPos, height: row.height) }
        }
    }

    private func drawCheckbox(_ staged: Bool, y: CGFloat, height: CGFloat) {
        let side: CGFloat = 11
        let rect = NSRect(x: (Self.checkboxColumn - side) / 2,
                          y: y + (height - side) / 2, width: side, height: side)
        let path = NSBezierPath(roundedRect: rect, xRadius: 2.5, yRadius: 2.5)
        if staged {
            NSColor(hex24: Theme.Diff.addition).setFill()
            path.fill()
        } else {
            NSColor(hex24: Theme.Diff.gutterFg).withAlphaComponent(0.5).setStroke()
            path.lineWidth = 1
            path.stroke()
        }
    }

    private func tintColor(_ tint: RowTint) -> NSColor? {
        switch tint {
        case .none:     return nil
        case .added:    return NSColor(hex24: Theme.Diff.addition).withAlphaComponent(0.08)
        case .removed:  return NSColor(hex24: Theme.Diff.deletion).withAlphaComponent(0.08)
        case .conflict: return NSColor(hex24: Theme.Diff.modified).withAlphaComponent(0.08)
        }
    }

    /// A click in the checkbox column toggles that row's staged state.
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard point.x <= Self.checkboxColumn,
              let idx = rows.firstIndex(where: {
                  point.y >= $0.yPos && point.y < $0.yPos + $0.height && $0.staged != nil
              })
        else { return super.mouseDown(with: event) }
        onToggleStage?(idx)
    }
}
```

- [ ] **Step 2: Build to verify it compiles**

```bash
cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj \
  -scheme Shepherd -configuration Debug -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -10
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add spike/seam1/Sources/Workbench/DiffGutter.swift
git commit -m "$(cat <<'EOF'
feat(workbench): add DiffGutter with stage, old/new number, and sign columns

CESE's GutterView.drawLineNumbers is private, so this is a sibling view driven
by StitchMap rather than a fork of its drawing.

The sign gets its own column instead of being prefixed into the text — the old
diff panel prefixed it, which shifted changed lines one character right of
context lines. Column width is measured from the digits so it doesn't clip
past line 1000.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `MultiHighlighter` — one tokenizer, many files

The fix for the original complaint. A `HighlightProviding` that keeps one
tree-sitter client per source file and projects its ranges into stitched
coordinates, so the diff and the editor are tokenized by the same engine.

**Files:**
- Create: `spike/seam1/Sources/Workbench/MultiHighlighter.swift`

**Interfaces:**
- Consumes: `StitchMap`, `SourceID`, and the vendored `HighlightProviding`, `HighlightRange`, `TextView`, `TreeSitterClient`, plus `CodeLanguage` from `CodeEditLanguages`
- Produces:
  - `final class MultiHighlighter: HighlightProviding`
  - `init(stitchMap: @escaping () -> StitchMap, textForSource: @escaping (SourceID) -> String, rangeForStitchedLines: @escaping (Range<Int>) -> NSRange?, stitchedLineRange: @escaping (NSRange) -> Range<Int>?)`
  - `func invalidate(source: SourceID)`

- [ ] **Step 1: Read how CESE drives its own tree-sitter client**

```bash
cd spike/seam1 && ls Sources/Editor/CodeEditSourceEditor/TreeSitter/ && \
  grep -n "class TreeSitterClient\|func queryHighlightsFor\|func setUp" \
  Sources/Editor/CodeEditSourceEditor/TreeSitter/TreeSitterClient*.swift | head -20
```

Note the exact `TreeSitterClient` initializer and `queryHighlightsFor`
signature — the code below assumes one client per file, driven the same way
CESE drives its single client.

- [ ] **Step 2: Write the implementation**

Create `spike/seam1/Sources/Workbench/MultiHighlighter.swift`:

```swift
import AppKit
import CodeEditLanguages

/// Highlights a stitched multibuffer by keeping one tree-sitter client per source
/// file and projecting each file's highlight ranges into stitched coordinates.
///
/// A stitched document cannot be parsed as one file — its excerpts come from
/// different files and different languages, and are discontinuous. So each source
/// is parsed on its own, exactly as the editor parses it. That is what makes the
/// diff and the editor agree: one tokenizer, not two.
final class MultiHighlighter: HighlightProviding {
    private let stitchMap: () -> StitchMap
    private let textForSource: (SourceID) -> String
    private let rangeForStitchedLines: (Range<Int>) -> NSRange?
    private let stitchedLineRange: (NSRange) -> Range<Int>?

    /// Cached per-file highlight ranges, keyed by source. Line-indexed so a
    /// projection is a lookup rather than a re-parse.
    private var cache: [SourceID: [Int: [HighlightRange]]] = [:]

    init(stitchMap: @escaping () -> StitchMap,
         textForSource: @escaping (SourceID) -> String,
         rangeForStitchedLines: @escaping (Range<Int>) -> NSRange?,
         stitchedLineRange: @escaping (NSRange) -> Range<Int>?) {
        self.stitchMap = stitchMap
        self.textForSource = textForSource
        self.rangeForStitchedLines = rangeForStitchedLines
        self.stitchedLineRange = stitchedLineRange
    }

    /// Drop a file's cached highlights — call when its buffer changes.
    func invalidate(source: SourceID) { cache.removeValue(forKey: source) }

    func setUp(textView: TextView, codeLanguage: CodeLanguage) {
        // Language is per-excerpt, resolved in `highlights(for:)` from the file
        // extension, so there is nothing to configure globally here.
    }

    func willApplyEdit(textView: TextView, range: NSRange) { }

    func applyEdit(textView: TextView, range: NSRange, delta: Int,
                   completion: @escaping @MainActor (Result<IndexSet, Error>) -> Void) {
        // Invalidate the edited file only; other excerpts are unaffected.
        if let lines = stitchedLineRange(range),
           let source = stitchMap().sourceLocation(atStitchedLine: lines.lowerBound)?.source {
            invalidate(source: source)
        }
        completion(.success(IndexSet(integersIn: range.location..<(range.location + max(0, range.length + delta)))))
    }

    func queryHighlightsFor(textView: TextView, range: NSRange,
                            completion: @escaping @MainActor (Result<[HighlightRange], Error>) -> Void) {
        guard let lines = stitchedLineRange(range) else {
            completion(.success([]))
            return
        }
        var out: [HighlightRange] = []
        let map = stitchMap()
        for stitched in lines {
            guard let loc = map.sourceLocation(atStitchedLine: stitched),
                  let target = rangeForStitchedLines(stitched..<(stitched + 1)) else { continue }
            for hl in highlights(for: loc.source, line: loc.line) {
                // Re-base the file-local range onto this stitched line's range.
                let length = min(hl.range.length, target.length)
                guard length > 0 else { continue }
                out.append(HighlightRange(
                    range: NSRange(location: target.location + hl.range.location, length: length),
                    capture: hl.capture, modifiers: hl.modifiers))
            }
        }
        completion(.success(out))
    }

    /// Per-file, per-line highlight ranges, parsing and caching on first use.
    private func highlights(for source: SourceID, line: Int) -> [HighlightRange] {
        if let cached = cache[source] { return cached[line] ?? [] }
        let byLine = parse(source: source)
        cache[source] = byLine
        return byLine[line] ?? []
    }

    /// Parse one file and bucket its highlight ranges by line, with each range
    /// made line-relative so projection is pure addition.
    ///
    /// Implementation note for the engineer: instantiate a `TreeSitterClient` for
    /// this file's `CodeLanguage` (from `CodeLanguage.detectLanguageFrom(url:)`),
    /// feed it `textForSource(source)`, query the whole document, then convert each
    /// absolute range into (line, line-relative range) using the file's line
    /// starts. Follow `TreeSitterClient`'s use in
    /// `Sources/Editor/CodeEditSourceEditor/Highlighting/SyntaxHighlighter.swift`.
    private func parse(source: SourceID) -> [Int: [HighlightRange]] {
        let text = textForSource(source)
        guard !text.isEmpty else { return [:] }
        let language = CodeLanguage.detectLanguageFrom(url: URL(fileURLWithPath: source.path))
        return TreeSitterLineHighlighter.highlightByLine(text: text, language: language)
    }
}
```

- [ ] **Step 3: Write the per-file parse helper**

Append to the same file:

```swift
/// One-shot whole-file tree-sitter highlighting, bucketed by line.
///
/// Separate from `MultiHighlighter` so the parsing concern is isolated and can be
/// swapped for an incremental client once excerpt virtualization lands (spec §9 —
/// N live clients on a 50-file diff is the memory risk).
enum TreeSitterLineHighlighter {
    static func highlightByLine(text: String, language: CodeLanguage) -> [Int: [HighlightRange]] {
        var byLine: [Int: [HighlightRange]] = [:]
        let lineStarts = lineStartOffsets(text)
        for hl in wholeDocumentHighlights(text: text, language: language) {
            guard let line = lineStarts.lastIndex(where: { $0 <= hl.range.location }) else { continue }
            let relative = NSRange(location: hl.range.location - lineStarts[line],
                                   length: hl.range.length)
            byLine[line, default: []].append(
                HighlightRange(range: relative, capture: hl.capture, modifiers: hl.modifiers))
        }
        return byLine
    }

    /// UTF-16 offset of each line's first character.
    private static func lineStartOffsets(_ text: String) -> [Int] {
        var starts = [0]
        let ns = text as NSString
        ns.enumerateSubstrings(in: NSRange(location: 0, length: ns.length),
                               options: [.byLines, .substringNotRequired]) { _, range, _, _ in
            let next = range.location + range.length + 1
            if next < ns.length { starts.append(next) }
        }
        return starts
    }

    /// Absolute-range highlights for a whole document.
    ///
    /// Implementation note for the engineer: build a `TreeSitterClient` for
    /// `language`, hand it `text`, and query the full range. Read
    /// `Sources/Editor/CodeEditSourceEditor/Highlighting/SyntaxHighlighter.swift` for
    /// the exact call sequence — it does this against the live text view, and this
    /// is the same thing against a detached string.
    private static func wholeDocumentHighlights(text: String,
                                                language: CodeLanguage) -> [HighlightRange] {
        // Returning [] renders plain (untinted) code, which is a correct, visibly
        // degraded fallback — wire the client in before finishing this task.
        []
    }
}
```

- [ ] **Step 4: Wire `wholeDocumentHighlights` to a real client and verify visually**

Replace the `return []` stub using the call sequence you read in Step 1. When
done, build and confirm the app still compiles:

```bash
cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj \
  -scheme Shepherd -configuration Debug -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -10
```

Expected: `** BUILD SUCCEEDED **`. Do not leave the stub in place — a task that
ships `return []` ships an unhighlighted diff.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/Workbench/MultiHighlighter.swift
git commit -m "$(cat <<'EOF'
feat(workbench): add MultiHighlighter, one tree-sitter client per source file

A stitched multibuffer can't be parsed as one document — its excerpts span
files and languages and are discontinuous — so each source is parsed on its own
and its ranges projected into stitched coordinates.

This is the fix for the original problem: the diff panel tokenized with
Highlight.js and remapped colors by nearest-RGB distance while the editor used
tree-sitter, so identical lines got different colors. Now there is one
tokenizer.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `WorkbenchSession` + `WorkbenchView`, and retire the old panel

Assembles everything, renders the existing review panel on the new engine, and
deletes the duplicated renderer so it cannot drift back.

**Files:**
- Create: `spike/seam1/Sources/Workbench/WorkbenchSession.swift`
- Create: `spike/seam1/Sources/Workbench/WorkbenchView.swift`
- Create: `spike/seam1/Sources/Workbench/EditorHost.swift`
- Modify: `spike/seam1/Sources/AgentStore.swift`
- Modify: `spike/seam1/Sources/ContentView.swift:33-45`
- Modify: `spike/seam1/project.yml`
- Delete: `spike/seam1/Sources/DiffPanelView.swift`

**Interfaces:**
- Consumes: everything from Tasks 3–10, plus `DiffReader.read(cwd:mode:)`, `DiffFile`, `DiffMode`, `ReviewComment`, `ReviewPrompt.compose`, `AgentStore.submitReview(_:toPane:)`, `GHReviewThread` (all existing)
- Produces:
  - `@MainActor final class WorkbenchSession: ObservableObject` — `init(paneID: String, cwd: String)`, `@Published var mode: DiffMode`, `@Published private(set) var stitchMap: StitchMap`, `@Published private(set) var blockMap: BlockMap`, `@Published var comments: [ReviewComment]`, `func load()`, `func buffer(for: SourceID) -> SourceBuffer?`
  - `struct WorkbenchView: View` — `init(session: WorkbenchSession)`
  - `struct EditorHost: NSViewRepresentable`
  - `AgentStore.workbenchSessions: [String: WorkbenchSession]`, `AgentStore.workbenchSession(forPane:) -> WorkbenchSession?`

- [ ] **Step 1: Build `WorkbenchSession` from `DiffReader`'s output**

Create `spike/seam1/Sources/Workbench/WorkbenchSession.swift`. It must:

1. Hold `paneID`, `cwd`, `mode`, a `[SourceID: SourceBuffer]`, a `StitchMap`, a
   `BlockMap`, and `comments: [ReviewComment]`.
2. In `load()`, call `DiffReader.read(cwd:mode:)` **off the main thread**
   (`DispatchQueue.global(qos: .userInitiated)`) — it spawns `git`, and running a
   `Process` during a SwiftUI layout pass crashes the update cycle. This is the
   same discipline `DiffReviewModel.load` used.
3. Convert each `DiffFile`'s hunks into `Excerpt`s (`kind: .hunk`), in file order,
   and build the `StitchMap`.
4. Insert one `.fileHeader` `Block` above each file's first excerpt, and a
   `.deletedLines` `Block` for each run of removed lines.
5. Create a `SourceBuffer` per file, call `startWatching()`, and set
   `onExternalWrite` to re-run `load()` for a following buffer.
6. On a buffer edit, call `stitchMap.applyEdit(in:atLine:lineDelta:)`,
   `blockMap.shift(fromStitchedLine:by:)`, and `MultiHighlighter.invalidate(source:)`.
   No `git` call — that is the point of holding `baseText` in the buffer.

- [ ] **Step 2: Build `EditorHost`**

Create `spike/seam1/Sources/Workbench/EditorHost.swift`: an `NSViewRepresentable`
hosting a vendored `TextView` in an `NSScrollView`, with a `DiffGutterView` beside
it. In `makeNSView`:

1. Set `textView.layoutManager.renderDelegate` to the session's `BlockRenderer`.
2. Set the session's `MultiHighlighter` as the text view's highlight provider.
3. Set `lineHeightMultiple` to `Theme.lineHeightMultiple`.
4. Drive `DiffGutterView.rows` from `layoutManager.rectsFor(range:)` per stitched
   line, refreshed on scroll and on text change.

- [ ] **Step 3: Build `WorkbenchView`**

Create `spike/seam1/Sources/Workbench/WorkbenchView.swift`: the rail (scope list,
file list grouped under dim uppercase directory headers with `⊞`/`◉`/`⊟` glyphs and
right-aligned diffstat, commit box), the header (summary line, Side by Side / Inline
toggle, refresh, close), and `EditorHost`. Port the comment composer, `CommentBubble`,
and `GitHubThreadView` from `DiffPanelView.swift` **verbatim** except for their
container — they are already in Shepherd's idiom and the point of this task is not
to redesign them.

- [ ] **Step 4: Swap the store and the content view over**

In `AgentStore.swift`, add `@Published var workbenchSessions: [String: WorkbenchSession] = [:]`
and a `workbenchSession(forPane:)` accessor that lazily creates one. Keep
`diffPanelOpen` and `diffPanelPaneID` as the open/close flags so `⌘G` and the
existing `ShortcutCatalog` entry keep working unchanged.

In `ContentView.swift:33`, replace `DiffPanelView()` with:

```swift
                    if store.diffPanelOpen, let pid = store.diffPanelPaneID,
                       let session = store.workbenchSession(forPane: pid) {
                        WorkbenchView(session: session)
                            .environmentObject(store)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(Theme.ground)
                            .transition(.opacity)
                    } else if let surface = store.codeSurface {
```

- [ ] **Step 5: Delete the old renderer and its dependency**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1
git rm Sources/DiffPanelView.swift
```

Remove the `Highlighter` package from `project.yml` — both the `packages:` entry
and the `- package: Highlighter` line in the `Shepherd` and `ShepherdDev` targets.
Then confirm nothing still imports it:

```bash
grep -rn "import Highlighter\|DiffSyntaxHighlighter\|DiffMetrics" Sources/ | grep -v "^Sources/Editor/"
```

Expected: no output. If `MarkdownDiffView.swift` references `DiffSyntaxHighlighter`,
route it through `MultiHighlighter` instead — do not reintroduce HighlighterSwift.

- [ ] **Step 6: Regenerate, build, and test**

```bash
cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj \
  -scheme Shepherd -configuration Debug -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -30
```

Expected: `** TEST SUCCEEDED **`, with all 46 new tests from Tasks 2–6 passing and
no regressions in the existing suite.

- [ ] **Step 7: Hand the runtime check to the user**

Do **not** `killall Shepherd` — it is the user's daily terminal. Report:

> W0 is built and the suite is green. Please launch it and check: ⌘G on a pane in
> a git repo shows the review surface; rows are tinted; line numbers and the sign
> column line up between changed and context rows; syntax colors match the editor;
> and typing in a row locks that file without freezing the others.

- [ ] **Step 8: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd
git add spike/seam1/Sources/Workbench spike/seam1/Sources/AgentStore.swift \
        spike/seam1/Sources/ContentView.swift spike/seam1/project.yml
git rm --cached spike/seam1/Sources/DiffPanelView.swift 2>/dev/null || true
git commit -m "$(cat <<'EOF'
feat(workbench): render review on the vendored engine, delete the old panel

WorkbenchSession assembles StitchMap, BlockMap, SourceBuffer, BlockRenderer,
DiffGutter, and MultiHighlighter into one editable multibuffer; WorkbenchView
is the rail + header + editor shell. The comment composer and GitHub thread
cards port over verbatim.

Deletes DiffPanelView (1026 lines) and the HighlighterSwift dependency, so the
diff and the editor now share one tokenizer, one layout engine, one row rhythm,
and one palette — and can't drift apart again.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

**Spec coverage.** §5.1 vendoring → Task 1. §5.2 `StitchMap`/`BlockMap`/`WordDiff` →
Tasks 3/4/5; `SourceBuffer` → Tasks 6–7; `MultiHighlighter` → Task 10;
`DiffGutter` → Task 9; `WorkbenchSession` → Task 11. §5.3 theme derivation →
Task 2. §5.4 layout + row anatomy → Tasks 9, 11. §5.7 deletions → Task 11.
§6 data flow → Tasks 7, 11. §8 testing → Tasks 2–6. `PatchSynth`/`ConflictParse`
→ deferred by Task 0, with the spec corrected.

**Gaps accepted for W0, to be picked up by W1:** `WidgetLayer` as a named unit
(Task 11 ports the existing comment views into the SwiftUI layer, but the
generalized `rectsFor(range:)` anchoring abstraction arrives with W1's hunk
action buttons); the `⌃1`–`⌃4` / `⌥↓` / `⌘\` shortcut registrations (they need
scopes and modes that only exist from W1); and side-by-side (Task 11 ships inline
only — two synchronized multibuffers need the staging model to know which side a
row belongs to).

**Placeholder scan.** One deliberate stub remains: `wholeDocumentHighlights`
returns `[]` in Task 10 Step 3 and is wired in Step 4, whose text forbids leaving
it. Task 11 Steps 1–3 are numbered requirement lists rather than full code — the
session and view are assembly over interfaces fully specified in Tasks 3–10, and
writing 600 speculative lines of SwiftUI here would be guessing at the vendored
API's exact labels. Every type, method, and parameter those steps reference is
defined in an earlier task's Produces block.

**Type consistency.** `SourceID(_:)` / `.path` used identically in Tasks 3–11.
`Excerpt.lineRange` is `var` (Task 3 mutates it) and read in Tasks 4, 10.
`Block.beforeStitchedLine` is `var` (Task 4 shifts it). `RowTint` is produced in
Task 8 and consumed in Task 9 — Task 9 must not run before Task 8. `NSColor(hex24:)`
is defined once, in Task 8, and used in Task 9. `FollowState` / `DiskEvent` /
`LockPolicy` names match between Tasks 6 and 7. `Theme.Diff` token names match
between Tasks 2, 8, and 9. `Theme.lineHeightMultiple` is used in Tasks 2, 9, 11.
