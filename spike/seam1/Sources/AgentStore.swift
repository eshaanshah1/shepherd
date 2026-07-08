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
    /// Client role (M2): one RemoteClient per attached host, keyed by "host:port".
    private var remoteClients: [String: RemoteClient] = [:]

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
        server = SocketServer(path: socketPath) { [weak self] paneID, event, detail, payload in
            self?.apply(event: event, detail: detail, paneID: paneID, payload: payload)
        }
        server?.start()
        loadPairedDevices()
        let keyPath = ("~/.config/shepherd/fcm-service-account.json" as NSString).expandingTildeInPath
        fcmPusher = FCMPusher(serviceAccountPath: keyPath)
        presence.onChange = { [weak self] away in
            guard let self, !away else { return }
            self.runCatchUpNotifications()   // Mac is back → replay any banners missed while away.
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
        if let (c, wid) = currentRemote { c.send(.cmdNewTab(workspaceID: wid)); return "" }  // host creates it → re-broadcasts
        let tab = Tab(pane: Pane())
        workspaces[w].tabs.append(tab)
        workspaces[w].selectedTabID = tab.tabID
        save()
        broadcastWorkspaceTree(workspaceID: workspaces[w].id)
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
        broadcastWorkspaceTree(workspaceID: workspaces[w].id)
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
        teardownRemoteClients()        // stop client connections to remote hosts
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
        broadcastCurrentWorkspaceTree()
    }

    func reorder(tabID: String, toIndex: Int) {
        guard let from = tabs.firstIndex(where: { $0.tabID == tabID }),
              from != toIndex, tabs.indices.contains(toIndex) else { return }
        var arr = tabs
        let item = arr.remove(at: from)
        arr.insert(item, at: toIndex)
        tabs = arr
    }

    func commitOrder() { save(); broadcastCurrentWorkspaceTree() }

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

    /// The one-shot `initial_input` to resume this pane's Claude session on restore, or nil if it
    /// wasn't running an agent. Consumes the stored id (cleared async so we don't mutate published
    /// state mid-view-build): resume is attempted once; a successful resume re-arms it via the
    /// agent's own SessionStart, while a dead id simply falls back to a plain shell next launch.
    func takeResumeInput(forPane paneID: String) -> String? {
        guard let (w, t) = locatePane(paneID, in: workspaces),
              let sid = workspaces[w].tabs[t].root.pane(paneID)?.sessionID, !sid.isEmpty else { return nil }
        DispatchQueue.main.async { [weak self] in
            guard let self, let (w, t) = locatePane(paneID, in: self.workspaces) else { return }
            _ = self.workspaces[w].tabs[t].root.updatePane(paneID) { $0.sessionID = nil }
            self.save()
        }
        return claudeResumeInput(sessionID: sid)
    }

    // MARK: Feeds from libghostty (per-pane, ANY workspace via locatePane)

    /// Agent-state hook event: resolve the pane, fold the event through the pure
    /// `applyEvent` (lifecycle map + ordering guard + background-agent counter; see
    /// StopPolicy and ADR 0004), then surface the result (sidebar / badge / alert).
    func apply(event: String, detail: String, paneID: String, payload: String? = nil) {
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
        // Track the live Claude session id so we can resume it on relaunch: SessionStart carries
        // the id (in detail), SessionEnd means the agent exited so there's nothing to resume.
        if event == "SessionStart", !detail.isEmpty {
            _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.sessionID = detail }
            save()
        } else if event == "SessionEnd" {
            _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.sessionID = nil }
            save()
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
        // When a pane blocks on a promptable tool, forward the structured prompt so the phone can
        // render tappable answers. AskUserQuestion carries its questions (from the hook payload);
        // permission/plan carry only their kind (+ tool name) and render fixed buttons.
        if res.state == .blocked {
            // Detect by EVENT, not detail: detail is the tool_name for BOTH PreToolUse and the
            // PermissionRequest that AskUserQuestion/ExitPlanMode also fire. Keying off detail let
            // the payload-less PermissionRequest re-broadcast an empty-questions prompt that clobbered
            // the good PreToolUse one. Permission prompts are only for OTHER tools.
            let kind: String? = {
                if event == "PreToolUse", detail == "AskUserQuestion" { return "askUserQuestion" }
                if event == "PreToolUse", detail == "ExitPlanMode" { return "plan" }
                if event == "PermissionRequest", detail != "AskUserQuestion", detail != "ExitPlanMode" { return "permission" }
                return nil
            }()
            if let kind {
                let questions: [PromptQuestion]? = (kind == "askUserQuestion")
                    ? payload.flatMap { $0.data(using: .utf8) }
                             .flatMap { try? JSONDecoder().decode([PromptQuestion].self, from: $0) }
                    : nil
                remoteServer?.broadcast(.prompt(paneID: paneID, kind: kind,
                    detail: kind == "permission" ? detail : nil, questions: questions))
            }
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
        if workspaces[w].isRemote, let h = workspaces[w].remoteHostID, let c = remoteClients[h] {
            c.send(.cmdClosePane(paneID: paneID)); return   // host closes it → re-broadcasts; surface tears down on EOF
        }
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
            broadcastWorkspaceTree(workspaceID: workspaces[w].id)
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
        if let (c, _) = currentRemote { c.send(.cmdSplit(paneID: tabs[i].focusedPaneID, axis: axis.rawValue)); return }
        let focused = tabs[i].focusedPaneID
        var newPane = Pane()
        newPane.cwd = tabs[i].root.pane(focused)?.cwd
        guard tabs[i].root.split(paneID: focused, axis: axis, newPane: newPane) else { return }
        tabs[i].focusedPaneID = newPane.paneID
        tabs[i].zoomedPaneID = nil
        save()
        refocusActiveTerminal()
        broadcastCurrentWorkspaceTree()
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
        if let (c, _) = currentRemote { c.send(.cmdZoom(paneID: tabs[i].focusedPaneID)); return }
        tabs[i].zoomedPaneID = tabs[i].zoomedPaneID == nil ? tabs[i].focusedPaneID : nil
        refocusActiveTerminal()
        broadcastCurrentWorkspaceTree()
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
        // Mirror (remote) workspaces are the host's truth — never persisted as local workspaces
        // (M3 persists them as reconnect pointers instead). Snapshot only the local ones.
        let state = snapshotState(workspaces.filter { !$0.isRemote }, selectedWorkspaceID: selectedWorkspaceID)
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

    /// Project every workspace to a client-facing `WorkspaceTree` (protocol v2): its tabs,
    /// each carrying its live `SplitNode` tree with per-pane title/state/cwd/reason. Sent on
    /// attach; a single workspace is re-sent by `broadcastWorkspaceTree` on structural change.
    func workspaceTrees() -> [WorkspaceTree] {
        workspaces.enumerated().map { (i, ws) in
            WorkspaceTree(workspaceID: ws.id, name: ws.displayName(index: i),
                          tabs: ws.tabs.map(remoteTab), selectedTabID: ws.selectedTabID)
        }
    }

    /// One tab → its wire `RemoteTab`. The projection carries the live fields `Pane.Codable`
    /// omits (title/state/reason), which the mirror needs.
    private func remoteTab(_ tab: Tab) -> RemoteTab {
        RemoteTab(tabID: tab.tabID,
                  root: buildRemoteNode(tab.root) { p in
                      RemotePane(paneID: p.paneID, title: p.displayTitle, cwd: p.cwd,
                                 state: p.state.rawValue, reason: p.reason)
                  },
                  focusedPaneID: tab.focusedPaneID, zoomedPaneID: tab.zoomedPaneID)
    }

    /// Re-broadcast ONE workspace's whole tree to attached clients — the v2 way structural
    /// change propagates (whole-tree re-snapshot, not granular deltas). No-op unless serving.
    func broadcastWorkspaceTree(workspaceID: String) {
        guard isServing, remoteServer != nil,
              let i = workspaces.firstIndex(where: { $0.id == workspaceID }) else { return }
        let ws = workspaces[i]
        let tree = WorkspaceTree(workspaceID: ws.id, name: ws.displayName(index: i),
                                 tabs: ws.tabs.map(remoteTab), selectedTabID: ws.selectedTabID)
        remoteServer?.broadcast(.workspaceTree(tree))
    }

    /// Re-broadcast the current workspace's tree — the common case for keyboard-driven
    /// structural mutations, which all act on the selected workspace.
    private func broadcastCurrentWorkspaceTree() {
        if let id = selectedWorkspaceID { broadcastWorkspaceTree(workspaceID: id) }
    }

    /// Apply a paired client's structural command to the real store (host-authoritative).
    /// Each maps to the SAME mutation the local keyboard path uses; pane-addressed commands
    /// go through `revealPane` first so they act on the right workspace/tab regardless of the
    /// desktop's current selection. A trailing tree re-broadcast guarantees the client sees
    /// the result even for the paths that don't broadcast themselves (focus/switch/rename).
    /// Runs on main (wired via the onCommand closure) — mutations touch @Published state.
    func applyRemoteCommand(_ msg: ControlMessage) {
        switch msg {
        case .cmdNewTab(let ws):            selectWorkspace(ws); _ = newTab()
        case .cmdSplit(let p, let axis):    revealPane(p); splitFocused(axis == "column" ? .column : .row)
        case .cmdClosePane(let p):          closePane(p)
        case .cmdFocusPane(let p):          revealPane(p)
        case .cmdZoom(let p):               revealPane(p); toggleZoom()
        case .cmdRenamePane(let p, let title):
            guard let (w, t) = locatePane(p, in: workspaces) else { return }
            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
            _ = workspaces[w].tabs[t].root.updatePane(p) { $0.userTitle = trimmed.isEmpty ? nil : trimmed }
            save()
        case .cmdReorderTab(let ws, let from, let to):
            selectWorkspace(ws)
            guard tabs.indices.contains(from) else { return }
            reorder(tabID: tabs[from].tabID, toIndex: to); commitOrder()
        case .cmdSwitchTab(let ws, let tab): selectWorkspace(ws); select(tabID: tab)
        default: return
        }
        broadcastCurrentWorkspaceTree()
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
            // workspaceTrees reads @Published workspaces, so it must run on main. This is
            // called from RemoteServer's connQueue (admit), never under any RemoteServer
            // lock; main never blocks on connQueue/writeQueue (broadcast is async), so the
            // main.sync can't deadlock. The [weak self] nil-guard returns [] if torn down.
            workspaceTrees: { [weak self] in
                guard let self else { return [] }
                // admit() runs on connQueue for a known device but on the MAIN thread for a
                // new-device approval (respondToApproval → decider → admit). main.sync from
                // main is a libdispatch reentrancy trap, so call directly when already on main.
                if Thread.isMainThread { return self.workspaceTrees() }
                return DispatchQueue.main.sync { self.workspaceTrees() }
            },
            updateFCMToken: { [weak self] id, token in self?.updateFCMToken(deviceID: id, token: token) },
            makeSecret: { UUID().uuidString }, makeNonce: { UUID().uuidString },
            // Capture the hub ONCE (just created above) rather than re-reading self.ptyHub
            // per call: that property is written on main but this closure runs on
            // RemoteServer's connQueue, so re-reading it would be an unsynchronized data race.
            lookupBroker: { [weak hub] in hub?.broker(for: $0) },
            // The desktop grid to snap a pane back to on detach — the broker's launch size.
            // Capture the hub (not self.ptyHub) to avoid the connQueue data race noted above.
            desktopSize: { [weak hub] paneID in hub?.broker(for: paneID).map { ($0.desktopCols, $0.desktopRows) } },
            // Tie-break: if the desktop is showing this pane right now (visible tab, lid open) when
            // the phone requests it, the desktop wins and the phone doesn't shrink it. selectedTab
            // reads @Published state → hop to main; direct if already there. Fails open to "not shown".
            desktopOwnsSize: { [weak self] paneID in
                guard let self else { return false }
                let read = {
                    if self.presence.isAway { return false }   // lid shut → desktop shows nothing
                    return self.tabs.first { $0.tabID == self.selectedTab }?.isShowing(paneID) ?? false
                }
                return Thread.isMainThread ? read() : DispatchQueue.main.sync(execute: read)
            },
            // A paired client's structural command arrives on RemoteServer's connQueue; apply
            // it on main since it mutates @Published state + drives libghostty focus.
            onCommand: { [weak self] msg in
                DispatchQueue.main.async { self?.applyRemoteCommand(msg) }
            })
        if s.start() {
            remoteServer = s
            shepherdLog("REMOTE serving on \(ip):\(remotePort) — pairing code \(pairingCode)")
        }
    }

    // MARK: Remote CLIENT role (M2) — attach to a host, mirror + drive its workspaces

    /// Stable id for THIS Mac acting as a client (persisted so a host remembers us on reconnect).
    private var clientDeviceID: String {
        let k = "shepherd.client.deviceID"
        if let v = UserDefaults.standard.string(forKey: k) { return v }
        let v = UUID().uuidString; UserDefaults.standard.set(v, forKey: k); return v
    }
    private var clientDeviceName: String { Host.current().localizedName ?? "Mac" }

    /// Attach to a host over Tailscale (or loopback): dial, pair with `code`, and mirror its
    /// workspaces. Idempotent per host. M2 mints an in-memory secret sent with the code (the host
    /// persists it); M3 persists it per host so reconnect skips re-pairing.
    func addRemoteHost(host: String, port: UInt16, code: String) {
        let hostID = "\(host):\(port)"
        guard remoteClients[hostID] == nil else { return }
        let secret = UUID().uuidString
        let client = RemoteClient(
            host: host, port: port, deviceID: clientDeviceID, deviceName: clientDeviceName,
            code: code, secret: secret,
            onAccepted: { _ in },
            onWorkspaceTree: { [weak self] tree in DispatchQueue.main.async { self?.upsertMirrorWorkspace(tree, hostID: hostID) } },
            onWorkspaceList: { [weak self] ids in DispatchQueue.main.async { self?.pruneMirrorWorkspaces(hostID: hostID, keep: ids) } },
            onWorkspaceRemoved: { [weak self] id in DispatchQueue.main.async { self?.removeMirrorWorkspace(hostID: hostID, remoteWorkspaceID: id) } },
            onState: { [weak self] p, s, r in DispatchQueue.main.async { self?.applyRemoteState(paneID: p, state: s, reason: r) } },
            onStatus: { [weak self] conn in DispatchQueue.main.async { self?.applyRemoteStatus(hostID: hostID, conn: conn) } })
        remoteClients[hostID] = client
        client.start()
    }

    /// Detach from a host: stop its client and drop its mirror workspaces (never destroys the host's).
    func removeRemoteHost(_ hostID: String) {
        remoteClients[hostID]?.stop(); remoteClients[hostID] = nil
        workspaces.removeAll { $0.remoteHostID == hostID }
        if currentWorkspaceIndex == nil { selectedWorkspaceID = workspaces.first?.id }
    }

    private func teardownRemoteClients() { for c in remoteClients.values { c.stop() }; remoteClients.removeAll() }

    /// Attach params for a mirror pane's `shepherdd attach` surface, or nil if it isn't a live
    /// mirror (no client / not yet accepted). Consumed by GhosttyTerminal.makeSurface (M2.5).
    func remoteAttachInfo(forPane paneID: String) -> (host: String, port: UInt16, nonce: String, remotePaneID: String)? {
        guard let (w, t) = locatePane(paneID, in: workspaces),
              let ref = workspaces[w].tabs[t].root.pane(paneID)?.remote,
              let client = remoteClients[ref.hostID], let nonce = client.sessionNonce else { return nil }
        return (client.host, client.port, nonce, ref.remotePaneID)
    }

    /// Build or replace this host workspace's mirror in place (deterministic id → upsert). Panes
    /// reuse the host's ids, so unchanged surfaces persist across a re-broadcast.
    private func upsertMirrorWorkspace(_ tree: WorkspaceTree, hostID: String) {
        let mirror = buildMirrorWorkspace(tree, hostID: hostID)
        if let i = workspaces.firstIndex(where: { $0.id == mirror.id }) {
            workspaces[i] = mirror
        } else {
            workspaces.append(mirror)
            if selectedWorkspaceID == nil { selectedWorkspaceID = mirror.id }
        }
        updateDockBadge()
    }

    /// Drop mirror workspaces for `hostID` no longer in the host's list (closed on the host).
    private func pruneMirrorWorkspaces(hostID: String, keep ids: [String]) {
        let keepSet = Set(ids.map { mirrorWorkspaceID(hostID: hostID, remoteWorkspaceID: $0) })
        workspaces.removeAll { $0.remoteHostID == hostID && !keepSet.contains($0.id) }
    }

    private func removeMirrorWorkspace(hostID: String, remoteWorkspaceID: String) {
        let id = mirrorWorkspaceID(hostID: hostID, remoteWorkspaceID: remoteWorkspaceID)
        workspaces.removeAll { $0.id == id }
    }

    /// A forwarded host state transition for a mirror pane: set the state the host computed (no
    /// local StopPolicy — the host already ran it) and refresh the attention rollup.
    private func applyRemoteState(paneID: String, state: String, reason: String?) {
        guard let (w, t) = locatePane(paneID, in: workspaces), workspaces[w].isRemote else { return }
        let st = AgentState(rawValue: state) ?? .shell
        _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.state = st; $0.reason = reason }
        updateDockBadge()
    }

    /// Reflect a host connection's link health on all its mirror panes (drives M3's overlays).
    private func applyRemoteStatus(hostID: String, conn: RemoteConnState) {
        for w in workspaces.indices where workspaces[w].remoteHostID == hostID {
            for t in workspaces[w].tabs.indices {
                for pid in workspaces[w].tabs[t].paneIDs {
                    _ = workspaces[w].tabs[t].root.updatePane(pid) { $0.remote?.conn = conn }
                }
            }
        }
    }

    /// The current workspace as a live remote target (client + host workspace id), or nil if local.
    private var currentRemote: (client: RemoteClient, wsID: String)? {
        guard let ws = currentWorkspace, let h = ws.remoteHostID,
              let wid = ws.remoteWorkspaceID, let c = remoteClients[h] else { return nil }
        return (c, wid)
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
