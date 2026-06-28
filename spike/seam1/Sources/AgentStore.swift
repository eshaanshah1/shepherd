import SwiftUI
import AppKit
import UserNotifications

/// App model: open tabs (each owning a pane tree), selection, the agent-state
/// socket (now per-pane), and tab persistence.
@MainActor
final class AgentStore: ObservableObject {
    static let shared = AgentStore()

    @Published private(set) var tabs: [Tab] = []
    @Published var selectedTab: String?

    /// Bumped to force the selected terminal to reclaim first responder
    /// (e.g. after a rename ends and the text field gives up focus).
    @Published var focusTick = 0
    func refocusActiveTerminal() { focusTick += 1 }

    /// The content area's size (SwiftUI top-left space), fed by ContentView so
    /// `focusNeighbor` can resolve geometric neighbors against the live layout.
    @Published var lastContentSize: CGSize = .zero

    /// Injected into each pane's PTY as $SHEPHERD_SOCK so the Claude plugin can reach us.
    let socketPath: String

    private var server: SocketServer?
    private let persistKey = "shepherd.tabs.v2"

    /// Attention chimes bundled with the app (done.wav / blocked.wav in
    /// Resources), retained for the app's life so playback is never cut short
    /// by deallocation.
    private let attentionSounds: [AgentState: NSSound] = {
        var m: [AgentState: NSSound] = [:]
        if let s = AgentStore.bundledSound("done")    { m[.needsCheck] = s }
        if let s = AgentStore.bundledSound("blocked") { m[.blocked]    = s }
        return m
    }()

