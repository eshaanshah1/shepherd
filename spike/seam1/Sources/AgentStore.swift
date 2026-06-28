import SwiftUI
import AppKit
import UserNotifications

/// App model: workspaces (each owning tabs, each tab a pane tree), selection, the
/// agent-state socket (per-pane), and persistence. `tabs`/`selectedTab` are
/// computed views of the CURRENT workspace, so UI code that predates workspaces
/// keeps working unchanged. Socket/attention methods span ALL workspaces.
@MainActor
final class AgentStore: ObservableObject {
    static let shared = AgentStore()

    @Published private(set) var workspaces: [Workspace] = []
    @Published var selectedWorkspaceID: String?

    /// Set by the `+` button / ⌘⇧N to ask the UI for a name before creating a
    /// workspace; ContentView presents the naming modal off this.
    @Published var promptingNewWorkspace = false

    /// True when the most recent switch moved forward (to a higher index) — drives
    /// the sidebar slide direction.
    @Published private(set) var lastSwitchForward = true

    /// Bumped to force the selected terminal to reclaim first responder.
    @Published var focusTick = 0
    func refocusActiveTerminal() { focusTick += 1 }

    /// The content area's size (SwiftUI top-left space), fed by ContentView so
    /// `focusNeighbor` can resolve geometric neighbors against the live layout.
    @Published var lastContentSize: CGSize = .zero

    /// Injected into each pane's PTY as $SHEPHERD_SOCK so the Claude plugin can reach us.
    let socketPath: String

