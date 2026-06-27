# Command Deck UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign Shepherd's chrome into a "command deck" — a mission-control sidebar driven by a functional state palette — fix the keyboard-focus-sink bug, and theme the libghostty grid to match.

**Architecture:** Centralize colors/type in a `Theme.swift`. Replace the focus-stealing SwiftUI `List` with a custom `ScrollView` of tappable rows (kills the focus sink *and* the default styling in one move); route first-responder to the terminal on selection. Add a transient `stateSince` to drive an elapsed timer. Theme the window chrome (hidden titlebar, dark) and inject a matching libghostty config string.

**Tech Stack:** SwiftUI + AppKit + GhosttyKit (C API). xcodegen project at `spike/seam1/`. No test target — verify by building and running.

## Global Constraints

- App sources live in `spike/seam1/Sources/`. After adding/removing any `.swift` file you MUST run `xcodegen generate` (else it isn't compiled).
- Build/run flow (run from `spike/seam1/`):
  ```sh
  xcodegen generate
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
    -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
    CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
  APP=./build/Build/Products/Debug/Shepherd.app
  codesign --force --deep --sign - "$APP"
  killall Shepherd 2>/dev/null; open "$APP"
  ```
- libghostty C API calls happen on the main thread.
- SourceKit shows false "cannot find type" errors in this repo — `xcodebuild` is ground truth; ignore editor noise.
- Match existing Swift style; comments only for non-obvious "why".
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Palette (verbatim): `ground #15171C`, `raised #1E2128`, `hairline #272B33`, `textPrimary #E6E8EC`, `textSecondary #8A909B`, `textDim #5A606B`, `working #4DA3FF`, `needsCheck #3FB950`, `blocked #FFB454`, `error #FF5C5C`, `idle #7C828D`.
- State-color remap: `blocked`=amber, `needsCheck`=green, `error`=red, `idle`=slate, `working`=azure, `shell`=dim.
- Type: tab names SF Pro Text 13 medium; status/summary/wordmark SF Mono 11.
- Terminal theme loads as the *base*; `~/.config/ghostty` must still override it.

---

### Task 1: Theme tokens + state-color remap

**Files:**
- Create: `spike/seam1/Sources/Theme.swift`
- Modify: `spike/seam1/Sources/AgentState.swift:14-23` (the `color` switch)

**Interfaces:**
- Produces: `enum Theme` with static `Color` tokens — `ground`, `raised`, `hairline`, `textPrimary`, `textSecondary`, `textDim`, and state colors `working`, `needsCheck`, `blocked`, `error`, `idle`. Also `Color(hex:)` init. Later tasks read these.

- [ ] **Step 1: Create the theme file**

```swift
// Theme.swift
import SwiftUI

extension Color {
    /// #RRGGBB hex (no alpha).
    init(hex: UInt32) {
        self.init(.sRGB,
                  red:   Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8)  & 0xFF) / 255,
                  blue:  Double( hex        & 0xFF) / 255)
    }
}

/// Command Deck design tokens. Colors are functional: each state color *means*
/// a state in the agent lifecycle.
enum Theme {
    static let ground        = Color(hex: 0x15171C)
    static let raised        = Color(hex: 0x1E2128)
    static let hairline      = Color(hex: 0x272B33)
    static let textPrimary   = Color(hex: 0xE6E8EC)
    static let textSecondary = Color(hex: 0x8A909B)
    static let textDim        = Color(hex: 0x5A606B)

    static let working   = Color(hex: 0x4DA3FF)   // busy — leave it
    static let needsCheck = Color(hex: 0x3FB950)  // done — ready for you
    static let blocked   = Color(hex: 0xFFB454)   // your move
    static let error     = Color(hex: 0xFF5C5C)   // broke
    static let idle      = Color(hex: 0x7C828D)   // between turns
}
```

- [ ] **Step 2: Point `AgentState.color` at the tokens (with the remap)**

Replace the `color` computed property body in `AgentState.swift`:

```swift
var color: Color {
    switch self {
    case .shell:      return Theme.textDim
    case .working:    return Theme.working
    case .blocked:    return Theme.blocked
    case .needsCheck: return Theme.needsCheck
    case .idle:       return Theme.idle
    case .error:      return Theme.error
    }
}
```

- [ ] **Step 3: Regenerate + build**

Run (from `spike/seam1/`): `xcodegen generate` then the `xcodebuild` line from Global Constraints.
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Commit**

```bash
git add spike/seam1/Sources/Theme.swift spike/seam1/Sources/AgentState.swift
git commit -m "ui: add Theme tokens + remap state colors (command deck palette)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `stateSince` timestamp + elapsed helper

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift` (the `Agent` struct ~7-20; `newTab` ~48; `restore` ~249; `apply`'s `set(...)` ~137; `didFocus` ~201)

**Interfaces:**
- Produces: `Agent.stateSince: Date` (transient, not persisted), set on every state change. `Agent.elapsedLabel` → `String?` ("0:42" / "1:23:05"; nil for shell). Sidebar (Task 3) reads `elapsedLabel`.

- [ ] **Step 1: Add the field + label to `Agent`**

Add to the `Agent` struct (after `var reason: String?`):

```swift
    var stateSince: Date = Date()   // when `state` last changed; drives the elapsed label
```

Add this computed property to `Agent` (after `displayTitle`):

```swift
    /// "m:ss" (or "h:mm:ss") since the current state began; nil for plain shells.
    var elapsedLabel: String? {
        guard state != .shell else { return nil }
        let s = max(0, Int(Date().timeIntervalSince(stateSince)))
        let (h, m, sec) = (s / 3600, (s % 3600) / 60, s % 60)
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec)
                     : String(format: "%d:%02d", m, sec)
    }
```

- [ ] **Step 2: Stamp `stateSince` wherever state changes**

In `apply`, update the local `set` helper so every transition stamps the time:

```swift
        func set(_ s: AgentState, _ reason: String? = nil) {
            tabs[i].state = s
            tabs[i].reason = reason
            tabs[i].stateSince = Date()
        }
```

In `didFocus`, stamp when it flips to idle:

```swift
        if tabs[i].state == .needsCheck { tabs[i].state = .idle; tabs[i].stateSince = Date(); updateDockBadge() }
```

(`newTab`/`restore` create `Agent` with the default `stateSince = Date()`, so no change needed there.)

- [ ] **Step 3: Build**

Run the `xcodebuild` line. Expected: `** BUILD SUCCEEDED **`. (No file added, so `xcodegen generate` not required — but harmless.)

- [ ] **Step 4: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift
git commit -m "model: track stateSince per tab for elapsed display

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Command-deck sidebar (replaces List; fixes focus)

This is the core task: it removes the focus-stealing `List`, builds the custom row + header + footer, drives the elapsed tick, and routes keystrokes to the PTY. Drag-reorder is intentionally deferred to Task 4 so this task is reviewable on its own.

**Files:**
- Rewrite: `spike/seam1/Sources/SidebarView.swift`
- Modify: `spike/seam1/Sources/AgentStore.swift` (add `focusTick`)
- Modify: `spike/seam1/Sources/GhosttyTerminal.swift` (consume `focusTick` to re-assert focus)
- Modify: `spike/seam1/Sources/ContentView.swift` (pass `focusTick` to each terminal)

**Interfaces:**
- Consumes: `Theme.*` (Task 1), `Agent.elapsedLabel`/`state`/`displayTitle`/`reason` (Task 2).
- Produces: `AgentStore.focusTick: Int` + `func refocusActiveTerminal()`; `AgentStore.fleetSummary: String`. `GhosttyTerminal(tabID:isSelected:focusTick:)` new signature.

- [ ] **Step 1: Add focus re-assertion + fleet summary to the store**

In `AgentStore`, add published state near `@Published var selected`:

```swift
    /// Bumped to force the selected terminal to reclaim first responder
    /// (e.g. after a rename ends and the text field gives up focus).
    @Published var focusTick = 0
    func refocusActiveTerminal() { focusTick += 1 }
```

Add a computed summary (after `attentionCount`):

```swift
    /// One-line fleet status for the sidebar header.
    var fleetSummary: String {
        let agents = tabs.filter { $0.state.isAgent }
        if agents.isEmpty { return "no agents" }
        let working = agents.filter { $0.state == .working }.count
        let needs = agents.filter { $0.state.wantsAttention }.count
        var parts: [String] = []
        if working > 0 { parts.append("\(working) working") }
        if needs > 0   { parts.append("\(needs) needs you") }
        return parts.isEmpty ? "all idle" : parts.joined(separator: " · ")
    }
```

- [ ] **Step 2: Thread `focusTick` through the terminal**

In `ContentView.swift`, pass it in the `ForEach`:

```swift
                ForEach(store.tabs) { tab in
                    GhosttyTerminal(tabID: tab.tabID,
                                    isSelected: tab.tabID == store.selected,
                                    focusTick: store.focusTick)
                        .opacity(tab.tabID == store.selected ? 1 : 0)
                        .allowsHitTesting(tab.tabID == store.selected)
                }
```

In `GhosttyTerminal.swift`, add the property and use it in `updateNSView`:

```swift
struct GhosttyTerminal: NSViewRepresentable {
    let tabID: String
    let isSelected: Bool
    var focusTick: Int = 0   // changing this re-runs updateNSView so we can reclaim focus

    func makeNSView(context: Context) -> GhosttySurfaceView { GhosttySurfaceView(tabID: tabID) }

    func updateNSView(_ v: GhosttySurfaceView, context: Context) {
        v.setActive(isSelected)
        if isSelected, let w = v.window, w.firstResponder !== v {
            w.makeFirstResponder(v)
        }
    }
}
```

- [ ] **Step 3: Rewrite the sidebar**

Replace the entire contents of `SidebarView.swift`:

```swift
import SwiftUI

struct SidebarView: View {
    @EnvironmentObject var store: AgentStore

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(Theme.hairline)

            // 1s tick refreshes elapsed labels; cheap, always mounted.
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(store.tabs) { tab in
                            TabRow(tab: tab)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                }
            }

            Divider().overlay(Theme.hairline)
            footer
        }
        .background(Theme.ground)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("SHEPHERD")
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .tracking(2)
                .foregroundStyle(Theme.textDim)
            Text(store.fleetSummary)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Theme.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 10)
    }

    private var footer: some View {
        Button(action: { store.newTab() }) {
            HStack(spacing: 6) {
                Image(systemName: "plus")
                Text("New Tab")
                Spacer()
                Text("⌘T").foregroundStyle(Theme.textDim)
            }
            .font(.system(size: 12))
            .foregroundStyle(Theme.textSecondary)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
    }
}

private struct TabRow: View {
    @EnvironmentObject var store: AgentStore
    let tab: Agent

    @State private var editing = false
    @State private var draft = ""
    @FocusState private var focused: Bool

    private var isSelected: Bool { store.selected == tab.tabID }

    var body: some View {
        HStack(spacing: 9) {
            // Selection accent bar, colored by state.
            RoundedRectangle(cornerRadius: 1.5)
                .fill(isSelected ? tab.state.color : .clear)
                .frame(width: 3, height: 26)

            StateDot(state: tab.state)

            VStack(alignment: .leading, spacing: 1) {
                if editing {
                    TextField("name", text: $draft)
                        .textFieldStyle(.plain)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                        .focused($focused)
                        .onSubmit(commit)
                        .onExitCommand { endEditing() }
                        .onAppear { focused = true }
                } else {
                    Text(tab.displayTitle)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(tab.state == .shell ? Theme.textDim : Theme.textPrimary)
                        .lineLimit(1)
                }
                Text(subtitle)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(subtitleColor)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill(isSelected ? Theme.raised : .clear)
        )
        .contentShape(Rectangle())
        .onTapGesture { store.select(tab.tabID) }
        .contextMenu {
            Button("Rename") { beginRename() }
            Button("Close Tab") { store.closeTab(tab.tabID) }
        }
    }

    private var subtitle: String {
        if tab.state == .shell { return "shell" }
        let base = tab.reason ?? tab.state.rawValue
        if let e = tab.elapsedLabel { return "\(base) · \(e)" }
        return base
    }
    // Attention states shout in their own color; calm states stay quiet.
    private var subtitleColor: Color {
        (tab.state == .blocked || tab.state == .error) ? tab.state.color : Theme.textSecondary
    }

    private func beginRename() {
        draft = tab.userTitle ?? tab.displayTitle
        editing = true
    }
    private func commit() {
        store.rename(tabID: tab.tabID, to: draft)
        endEditing()
    }
    private func endEditing() {
        editing = false
        store.refocusActiveTerminal()   // hand keystrokes back to the PTY
    }
}

/// State indicator. `working` breathes; everything else is static.
private struct StateDot: View {
    let state: AgentState
    @State private var pulse = false

    var body: some View {
        Circle()
            .fill(state.color)
            .frame(width: 9, height: 9)
            .opacity(state == .working && pulse ? 0.35 : 1)
            .animation(state == .working
                       ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true)
                       : .default, value: pulse)
            .onAppear { pulse = true }
    }
}
```

- [ ] **Step 4: Regenerate + build**

Run `xcodegen generate` then the `xcodebuild` line. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Run and verify the focus fix + look**

```bash
APP=./build/Build/Products/Debug/Shepherd.app
codesign --force --deep --sign - "$APP"; killall Shepherd 2>/dev/null; open "$APP"
```
Verify by hand:
- Open 2+ tabs. Click a tab in the sidebar, then type — **text appears in that tab's PTY** (previously it was swallowed by the list). Click the other tab, type — goes to that PTY.
- Right-click → Rename, type a name, Enter — name changes; then type again with no click — **keystrokes go to the terminal** (refocus worked). Esc cancels a rename.
- Sidebar shows: wordmark, fleet summary, state dots (working one pulses), mono subtitle with elapsed time ticking, accent bar on the selected row, shell tabs dimmed.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/SidebarView.swift spike/seam1/Sources/AgentStore.swift \
        spike/seam1/Sources/GhosttyTerminal.swift spike/seam1/Sources/ContentView.swift
git commit -m "ui: command-deck sidebar; fix keyboard-focus sink

Replace List(selection:) — both the focus sink that swallowed keystrokes and
the source of default row styling — with a ScrollView of tappable rows.
Selection routes first responder to the terminal; rename is the only typing
capture and hands focus back on exit. Adds fleet-summary header, state dot
(pulse on working), mono status subtitle with elapsed time, selection accent bar.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Drag-to-reorder (custom DnD)

Restores the reorder capability lost with `List.onMove`.

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift` (add `move(tabID:before:)`)
- Modify: `spike/seam1/Sources/SidebarView.swift` (`TabRow` gets `.draggable` + `.dropDestination`)

**Interfaces:**
- Consumes: `store.tabs`, `store.move(fromOffsets:toOffset:)` (existing).
- Produces: `AgentStore.move(tabID: String, before targetID: String)`.

- [ ] **Step 1: Add an id-based move to the store**

```swift
    /// Move `tabID` to just before `targetID` (drag-and-drop reorder).
    func move(tabID: String, before targetID: String) {
        guard tabID != targetID,
              let from = tabs.firstIndex(where: { $0.tabID == tabID }),
              let to = tabs.firstIndex(where: { $0.tabID == targetID }) else { return }
        move(fromOffsets: IndexSet(integer: from), toOffset: to > from ? to + 1 : to)
    }
```

- [ ] **Step 2: Make rows draggable + drop targets**

In `TabRow.body`, after `.onTapGesture { store.select(tab.tabID) }` add:

```swift
        .draggable(tab.tabID) {
            // Drag preview
            Text(tab.displayTitle)
                .font(.system(size: 13, weight: .medium))
                .padding(6)
                .background(Theme.raised)
        }
        .dropDestination(for: String.self) { items, _ in
            guard let dragged = items.first else { return false }
            store.move(tabID: dragged, before: tab.tabID)
            return true
        }
```

- [ ] **Step 3: Regenerate + build**

Run `xcodegen generate` then the `xcodebuild` line. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Run and verify**

Relaunch (codesign + open). Drag a tab above/below another — order changes and persists across relaunch (order is saved via `save()` inside `move`).

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift spike/seam1/Sources/SidebarView.swift
git commit -m "ui: drag-to-reorder sidebar tabs (replaces List.onMove)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Window chrome — unified dark titlebar + seam

**Files:**
- Modify: `spike/seam1/Sources/ShepherdApp.swift` (window style + dark scheme)
- Modify: `spike/seam1/Sources/ContentView.swift` (backdrop = `ground`; hairline seam)

**Interfaces:**
- Consumes: `Theme.ground`, `Theme.hairline`.

- [ ] **Step 1: Hidden titlebar + dark chrome**

In `ShepherdApp.swift`, update the `WindowGroup`:

```swift
        WindowGroup {
            ContentView()
                .environmentObject(AgentStore.shared)
                .frame(minWidth: 900, minHeight: 560)
                .preferredColorScheme(.dark)
        }
        .windowStyle(.hiddenTitleBar)
```

- [ ] **Step 2: Backdrop + seam in ContentView**

Rewrite `ContentView.swift` body to use the ground color and a hairline seam (no chunky divider). The terminal `GhosttyTerminal(...)` call keeps the `focusTick:` arg added in Task 3:

```swift
    var body: some View {
        HStack(spacing: 0) {
            SidebarView()
                .frame(minWidth: 200, idealWidth: 240, maxWidth: 300)
            Rectangle().fill(Theme.hairline).frame(width: 1)
            ZStack {
                Theme.ground
                ForEach(store.tabs) { tab in
                    GhosttyTerminal(tabID: tab.tabID,
                                    isSelected: tab.tabID == store.selected,
                                    focusTick: store.focusTick)
                        .opacity(tab.tabID == store.selected ? 1 : 0)
                        .allowsHitTesting(tab.tabID == store.selected)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .ignoresSafeArea()
    }
```

(Note: switching `HSplitView` → `HStack` drops live drag-resizing of the sidebar; the fixed 200–300pt range is intentional for a tab rail. If drag-resize is wanted later, revisit.)

- [ ] **Step 3: Build + run + verify**

Run `xcodebuild`, relaunch. Verify: titlebar is transparent/unified (dark flows under the traffic lights), sidebar–terminal seam is a thin hairline, no light flash anywhere, traffic-light buttons still usable (if they overlap the wordmark, add `.padding(.top, 28)` to the sidebar `header`).

- [ ] **Step 4: Commit**

```bash
git add spike/seam1/Sources/ShepherdApp.swift spike/seam1/Sources/ContentView.swift
git commit -m "ui: unified dark titlebar + hairline seam + ground backdrop

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: libghostty terminal theme

**Files:**
- Modify: `spike/seam1/Sources/Ghostty.swift:26-29` (config block)

**Interfaces:**
- Consumes: none (writes a config string into libghostty).

- [ ] **Step 1: Inject the theme as the base config**

In `Ghostty.swift`, replace the config block (currently `ghostty_config_new` → `load_default_files` → `finalize`) with a base-theme load *before* the user's files, so `~/.config/ghostty` still overrides:

```swift
        guard let cfg = ghostty_config_new() else { return }

        // Command Deck base theme. Loaded BEFORE the user's files so a personal
        // ~/.config/ghostty still wins; a fresh user gets our look.
        let theme = """
        background = 15171C
        foreground = E6E8EC
        cursor-color = 4DA3FF
        selection-background = 2E3340
        selection-foreground = E6E8EC
        palette = 0=#15171C
        palette = 8=#5A606B
        palette = 1=#FF5C5C
        palette = 9=#FF8585
        palette = 2=#3FB950
        palette = 10=#5FD974
        palette = 3=#FFB454
        palette = 11=#FFC97A
        palette = 4=#4DA3FF
        palette = 12=#7FBEFF
        palette = 5=#B98BFF
        palette = 13=#CDAEFF
        palette = 6=#4DD0C4
        palette = 14=#7FE0D6
        palette = 7=#8A909B
        palette = 15=#E6E8EC
        """
        theme.withCString { ghostty_config_load_string(cfg, $0, strlen($0)) }

        ghostty_config_load_default_files(cfg)
        ghostty_config_finalize(cfg)
```

- [ ] **Step 2: Confirm the symbol, then build**

Verify `ghostty_config_load_string` exists in the header:
```bash
grep -r "ghostty_config_load_string" vendor/GhosttyKit.xcframework/ | head -1
```
Expected: a match in the C header. **If the symbol differs** (e.g. `ghostty_config_load_cstr` / different arity), grep the header for `ghostty_config_load` and use the actual string-loading symbol with its signature — same intent (load a config string before `load_default_files`).
Then run `xcodebuild`. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Run + verify**

Relaunch. Verify: terminal grid background matches the chrome (`#15171C`) — no seam between chrome and grid; `ls`/colored output uses the new ANSI palette; cursor is azure. If you have a `~/.config/ghostty` with a `background`, confirm it still overrides (precedence works).

- [ ] **Step 4: Commit**

```bash
git add spike/seam1/Sources/Ghostty.swift
git commit -m "ui: inject Command Deck libghostty theme (user config still overrides)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (whole feature)

Relaunch and walk the spec's verification list:
- Click a tab → keystrokes hit that PTY immediately. ✔ focus fix
- Rename works and is the only typing capture; focus returns to terminal after. ✔
- State colors/pulse/accent bar render; subtitle shows state + ticking elapsed; attention states loud. ✔
- Fleet summary updates as agents change state (run `claude` in a tab to drive states; `tail -f /tmp/shepherd-events.log` to watch transitions). ✔
- Terminal grid bg matches chrome; ANSI palette themed; titlebar unified; drag-reorder works and persists. ✔

Then return to `finishing-a-development-branch` to decide merge/PR.

## Self-Review

- **Spec coverage:** palette/type tokens → T1; semantics remap → T1; elapsed timer (`stateSince` + 1s tick) → T2+T3; mission-control sidebar (wordmark, fleet summary, dot+pulse, accent bar, mono subtitle, footer) → T3; focus fix (List→ScrollView, route to PTY, rename-only capture) → T3; drag-reorder → T4; window chrome (hidden titlebar, dark, hairline, ground backdrop) → T5; libghostty theme w/ user override → T6. All covered.
- **Placeholders:** none — every code step shows complete Swift; the one runtime unknown (libghostty symbol name) has a concrete fallback in T6 S2.
- **Type consistency:** `focusTick: Int` defined in AgentStore (T3 S1), passed in ContentView (T3 S2 & T5 S2), consumed in GhosttyTerminal (T3 S2). `refocusActiveTerminal()` used in TabRow.endEditing (T3 S3). `move(tabID:before:)` defined T4 S1, used T4 S2. `elapsedLabel`/`stateSince` defined T2, read T3. Consistent.
