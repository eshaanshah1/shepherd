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

    /// Bumped to force the selected terminal to reclaim first responder.
    @Published var focusTick = 0
    func refocusActiveTerminal() { focusTick += 1 }

    /// The content area's size (SwiftUI top-left space), fed by ContentView so
    /// `focusNeighbor` can resolve geometric neighbors against the live layout.
    @Published var lastContentSize: CGSize = .zero

    /// Injected into each pane's PTY as $SHEPHERD_SOCK so the Claude plugin can reach us.
    let socketPath: String

    /// Machine-level "serve panes through the helper" switch. Off by default;
    /// flip with `defaults write com.shepherd.Shepherd shepherd.remote.serving -bool YES`
    /// (a real Settings toggle lands in M4). Read at pane-creation time, so it
    /// affects panes opened after it changes.
    var isServing: Bool { UserDefaults.standard.bool(forKey: "shepherd.remote.serving") }

    /// The bundled `shepherdd` helper, beside the app executable in Contents/MacOS.
    let helperPath: String = Bundle.main.executableURL?
        .deletingLastPathComponent()
        .appendingPathComponent("shepherdd").path ?? "shepherdd"

    private var server: SocketServer?
    private let persistKey = "shepherd.workspaces.v1"
    private let legacyKey  = "shepherd.tabs.v2"

    // MARK: Remote control channel (Android "monitor" host side)

    /// Set when a not-yet-known device passes the pairing code and is awaiting the
    /// user's approval; ContentView presents the approval sheet off this.
    @Published var pendingApproval: (deviceID: String, name: String)?
    private var approvalDecider: ((Bool) -> Void)?
    private var remoteServer: RemoteServer?

    /// Dedicated unix socket for shepherdd pty data streams, kept separate from
    /// socketPath (which carries newline-delimited hook JSON). Injected as
    /// $SHEPHERD_PTY_SOCK. Matches socketPath's /tmp form to stay under sun_path's 104.
    let ptySocketPath = "/tmp/shepherd-pty-\(getpid()).sock"
    private var ptyHub: PtyHub?
    private let remotePort: UInt16 = 8722
    private let pairedDevicesKey = "shepherd.remote.devices"

    /// The 4-digit code a new device must echo to start pairing. Regenerated each
    /// launch — surfaced in the host UI; not persisted.
    private(set) var pairingCode = String(format: "%04d", Int.random(in: 0...9999))

    /// Devices approved in a past session — loaded at launch so they re-pair
    /// (by secret) without another approval. Persisted to UserDefaults as JSON.
    /// Read off the accept thread by RemoteServer's `knownDevices` closure and
    /// mutated on main, so every access goes through `pairedDevicesLock`.
    private var pairedDevices: [PairedDevice] = []
    private let pairedDevicesLock = NSLock()

    /// FCM push shell (nil if no service-account key at ~/.config/shepherd) + the away
    /// signal (lid shut + no external display) + per-pane push dedup state.
    private var fcmPusher: FCMPusher?
    private let presence = PresenceMonitor()
    private var lastPushed: [String: (state: String, at: Date)] = [:]
    private let pushWindow: TimeInterval = 8

    private let attentionSounds: [AgentState: NSSound] = {
        var m: [AgentState: NSSound] = [:]
        if let s = AgentStore.bundledSound("done")    { m[.needsCheck] = s }
        if let s = AgentStore.bundledSound("blocked") { s.volume = 0.6; m[.blocked] = s }
        return m
    }()

    private static func bundledSound(_ name: String) -> NSSound? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "wav") else { return nil }
        return NSSound(contentsOf: url, byReference: false)
    }

    private init() {
        SocketServer.cleanupStale()   // sweep sockets left by dead launches (crash/killall/force-quit)
        socketPath = "/tmp/shepherd-\(getpid()).sock"   // short: stays under sun_path's 104 limit
        server = SocketServer(path: socketPath) { [weak self] paneID, event, detail in
            self?.apply(event: event, detail: detail, paneID: paneID)
        }
        server?.start()
        loadPairedDevices()
        let keyPath = ("~/.config/shepherd/fcm-service-account.json" as NSString).expandingTildeInPath
        fcmPusher = FCMPusher(serviceAccountPath: keyPath)
        presence.onChange = { [weak self] away in
            guard let self else { return }
            if away {
                // Mac just went away (lid shut) → reflow already-attached phones to their own size.
                self.remoteServer?.reapplyPhoneSizes()
            } else {
                self.runCatchUpNotifications()
                // Mac is back → the visible pane is desktop-owned again; reclaim its size.
                if let f = self.tabs.first(where: { $0.tabID == self.selectedTab })?.focusedPaneID {
                    self.snapPaneToDesktop(f)
                }
            }
        }
        presence.start()
        if !restore() { newWorkspace() }   // reopen prior workspaces, else start with one
        startRemoteServingIfEnabled()      // bind the control channel if serving is on
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
        selectedWorkspaceID = ws.id
        save()
        refocusActiveTerminal()
        return ws.id
    }

    func selectWorkspace(_ id: String) {
        guard workspaces.contains(where: { $0.id == id }) else { return }
        selectedWorkspaceID = id
        if let ws = currentWorkspace,
           let pid = ws.tabs.first(where: { $0.tabID == ws.selectedTabID })?.focusedPaneID {
            didFocus(paneID: pid)   // viewing a finished workspace clears its need-to-check
            snapPaneToDesktop(pid)
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
        let closingPaneIDs = workspaces.first { $0.id == id }?.tabs.flatMap { $0.root.panes.map(\.paneID) } ?? []
        let wasSelected = selectedWorkspaceID == id
        workspaces = remaining
        postPaneClosed(closingPaneIDs)
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
        snapPaneToDesktop(tab.focusedPaneID)
    }

    func closeTab(_ tabID: String) {
        guard let w = currentWorkspaceIndex else { return }
        closeTabInWorkspace(w, tabID: tabID)
    }

    /// closeTab targeting a specific workspace; reseeds a fresh tab if it was the
    /// last one so a workspace is never empty (⌘W no longer closes the window).
    private func closeTabInWorkspace(_ w: Int, tabID: String) {
        let wasSelected = workspaces[w].selectedTabID == tabID
        let closingPaneIDs = workspaces[w].tabs.first { $0.tabID == tabID }?.root.panes.map(\.paneID) ?? []
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
        postPaneClosed(closingPaneIDs)
    }

    func closeSelected() { if let sel = selectedTab { closeTab(sel) } }

    /// Free the surfaces of these panes (closing each PTY + its child) by asking
    /// their views to tear down now — SwiftUI won't deinit them deterministically.
    private func postPaneClosed(_ ids: [String]) {
        for id in ids {
            NotificationCenter.default.post(name: .shepherdPaneClosed, object: nil, userInfo: ["paneID": id])
            remoteServer?.broadcast(.paneRemoved(paneID: id))
        }
    }

    /// Free every pane's surface — used on app quit so the shepherdd helpers and
    /// their shells don't reparent to launchd as orphans.
    func teardownAllPanes() {
        postPaneClosed(workspaces.flatMap { $0.tabs.flatMap { $0.root.panes.map(\.paneID) } })
    }

    /// Unlinks this launch's own socket file — the graceful-quit counterpart to
    /// `SocketServer.cleanupStale()`'s sweep of other launches' dead sockets.
    func teardownSocket() {
        server?.stop()
        ptyHub?.stop(); ptyHub = nil   // wakes any live data-channel read loop
    }

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

    /// Agent-state hook event: resolve the pane, fold the event through the pure
    /// `applyEvent` (lifecycle map + ordering guard + background-agent counter; see
    /// StopPolicy and ADR 0004), then surface the result (sidebar / badge / alert).
    func apply(event: String, detail: String, paneID: String) {
        guard let (w, t) = locatePane(paneID, in: workspaces),
              let pane = workspaces[w].tabs[t].root.pane(paneID) else {
            shepherdLog("event=\(event) tab=\(paneID.prefix(8)) -> NO SUCH TAB")
            return
        }
        let cur = pane.state
        let res = applyEvent(event, detail: detail, current: cur, reason: pane.reason)

        let suffix: String
        if res.heldForBackground {
            suffix = "\(cur.rawValue) (held: \(detail) background task\(detail == "1" ? "" : "s"))"
        } else if res.applied {
            suffix = "\(cur.rawValue)->\(res.state.rawValue)"
        } else {
            suffix = "\(cur.rawValue) (ignored: not mid-turn)"
        }
        shepherdLog("event=\(event)\(detail.isEmpty ? "" : "[\(detail)]") tab=\(paneID.prefix(8)) " + suffix)

        guard res.applied else { return }
        _ = workspaces[w].tabs[t].root.updatePane(paneID) {
            if res.clearTitle { $0.title = "" }
            $0.state = res.state
            $0.reason = res.reason
        }
        if res.state != cur, res.state.wantsAttention,
           let updated = workspaces[w].tabs[t].root.pane(paneID) {
            let routing = NotificationRoutingPolicy.decide(isAway: isAway())
            if routing.local {
                notifyAttention(updated, inWorkspace: workspaces[w].id)
                playAttentionSound(for: res.state)
            }
            if routing.fcm { pushWake(paneID: paneID, state: res.state) }
        }
        updateDockBadge()
        remoteServer?.broadcast(.state(paneID: paneID, state: res.state.rawValue, reason: res.reason))
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
        snapPaneToDesktop(paneID)
    }

    /// The pane's desktop grid (the broker's launch size), or nil if no live broker.
    func desktopWinsize(for paneID: String) -> (Int, Int)? {
        guard let b = ptyHub?.broker(for: paneID) else { return nil }
        return (b.desktopCols, b.desktopRows)
    }

    /// A pane just became the visible tab's focused pane — reclaim its PTY size from any
    /// phone by forcing it back to the desktop grid (a desktop refocus is authoritative).
    private func snapPaneToDesktop(_ paneID: String) {
        guard let (dc, dr) = desktopWinsize(for: paneID) else { return }
        remoteServer?.applyResizeForcingDesktop(paneID: paneID, cols: dc, rows: dr)
    }

    /// Focus dismisses any notification this pane fired (it pulled you here, so
    /// its banner is now stale) and clears need-to-check → idle ONLY (never
    /// blocked/working — those clear when the agent itself moves on).
    func didFocus(paneID: String) {
        dismissNotifications(forPane: paneID)
        guard let (w, t) = locatePane(paneID, in: workspaces),
              workspaces[w].tabs[t].root.pane(paneID)?.state == .needsCheck else { return }
        _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.state = .idle }
        updateDockBadge()
    }

    /// Pull this pane's delivered banners out of Notification Center across every
    /// state that fires one (identifier is `"{paneID}-{state}"`).
    private func dismissNotifications(forPane paneID: String) {
        let ids = [AgentState.blocked, .needsCheck, .error].map { "\(paneID)-\($0.rawValue)" }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
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
            postPaneClosed([paneID])
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
            snapPaneToDesktop(id)
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
        selectedWorkspaceID = workspaces[w].id
        workspaces[w].tabs[t].focusedPaneID = paneID
        workspaces[w].selectedTabID = workspaces[w].tabs[t].tabID
        didFocus(paneID: paneID)
        refocusActiveTerminal()
    }

    var attentionCount: Int { totalAttentionCount(in: workspaces) }

    var hasBusyAgent: Bool { anyAgentBusy(in: workspaces) }

    // MARK: Attention surfacing (dock badge + notifications + sound)

    private func updateDockBadge() {
        let n = attentionCount
        NSApp.dockTile.badgeLabel = n > 0 ? "\(n)" : nil
        SleepGuard.shared.update(hasBusyAgent: hasBusyAgent)
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

    // MARK: Remote control channel

    /// Project every pane across every workspace to the client-facing `PaneInfo`.
    /// The pure mapping lives in `buildSnapshot` (RemoteProtocol) so it's testable.
    func fleetSnapshot() -> [PaneInfo] {
        buildSnapshot(workspaces.enumerated().flatMap { (i, ws) in
            ws.tabs.flatMap { $0.root.panes.map {
                (ws.displayName(index: i), $0.paneID, $0.displayTitle, $0.state.rawValue, $0.reason)
            } }
        })
    }

    /// Start the control server, bound to the Tailscale interface, when serving is
    /// on. No-op if already running, serving is off, or Tailscale is down (no 100.x).
    func startRemoteServingIfEnabled() {
        guard isServing, remoteServer == nil, let ip = RemoteServer.currentTailscaleIPv4() else { return }
        // Bring the pty-data hub up before the control server so a fast first data
        // connection finds its broker.
        let hub = PtyHub(socketPath: ptySocketPath, makeBroker: { PtyBroker(paneID: $0, cols: $1, rows: $2) })
        _ = hub.start()
        ptyHub = hub
        let s = RemoteServer(
            bindAddress: ip, port: remotePort,
            currentCode: { [weak self] in self?.pairingCode ?? "" },
            knownDevices: { [weak self] in
                guard let self else { return [] }
                self.pairedDevicesLock.lock(); defer { self.pairedDevicesLock.unlock() }
                return self.pairedDevices
            },
            persist: { [weak self] dev in self?.addPairedDevice(dev) },
            requestApproval: { [weak self] deviceID, name, decide in
                DispatchQueue.main.async {
                    self?.approvalDecider = decide
                    self?.pendingApproval = (deviceID, name)
                }
            },
            // fleetSnapshot reads @Published workspaces, so it must run on main. This is
            // called from RemoteServer's connQueue (admit), never under any RemoteServer
            // lock; main never blocks on connQueue/writeQueue (broadcast is async), so the
            // main.sync can't deadlock. The [weak self] nil-guard returns [] if torn down.
            snapshot: { [weak self] in
                guard let self else { return [] }
                // admit() runs on connQueue for a known device but on the MAIN thread for a
                // new-device approval (respondToApproval → decider → admit). main.sync from
                // main is a libdispatch reentrancy trap, so call directly when already on main.
                if Thread.isMainThread { return self.fleetSnapshot() }
                return DispatchQueue.main.sync { self.fleetSnapshot() }
            },
            updateFCMToken: { [weak self] id, token in self?.updateFCMToken(deviceID: id, token: token) },
            makeSecret: { UUID().uuidString }, makeNonce: { UUID().uuidString },
            // Capture the hub ONCE (just created above) rather than re-reading self.ptyHub
            // per call: that property is written on main but this closure runs on
            // RemoteServer's connQueue, so re-reading it would be an unsynchronized data race.
            lookupBroker: { [weak hub] in hub?.broker(for: $0) },
            // The phone owns a pane's size unless that pane is the focused pane of the
            // visible tab. selectedTab reads @Published state, so hop to main (mirrors the
            // snapshot closure); direct if already there. Fails open to phone-owned.
            sizeArbiter: { [weak self] paneID in
                guard let self else { return true }
                let read = {
                    // Mac away (lid shut, no external display) → it's showing nothing, so the phone
                    // owns every pane. Otherwise the desktop owns only its focused/visible pane.
                    if self.presence.isAway { return true }
                    let tab = self.tabs.first { $0.tabID == self.selectedTab }
                    return phoneOwnsSize(paneID: paneID,
                                         focusedPaneID: tab?.focusedPaneID,
                                         selectedTabHasPane: tab?.paneIDs.contains(paneID) ?? false)
                }
                return Thread.isMainThread ? read() : DispatchQueue.main.sync(execute: read)
            },
            // The desktop grid to snap a pane back to on detach — the broker's launch size.
            // Capture the hub (not self.ptyHub) to avoid the connQueue data race noted above.
            desktopSize: { [weak hub] paneID in hub?.broker(for: paneID).map { ($0.desktopCols, $0.desktopRows) } })
        if s.start() {
            remoteServer = s
            shepherdLog("REMOTE serving on \(ip):\(remotePort) — pairing code \(pairingCode)")
        }
    }

    /// The user's verdict on a pending pairing request (from the approval sheet).
    func respondToApproval(_ ok: Bool) {
        approvalDecider?(ok); approvalDecider = nil; pendingApproval = nil
    }

    /// True when you're away from this Mac: lid shut AND no external display attached.
    private func isAway() -> Bool { presence.isAway }

    /// Fire a data-only FCM wake to every paired device, deduped. Reads PERSISTED tokens
    /// (push needs no live control channel). Off-main (network); prunes dead tokens.
    private func pushWake(paneID: String, state: AgentState) {
        guard isServing, let pusher = fcmPusher else { return }
        let now = Date()
        guard PushDecision.shouldPush(paneID: paneID, state: state.rawValue,
                                      lastPushed: lastPushed, now: now, window: pushWindow) else { return }
        lastPushed[paneID] = (state.rawValue, now)
        pairedDevicesLock.lock(); let tokens = pairedDevices.compactMap { $0.fcmToken }; pairedDevicesLock.unlock()
        guard !tokens.isEmpty else { return }
        let urgent = (state == .blocked || state == .error)
        Task { [weak self] in
            let dead = await pusher.wake(tokens: tokens, paneID: paneID, state: state.rawValue, urgent: urgent)
            if !dead.isEmpty { await MainActor.run { self?.pruneTokens(dead) } }
        }
    }

    /// Drop tokens FCM rejected as unregistered/invalid + persist.
    private func pruneTokens(_ dead: [String]) {
        pairedDevicesLock.lock()
        for i in pairedDevices.indices where dead.contains(pairedDevices[i].fcmToken ?? "") {
            pairedDevices[i].fcmToken = nil
        }
        pairedDevicesLock.unlock()
        savePairedDevices()
    }

    /// A paired device rotated its FCM token (refreshFCMToken on the control channel).
    private func updateFCMToken(deviceID: String, token: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.pairedDevicesLock.lock()
            if let i = self.pairedDevices.firstIndex(where: { $0.deviceID == deviceID }) {
                self.pairedDevices[i].fcmToken = token
            }
            self.pairedDevicesLock.unlock()
            self.savePairedDevices()
        }
    }

    /// On the away→present edge: desktop-banner (no sound) every pane still needing attention.
    private func runCatchUpNotifications() {
        let panes: [(id: String, state: AgentState)] = workspaces.flatMap { ws in
            ws.tabs.flatMap { $0.root.panes.map { ($0.paneID, $0.state) } }
        }
        let ids = Set(NotificationRoutingPolicy.catchUpTargets(panes))
        guard !ids.isEmpty else { return }
        for (w, ws) in workspaces.enumerated() {
            for tab in ws.tabs {
                for pane in tab.root.panes where ids.contains(pane.paneID) {
                    notifyAttention(pane, inWorkspace: workspaces[w].id)
                }
            }
        }
    }

    /// Record a newly paired device and persist the set. The server's `persist`
    /// closure runs off the accept thread, so hop to main before touching state.
    private func addPairedDevice(_ dev: PairedDevice) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.pairedDevicesLock.lock()
            self.pairedDevices.append(dev)
            self.pairedDevicesLock.unlock()
            self.savePairedDevices()
        }
    }

    private func loadPairedDevices() {
        guard let data = UserDefaults.standard.data(forKey: pairedDevicesKey),
              let devs = try? JSONDecoder().decode([PairedDevice].self, from: data) else { return }
        pairedDevicesLock.lock()
        pairedDevices = devs
        pairedDevicesLock.unlock()
    }

    private func savePairedDevices() {
        pairedDevicesLock.lock()
        let snapshot = pairedDevices
        pairedDevicesLock.unlock()
        if let data = try? JSONEncoder().encode(snapshot) {
            UserDefaults.standard.set(data, forKey: pairedDevicesKey)
        }
    }
}