    private var server: SocketServer?
    private let persistKey = "shepherd.workspaces.v1"
    private let legacyKey  = "shepherd.tabs.v2"

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
        if !restore() { newWorkspace() }   // reopen prior workspaces, else start with one
    }

    // MARK: Current-workspace accessors

    var currentWorkspaceIndex: Int? { workspaces.firstIndex { $0.id == selectedWorkspaceID } }
    var currentWorkspace: Workspace? { currentWorkspaceIndex.map { workspaces[$0] } }

    /// The current workspace's tabs/selection. get/set so existing UI keeps reading
    /// `store.tabs` / `store.selectedTab`; mutations write back via Swift's
    /// get-modify-set writeback for computed properties.
    var tabs: [Tab] {
        get { currentWorkspace?.tabs ?? [] }
        set { if let i = currentWorkspaceIndex { workspaces[i].tabs = newValue } }
    }
    var selectedTab: String? {
        get { currentWorkspace?.selectedTabID }
        set { if let i = currentWorkspaceIndex { workspaces[i].selectedTabID = newValue } }
    }

    /// A tab by id across ALL workspaces (ContentView mounts every workspace's tabs).
    func anyTab(_ tabID: String) -> Tab? {
        for ws in workspaces { if let t = ws.tabs.first(where: { $0.tabID == tabID }) { return t } }
        return nil
    }

    // MARK: Workspaces

    @discardableResult
    func newWorkspace() -> String {
        let tab = Tab(pane: Pane())
        let ws = Workspace(tabs: [tab], selectedTabID: tab.tabID)
        workspaces.append(ws)
        lastSwitchForward = true
        selectedWorkspaceID = ws.id
        save()
        refocusActiveTerminal()
        return ws.id
    }

    func selectWorkspace(_ id: String) {
        guard let to = workspaces.firstIndex(where: { $0.id == id }) else { return }
        if let from = currentWorkspaceIndex { lastSwitchForward = to >= from }
        selectedWorkspaceID = id
        if let ws = currentWorkspace,
           let pid = ws.tabs.first(where: { $0.tabID == ws.selectedTabID })?.focusedPaneID {
            didFocus(paneID: pid)   // viewing a finished workspace clears its need-to-check
        }
        refocusActiveTerminal()
    }

    func renameWorkspace(_ id: String, to title: String) {
        guard let i = workspaces.firstIndex(where: { $0.id == id }) else { return }
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        workspaces[i].userTitle = t.isEmpty ? nil : t
        save()
    }

    func reorderWorkspace(_ id: String, toIndex: Int) {
        guard let from = workspaces.firstIndex(where: { $0.id == id }),
              from != toIndex, workspaces.indices.contains(toIndex) else { return }
        let item = workspaces.remove(at: from)
        workspaces.insert(item, at: toIndex)
        save()
    }

    /// True if any pane in the workspace is a live agent — delete should confirm.
    func workspaceHasLiveAgent(_ id: String) -> Bool {
        guard let ws = workspaces.first(where: { $0.id == id }) else { return false }
        return ws.tabs.flatMap { $0.root.panes }.contains { $0.state != .shell }
    }

    func deleteWorkspace(_ id: String) {
        let oldIndex = workspaces.firstIndex { $0.id == id } ?? 0
        guard let remaining = removingWorkspace(id, from: workspaces) else { return } // last-one guard
        let wasSelected = selectedWorkspaceID == id
        workspaces = remaining
        if wasSelected {
            let next = max(0, min(oldIndex, workspaces.count - 1))
            selectedWorkspaceID = workspaces.indices.contains(next) ? workspaces[next].id : workspaces.first?.id
            DispatchQueue.main.async { [weak self] in self?.refocusActiveTerminal() }
        }
        save()
        updateDockBadge()
    }

    func nextWorkspace() { cycleWorkspace(+1, wrap: true) }
    func prevWorkspace() { cycleWorkspace(-1, wrap: true) }
    /// Swipe steps stop at the ends (no wrap), unlike the cyclic keyboard cycle.
    func swipeToWorkspace(_ delta: Int) { cycleWorkspace(delta, wrap: false) }

    private func cycleWorkspace(_ delta: Int, wrap: Bool) {
        guard !workspaces.isEmpty, let i = currentWorkspaceIndex else { return }
        let n = workspaces.count
        let j = wrap ? ((i + delta) % n + n) % n : max(0, min(n - 1, i + delta))
        guard j != i else { return }
        selectWorkspace(workspaces[j].id)
    }

    // MARK: Tabs (current workspace)

    @discardableResult
    func newTab() -> String {
        guard let w = currentWorkspaceIndex else { return newWorkspace() }
        let tab = Tab(pane: Pane())
        workspaces[w].tabs.append(tab)
        workspaces[w].selectedTabID = tab.tabID
        save()
        return tab.tabID
    }

    func select(tabID: String) {
        selectedTab = tabID
        guard let tab = tabs.first(where: { $0.tabID == tabID }) else { return }
        didFocus(paneID: tab.focusedPaneID)   // viewing a finished tab clears its need-to-check
    }

    func closeTab(_ tabID: String) {
        guard let w = currentWorkspaceIndex else { return }
        closeTabInWorkspace(w, tabID: tabID)
    }

    /// closeTab targeting a specific workspace; reseeds a fresh tab if it was the
    /// last one so a workspace is never empty (⌘W no longer closes the window).
    private func closeTabInWorkspace(_ w: Int, tabID: String) {
        let wasSelected = workspaces[w].selectedTabID == tabID
        workspaces[w].tabs.removeAll { $0.tabID == tabID }
        if workspaces[w].tabs.isEmpty {
            workspaces[w].reseedIfEmpty()
            DispatchQueue.main.async { [weak self] in self?.refocusActiveTerminal() }
        } else if wasSelected {
            workspaces[w].selectedTabID = workspaces[w].tabs.last?.tabID
            DispatchQueue.main.async { [weak self] in self?.refocusActiveTerminal() }
        }
        save()
        updateDockBadge()
    }

    func closeSelected() { if let sel = selectedTab { closeTab(sel) } }

    // MARK: Keyboard navigation (tabs, current workspace)

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

    /// Jump to the next pane that needs you — across ALL workspaces. revealPane
    /// switches workspace + tab + focus.
    func selectNextAttention() {
        var flat: [(ws: String, pane: String)] = []
        for ws in workspaces { for tab in ws.tabs { for pid in tab.paneIDs { flat.append((ws.id, pid)) } } }
        guard !flat.isEmpty else { return }
        let curPane = currentWorkspace.flatMap { ws in
            ws.tabs.first { $0.tabID == ws.selectedTabID }?.focusedPaneID
        }
        let start = flat.firstIndex { $0.ws == selectedWorkspaceID && $0.pane == curPane } ?? -1
        for off in 1...flat.count {
            let e = flat[(start + off) % flat.count]
            if let (w, t) = locatePane(e.pane, in: workspaces),
               workspaces[w].tabs[t].root.pane(e.pane)?.state.wantsAttention == true {
                revealPane(e.pane)
                return
            }
        }
        NSSound.beep()   // nothing needs you
    }

    // MARK: Management (current workspace)

    func rename(tabID: String, to title: String) {
        guard let i = tabs.firstIndex(where: { $0.tabID == tabID }) else { return }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        tabs[i].userTitle = trimmed.isEmpty ? nil : trimmed
        save()
    }

    func reorder(tabID: String, toIndex: Int) {
        guard let from = tabs.firstIndex(where: { $0.tabID == tabID }),
              from != toIndex, tabs.indices.contains(toIndex) else { return }
        var arr = tabs
        let item = arr.remove(at: from)
        arr.insert(item, at: toIndex)
        tabs = arr
    }

    func commitOrder() { save() }

    /// True if `paneID` is the focused pane of the currently selected tab.
    func isFocusedSurface(paneID: String) -> Bool {
        guard let tab = tabs.first(where: { $0.tabID == selectedTab }) else { return false }
        return tab.focusedPaneID == paneID
    }

    /// cwd to seed a restored pane's surface (consumed once at surface creation).
    func cwd(forPane paneID: String) -> String? {
        guard let (w, t) = locatePane(paneID, in: workspaces) else { return nil }
        return workspaces[w].tabs[t].root.pane(paneID)?.cwd
    }

    // MARK: Feeds from libghostty (per-pane, ANY workspace via locatePane)

    /// Agent-state hook event. The lifecycle map + ordering guard are unchanged from
    /// the pre-workspaces version (see SPEC + ADR 0004); only pane lookup changed.
    func apply(event: String, detail: String, paneID: String) {
        guard let (w, t) = locatePane(paneID, in: workspaces),
              let pane = workspaces[w].tabs[t].root.pane(paneID) else {
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
            _ = workspaces[w].tabs[t].root.updatePane(paneID) {
                if clearTitle { $0.title = "" }
                $0.state = newState
                $0.reason = newReason
            }
            if newState != cur, newState.wantsAttention,
               let updated = workspaces[w].tabs[t].root.pane(paneID) {
                notifyAttention(updated, inWorkspace: workspaces[w].id)
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
        guard !title.isEmpty, let (w, t) = locatePane(paneID, in: workspaces) else { return }
        _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.title = title }
    }

    /// Working directory (PWD action) — tracked so we can restore it on relaunch.
    func setCwd(_ cwd: String, paneID: String) {
        guard !cwd.isEmpty, let (w, t) = locatePane(paneID, in: workspaces),
              workspaces[w].tabs[t].root.pane(paneID)?.cwd != cwd else { return }
        _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.cwd = cwd }
        save()
    }

    /// A pane's surface became first responder (a click). Move its tab's focus to it
    /// and clear its need-to-check. Clicks only reach the selected workspace/tab.
    func focusPane(_ paneID: String) {
        guard let (w, t) = locatePane(paneID, in: workspaces),
              workspaces[w].tabs[t].focusedPaneID != paneID else { return }
        workspaces[w].tabs[t].focusedPaneID = paneID
        didFocus(paneID: paneID)
    }

    /// Focus clears need-to-check → idle ONLY (never blocked/working).
    func didFocus(paneID: String) {
        guard let (w, t) = locatePane(paneID, in: workspaces),
              workspaces[w].tabs[t].root.pane(paneID)?.state == .needsCheck else { return }
        _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.state = .idle }
        updateDockBadge()
    }

    /// Close a single pane. Collapses the parent split to its sibling; if it was the
    /// tab's last pane, the tab closes (reseeding if it was the workspace's last tab).
    func closePane(_ paneID: String) {
        guard let (w, t) = locatePane(paneID, in: workspaces) else { return }
        let sibling = workspaces[w].tabs[t].root.siblingLeaf(of: paneID)
        if let newRoot = workspaces[w].tabs[t].root.closing(paneID: paneID) {
            workspaces[w].tabs[t].root = newRoot
            if workspaces[w].tabs[t].focusedPaneID == paneID {
                workspaces[w].tabs[t].focusedPaneID = sibling ?? newRoot.firstLeafID ?? workspaces[w].tabs[t].focusedPaneID
            }
            if workspaces[w].tabs[t].zoomedPaneID == paneID { workspaces[w].tabs[t].zoomedPaneID = nil }
            save()
            updateDockBadge()
        } else {
            closeTabInWorkspace(w, tabID: workspaces[w].tabs[t].tabID)   // was the tab's last pane
        }
    }

    // MARK: Split / focus / zoom (current workspace, keyboard-driven)

    var selectedTabIsSplit: Bool {
        tabs.first(where: { $0.tabID == selectedTab })?.isSplit ?? false
    }

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

    func closeFocusedPane() {
        guard let tab = tabs.first(where: { $0.tabID == selectedTab }) else { return }
        closePane(tab.focusedPaneID)
    }

    func focusNeighbor(_ dir: FocusDirection) {
        guard let i = tabs.firstIndex(where: { $0.tabID == selectedTab }) else { return }
        guard tabs[i].zoomedPaneID == nil else { return }
        let rect = CGRect(origin: .zero, size: lastContentSize)
        if let id = tabs[i].root.neighbor(of: tabs[i].focusedPaneID, dir, in: rect) {
            tabs[i].focusedPaneID = id
            refocusActiveTerminal()
        }
    }

    func toggleZoom() {
        guard let i = tabs.firstIndex(where: { $0.tabID == selectedTab }) else { return }
        tabs[i].zoomedPaneID = tabs[i].zoomedPaneID == nil ? tabs[i].focusedPaneID : nil
        refocusActiveTerminal()
    }

    func setRatio(tabID: String, path: [Int], to ratio: Double) {
        guard let i = tabs.firstIndex(where: { $0.tabID == tabID }) else { return }
        tabs[i].root.setRatio(at: path, to: ratio)
        save()
    }

    /// Notification routing / attention jump: select the owning WORKSPACE, focus the
    /// pane's tab + pane, clear need-to-check. Crosses workspace boundaries.
    func revealPane(_ paneID: String) {
        guard let (w, t) = locatePane(paneID, in: workspaces) else { return }
        if let from = currentWorkspaceIndex { lastSwitchForward = w >= from }
        selectedWorkspaceID = workspaces[w].id
        workspaces[w].tabs[t].focusedPaneID = paneID
        workspaces[w].selectedTabID = workspaces[w].tabs[t].tabID
        didFocus(paneID: paneID)
        refocusActiveTerminal()
    }

    var attentionCount: Int { totalAttentionCount(in: workspaces) }

    // MARK: Attention surfacing (dock badge + notifications + sound)

    private func updateDockBadge() {
        let n = attentionCount
        NSApp.dockTile.badgeLabel = n > 0 ? "\(n)" : nil
    }

    /// Fire a native notification when a pane needs you — while Shepherd is NOT
    /// frontmost OR the pane's workspace isn't the active one (a hidden-workspace
    /// agent has no visible sidebar dot to rely on).
    private func notifyAttention(_ pane: Pane, inWorkspace wsID: String) {
        let hidden = wsID != selectedWorkspaceID
        guard !NSApp.isActive || hidden else { return }
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

    private func playAttentionSound(for state: AgentState) {
        guard let sound = attentionSounds[state] else { return }
        sound.stop()
        sound.play()
    }

    // MARK: Persistence (workspaces.v1, with one-time v2 migration)

    private func save() {
        let state = snapshotState(workspaces, selectedWorkspaceID: selectedWorkspaceID)
        if let data = try? JSONEncoder().encode(state) {
            UserDefaults.standard.set(data, forKey: persistKey)
        }
    }

    private func restore() -> Bool {
        let defaults = UserDefaults.standard
        var state: PersistedState?
        if let data = defaults.data(forKey: persistKey) {
            state = try? JSONDecoder().decode(PersistedState.self, from: data)
        } else if let legacy = defaults.data(forKey: legacyKey) {
            state = migrateLegacyTabs(legacy)   // one-time v2 → v1 wrap
        }
        guard let state, !state.workspaces.isEmpty else { return false }
        workspaces = buildWorkspaces(from: state)
        guard !workspaces.isEmpty else { return false }
        let i = workspaces.indices.contains(state.selectedWorkspaceIndex) ? state.selectedWorkspaceIndex : 0
        selectedWorkspaceID = workspaces[i].id
        save()   // re-persist in v1 form
        return true
    }
}