    private static func bundledSound(_ name: String) -> NSSound? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "wav") else { return nil }
        return NSSound(contentsOf: url, byReference: false)
    }

    private init() {
        socketPath = "/tmp/shepherd-\(getpid()).sock"   // short: stays under sun_path's 104 limit
        server = SocketServer(path: socketPath) { [weak self] paneID, event, detail in
            self?.apply(event: event, detail: detail, paneID: paneID)
        }
        server?.start()
        if !restore() { newTab() }   // reopen prior tabs, else start with one
    }

    // MARK: Tabs

    @discardableResult
    func newTab() -> String {
        let tab = Tab(pane: Pane())
        tabs.append(tab)
        selectedTab = tab.tabID
        save()
        return tab.tabID
    }

    func select(tabID: String) {
        selectedTab = tabID
        guard let tab = tabs.first(where: { $0.tabID == tabID }) else { return }
        didFocus(paneID: tab.focusedPaneID)   // viewing a finished tab clears its need-to-check
    }

    func closeTab(_ tabID: String) {
        tabs.removeAll { $0.tabID == tabID }
        if selectedTab == tabID {
            selectedTab = tabs.last?.tabID
            // Reclaim focus next runloop: the closed surface's teardown resets the
            // window's first responder, clobbering any same-pass refocus.
            DispatchQueue.main.async { [weak self] in self?.refocusActiveTerminal() }
        }
        save()
        updateDockBadge()
    }

    func closeSelected() {
        if let sel = selectedTab { closeTab(sel) }
    }

    // MARK: Keyboard navigation

    func selectIndex(_ oneBased: Int) {
        let i = oneBased - 1
        guard tabs.indices.contains(i) else { return }
        select(tabID: tabs[i].tabID)
    }

    func selectNext()     { cycle(+1) }
    func selectPrevious() { cycle(-1) }

    private func cycle(_ delta: Int) {
        guard !tabs.isEmpty,
              let cur = selectedTab,
              let i = tabs.firstIndex(where: { $0.tabID == cur }) else { return }
        select(tabID: tabs[(i + delta + tabs.count) % tabs.count].tabID)
    }

    /// Jump to the next pane that needs you (blocked / need-to-check / error).
    /// Iterates panes across tabs in (tab, leaf) order, selecting the owning tab
    /// AND moving its focus to that pane.
    func selectNextAttention() {
        guard !tabs.isEmpty else { return }
        // Flatten to (tabID, paneID) in tab/leaf order; resume after the
        // currently-selected tab's focused pane.
        var flat: [(tabID: String, paneID: String)] = []
        for tab in tabs {
            for pid in tab.paneIDs { flat.append((tab.tabID, pid)) }
        }
        guard !flat.isEmpty else { return }
        let start = flat.firstIndex {
            $0.tabID == selectedTab
                && $0.paneID == tabs.first(where: { $0.tabID == selectedTab })?.focusedPaneID
        } ?? -1
        for off in 1...flat.count {
            let entry = flat[(start + off) % flat.count]
            if let tab = tabs.first(where: { $0.tabID == entry.tabID }),
               tab.root.pane(entry.paneID)?.state.wantsAttention == true {
                focusPaneSelecting(entry.paneID, in: entry.tabID)
                return
            }
        }
        NSSound.beep()   // nothing needs you
    }

    /// Select the owning tab and move its focus to `paneID`, clearing that pane's
    /// need-to-check. (Internal helper; the public split/zoom/focus mutations land
    /// in Tasks 7–9.)
    private func focusPaneSelecting(_ paneID: String, in tabID: String) {
        guard let i = tabs.firstIndex(where: { $0.tabID == tabID }) else { return }
        tabs[i].focusedPaneID = paneID
        selectedTab = tabID
        didFocus(paneID: paneID)
    }

    // MARK: Management

    func rename(tabID: String, to title: String) {
        guard let i = tabs.firstIndex(where: { $0.tabID == tabID }) else { return }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        tabs[i].userTitle = trimmed.isEmpty ? nil : trimmed
        save()
    }

    /// Live reorder during a drag — moves `tabID` to an absolute index without
    /// persisting; commitOrder() saves once the drag ends.
    func reorder(tabID: String, toIndex: Int) {
        guard let from = tabs.firstIndex(where: { $0.tabID == tabID }),
              from != toIndex, tabs.indices.contains(toIndex) else { return }
        let item = tabs.remove(at: from)
        tabs.insert(item, at: toIndex)
    }

    func commitOrder() { save() }

    /// True if `paneID` is the focused pane of the currently selected tab — i.e.
    /// the surface that should hold first responder.
    func isFocusedSurface(paneID: String) -> Bool {
        guard let tab = tabs.first(where: { $0.tabID == selectedTab }) else { return false }
        return tab.focusedPaneID == paneID
    }

    /// cwd to seed a restored pane's surface (consumed once at surface creation).
    func cwd(forPane paneID: String) -> String? {
        for tab in tabs {
            if let p = tab.root.pane(paneID) { return p.cwd }
        }
        return nil
    }

    // MARK: Feeds from libghostty

    /// Agent-state hook event (over the socket). `detail` carries the cosmetic
    /// reason field (tool_name / error_type / agent_type) for the few events that
    /// have one. The lifecycle map — see SPEC + the hooks.md analysis.
    ///
    /// Ordering guard: hooks are independent socket writes with no delivery-order
    /// guarantee, so a stale mid-turn event can arrive after `Stop`. We only let
    /// mid-turn transitions apply while the pane is actually mid-turn (working or
    /// blocked); a finished turn (need-to-check) can only be left by a real new
    /// turn (UserPromptSubmit) or by focus. This kills the "need-to-check flips
    /// back to working" bug deterministically, regardless of arrival order.
    func apply(event: String, detail: String, paneID: String) {
        guard let i = tabs.firstIndex(where: { $0.paneIDs.contains(paneID) }),
              let pane = tabs[i].root.pane(paneID) else {
            shepherdLog("event=\(event) tab=\(paneID.prefix(8)) -> NO SUCH TAB")
            return
        }
        let cur = pane.state
        let midTurn = (cur == .working || cur == .blocked)
        var applied = true
        var newState = cur
        var newReason: String? = pane.reason
        var clearTitle = false
        func set(_ s: AgentState, _ reason: String? = nil) {
            newState = s
            newReason = reason
        }

        switch event {
        case "SessionStart":      clearTitle = true; set(.idle)      // drop shell title; the agent sets its own
        case "SessionEnd":        set(.shell)                         // agent gone
        case "UserPromptSubmit":  set(.working)                       // new turn, from any state
        case "Stop":              if midTurn { set(.needsCheck) } else { applied = false }
        case "StopFailure":       if midTurn { set(.error, detail.isEmpty ? "API error" : detail) } else { applied = false }
        case "PermissionRequest":
            if midTurn { set(.blocked, detail == "ExitPlanMode" ? "plan approval"
                                     : (detail.isEmpty ? "approval needed" : "approve \(detail)")) } else { applied = false }
        case "Elicitation":       if midTurn { set(.blocked, "input requested") } else { applied = false }
        case "SubagentStart":     if midTurn { set(.working, detail.isEmpty ? "subagent" : "subagent: \(detail)") } else { applied = false }
        case "PreToolUse":
            // PreToolUse matches AskUserQuestion / ExitPlanMode (per Claude Code
            // docs) — those are "waiting on the user"; every other tool is work.
            if !midTurn { applied = false }
            else if detail == "AskUserQuestion" { set(.blocked, "answer needed") }
            else if detail == "ExitPlanMode"    { set(.blocked, "plan approval") }
            else { set(.working) }
        case "PostToolUse", "PostToolUseFailure", "SubagentStop", "ElicitationResult":
            if midTurn { set(.working) } else { applied = false }
        default:                  applied = false
        }

        shepherdLog("event=\(event)\(detail.isEmpty ? "" : "[\(detail)]") tab=\(paneID.prefix(8)) "
            + (applied ? "\(cur.rawValue)->\(newState.rawValue)" : "\(cur.rawValue) (ignored: not mid-turn)"))

        if applied {
            _ = tabs[i].root.updatePane(paneID) {
                if clearTitle { $0.title = "" }
                $0.state = newState
                $0.reason = newReason
            }
            if newState != cur, newState.wantsAttention,
               let updated = tabs[i].root.pane(paneID) {
                notifyAttention(updated)
                playAttentionSound(for: newState)
            }
            updateDockBadge()
        }
    }

    private func shepherdLog(_ msg: String) {
        let path = "/tmp/shepherd-events.log"
        guard let data = (msg + "\n").data(using: .utf8) else { return }
        if let h = FileHandle(forWritingAtPath: path) {
            defer { try? h.close() }
            h.seekToEndOfFile()
            h.write(data)
        } else {
            FileManager.default.createFile(atPath: path, contents: data)
        }
    }

    /// OSC title (SET_TITLE action). Not persisted (only userTitle is).
    func setTitle(_ title: String, paneID: String) {
        guard !title.isEmpty,
              let i = tabs.firstIndex(where: { $0.paneIDs.contains(paneID) }) else { return }
        _ = tabs[i].root.updatePane(paneID) { $0.title = title }
    }

    /// Working directory (PWD action) — tracked so we can restore it on relaunch.
    func setCwd(_ cwd: String, paneID: String) {
        guard !cwd.isEmpty,
              let i = tabs.firstIndex(where: { $0.paneIDs.contains(paneID) }),
              tabs[i].root.pane(paneID)?.cwd != cwd else { return }
        _ = tabs[i].root.updatePane(paneID) { $0.cwd = cwd }
        save()
    }

    /// A pane's surface became first responder (a click). Move the owning tab's
    /// focus to it and clear its need-to-check (subsumes didFocus). Only mutates
    /// when focusedPaneID actually changes, so the resulting updateNSView →
    /// makeFirstResponder doesn't re-enter. Clicks only reach the selected tab,
    /// so we don't touch selectedTab here.
    func focusPane(_ paneID: String) {
        guard let i = tabs.firstIndex(where: { $0.paneIDs.contains(paneID) }),
              tabs[i].focusedPaneID != paneID else { return }
        tabs[i].focusedPaneID = paneID
        didFocus(paneID: paneID)
    }

    /// Focus clears need-to-check → idle ONLY (never blocked/working).
    func didFocus(paneID: String) {
        guard let i = tabs.firstIndex(where: { $0.paneIDs.contains(paneID) }),
              tabs[i].root.pane(paneID)?.state == .needsCheck else { return }
        _ = tabs[i].root.updatePane(paneID) { $0.state = .idle }
        updateDockBadge()
    }

    /// Close a single pane. Collapses the parent split to its sibling; if it was
    /// the tab's last pane, the whole tab closes (today's `closeTab` behavior).
    func closePane(_ paneID: String) {
        guard let i = tabs.firstIndex(where: { $0.paneIDs.contains(paneID) }) else { return }
        let sibling = tabs[i].root.siblingLeaf(of: paneID)
        if let newRoot = tabs[i].root.closing(paneID: paneID) {
            tabs[i].root = newRoot
            if tabs[i].focusedPaneID == paneID {
                tabs[i].focusedPaneID = sibling ?? newRoot.firstLeafID ?? tabs[i].focusedPaneID
            }
            if tabs[i].zoomedPaneID == paneID { tabs[i].zoomedPaneID = nil }
            save()
            updateDockBadge()
        } else {
            closeTab(tabs[i].tabID)   // was the last pane → close the tab
        }
    }

    // MARK: Split / focus / zoom (keyboard-driven)

    /// True if the selected tab has more than one pane.
    var selectedTabIsSplit: Bool {
        tabs.first(where: { $0.tabID == selectedTab })?.isSplit ?? false
    }

    /// Split the selected tab's focused pane along `axis`, focusing the new pane.
    /// The new pane inherits the focused pane's cwd so it opens in the same place.
    func splitFocused(_ axis: SplitAxis) {
        guard let i = tabs.firstIndex(where: { $0.tabID == selectedTab }) else { return }
        let focused = tabs[i].focusedPaneID
        var newPane = Pane()
        newPane.cwd = tabs[i].root.pane(focused)?.cwd
        guard tabs[i].root.split(paneID: focused, axis: axis, newPane: newPane) else { return }
        tabs[i].focusedPaneID = newPane.paneID
        tabs[i].zoomedPaneID = nil
        save()
        refocusActiveTerminal()
    }

    /// Close the selected tab's focused pane (collapse sibling; last pane → close tab).
    func closeFocusedPane() {
        guard let tab = tabs.first(where: { $0.tabID == selectedTab }) else { return }
        closePane(tab.focusedPaneID)
    }

    /// Move focus to the geometric neighbor of the focused pane in `dir`.
    /// `lastContentSize` is SwiftUI top-left space — the same convention
    /// `frames`/`neighbor` assume — so we pass it through without flipping y.
    func focusNeighbor(_ dir: FocusDirection) {
        guard let i = tabs.firstIndex(where: { $0.tabID == selectedTab }) else { return }
        // Focus is locked while zoomed (iTerm-style): siblings are at 0×0, so
        // moving focus to one would misdirect input to an invisible pane.
        guard tabs[i].zoomedPaneID == nil else { return }
        let rect = CGRect(origin: .zero, size: lastContentSize)
        if let id = tabs[i].root.neighbor(of: tabs[i].focusedPaneID, dir, in: rect) {
            tabs[i].focusedPaneID = id
            refocusActiveTerminal()
        }
    }

    /// Toggle full-area zoom of the selected tab's focused pane. Transient, not persisted.
    func toggleZoom() {
        guard let i = tabs.firstIndex(where: { $0.tabID == selectedTab }) else { return }
        tabs[i].zoomedPaneID = tabs[i].zoomedPaneID == nil ? tabs[i].focusedPaneID : nil
        refocusActiveTerminal()
    }

    /// Resize a split by setting the ratio of the node at `path` (clamped in the
    /// tree). Called live from a divider drag; persists so the layout survives a
    /// restart.
    func setRatio(tabID: String, path: [Int], to ratio: Double) {
        guard let i = tabs.firstIndex(where: { $0.tabID == tabID }) else { return }
        tabs[i].root.setRatio(at: path, to: ratio)
        save()
    }

    /// Notification routing: select the owning tab, focus the pane, clear its
    /// need-to-check. For a 1-pane tab this is identical to today's select().
    func revealPane(_ paneID: String) {
        guard let tab = tabs.first(where: { $0.paneIDs.contains(paneID) }) else { return }
        focusPaneSelecting(paneID, in: tab.tabID)
    }

    var attentionCount: Int {
        tabs.flatMap { $0.root.panes }.filter { $0.state.wantsAttention }.count
    }

    // MARK: Attention surfacing (dock badge + backgrounded notifications)

    private func updateDockBadge() {
        let n = attentionCount
        NSApp.dockTile.badgeLabel = n > 0 ? "\(n)" : nil
    }

    /// Fire a native notification when a pane needs you — but only while Shepherd
    /// is NOT frontmost (when it is, the badge + sidebar are enough).
    private func notifyAttention(_ pane: Pane) {
        guard !NSApp.isActive else { return }
        let content = UNMutableNotificationContent()
        content.title = pane.displayTitle
        switch pane.state {
        case .blocked:    content.body = pane.reason ?? "needs you"
        case .needsCheck: content.body = "finished — needs a look"
        case .error:      content.body = "errored: \(pane.reason ?? "API error")"
        default:          return
        }
        content.userInfo = ["paneID": pane.paneID]
        content.sound = nil   // we play our own chime (playAttentionSound) — avoid a double
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "\(pane.paneID)-\(pane.state.rawValue)",
                                  content: content, trigger: nil))
    }

    /// Audible cue on entering an attention state. Always plays, foreground or
    /// background; `error` has no entry and is intentionally silent.
    private func playAttentionSound(for state: AgentState) {
        guard let sound = attentionSounds[state] else { return }
        sound.stop()   // restart if still ringing, so a rapid re-block re-pings
        sound.play()
    }

    // MARK: Persistence (structure + userTitle + cwd, in tab order)

    private struct PersistedTab: Codable {
        var userTitle: String?
        var root: SplitNode
    }

    private func save() {
        let snapshot = tabs.map { PersistedTab(userTitle: $0.userTitle, root: $0.root) }
        if let data = try? JSONEncoder().encode(snapshot) {
            UserDefaults.standard.set(data, forKey: persistKey)
        }
    }

    private func restore() -> Bool {
        guard let data = UserDefaults.standard.data(forKey: persistKey),
              let snapshot = try? JSONDecoder().decode([PersistedTab].self, from: data),
              !snapshot.isEmpty else { return false }
        tabs = snapshot.compactMap { p -> Tab? in
            // root decodes with fresh pane ids + .shell state (Pane.Codable).
            guard let first = p.root.firstLeafID else { return nil }
            var tab = Tab(pane: Pane())
            tab.userTitle = p.userTitle
            tab.root = p.root
            tab.focusedPaneID = first
            return tab
        }
        selectedTab = tabs.first?.tabID
        return !tabs.isEmpty
    }
}
