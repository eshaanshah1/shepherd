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

    /// Archived git worktrees (dir reclaimed, work preserved under a git ref).
    /// Restorable until they expire; persisted under `archiveKey`.
    @Published private(set) var archivedWorktrees: [ArchivedWorktree] = []

    /// Set by the `+` button / ⌘⇧N to ask the UI for a name before creating a
    /// workspace; ContentView presents the naming modal off this.
    @Published var promptingNewWorkspace = false

    /// Bumped to force the selected terminal to reclaim first responder.
    @Published var focusTick = 0
    func refocusActiveTerminal() { focusTick += 1 }

    /// Open terminal searches, keyed by paneID (transient — like zoom, never persisted).
    /// libghostty does the matching + grid highlighting; this holds the query and the
    /// match counts it reports back.
    @Published var searches: [String: SearchState] = [:]
    /// Bumped when ⌘F should (re)focus the open search field, e.g. reopening while active.
    @Published var searchFocusTick = 0

    /// Diff-review panel: whether it's open, and which pane it reviews (⌘G).
    @Published var diffPanelOpen = false
    @Published var diffPanelPaneID: String? = nil
    /// Code surface overlay (⌘O edit mode; diff mode is Phase 2).
    @Published var codeSurface: CodeSurfaceState? = nil
    /// Bumped when the reviewed pane finishes a turn, so an open panel can offer a refresh.
    @Published private(set) var diffTurnTick = 0
    private(set) var diffTurnPane: String? = nil

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
    private let archiveKey = "shepherd.archived-worktrees.v1"

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
    /// The control-channel port hosts bind and clients dial by default.
    static let defaultRemotePort: UInt16 = 8722
    private let remotePort: UInt16 = AgentStore.defaultRemotePort
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
        loadArchives()
        expireOldArchives()                // drop archives past the retention window
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

    /// One tab to mount, with its owning workspace and whether it's the visible one.
    struct MountedTab { let tab: Tab; let workspaceID: String; let visible: Bool }

    /// Every tab across every workspace, flattened. ContentView mounts these in a
    /// single `tabID`-keyed ForEach so a tab keeps its surface (and live PTY) when it
    /// moves between workspaces — grouping by workspace would re-parent and re-create it.
    var allMountedTabs: [MountedTab] {
        workspaces.flatMap { ws in
            ws.tabs.map { tab in
                MountedTab(tab: tab, workspaceID: ws.id,
                           visible: ws.id == selectedWorkspaceID && tab.tabID == ws.selectedTabID)
            }
        }
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

    /// Accordion folder expand/collapse — persisted per workspace.
    func toggleWorkspaceCollapsed(_ id: String) {
        guard let i = workspaces.firstIndex(where: { $0.id == id }) else { return }
        workspaces[i].collapsed.toggle()
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

    private func cycleWorkspace(_ delta: Int, wrap: Bool) {
        guard !workspaces.isEmpty, let i = currentWorkspaceIndex else { return }
        let n = workspaces.count
        let j = wrap ? ((i + delta) % n + n) % n : max(0, min(n - 1, i + delta))
        guard j != i else { return }
        selectWorkspace(workspaces[j].id)
    }

    // MARK: Workspace default directory + git worktrees

    /// The workspace's default dir, tilde-expanded, or nil when unset/empty.
    private func expandedDefaultPath(_ ws: Workspace) -> String? {
        guard let p = ws.defaultPath, !p.isEmpty else { return nil }
        return (p as NSString).expandingTildeInPath
    }

    /// Set (or clear, when nil/empty) the directory new tabs in this workspace open in.
    /// On a mirror workspace the repo lives on the host, so forward to it (host-authoritative);
    /// the change comes back on the next `workspaceTree` broadcast.
    func setWorkspaceDirectory(_ id: String, to path: String?) {
        if let t = remoteTarget(forWorkspace: id) {
            t.client.send(.cmdSetWorkspaceDirectory(workspaceID: t.wsID, path: path)); return
        }
        guard let i = workspaces.firstIndex(where: { $0.id == id }) else { return }
        let trimmed = path?.trimmingCharacters(in: .whitespacesAndNewlines)
        workspaces[i].defaultPath = (trimmed?.isEmpty ?? true) ? nil : trimmed
        save()
        broadcastWorkspaceTree(workspaceID: id)   // propagate defaultPath to any attached client
    }

    /// The base dir worktrees are created under: `# shepherd: worktree-base` from the config,
    /// else `~/.shepherd/worktrees`.
    private func worktreeBaseDir() -> String {
        let cfgPath = (NSHomeDirectory() as NSString).appendingPathComponent(".config/shepherd/config")
        if let contents = try? String(contentsOfFile: cfgPath, encoding: .utf8),
           let base = parseShepherdConfig(contents).worktreeBase, !base.isEmpty {
            return (base as NSString).expandingTildeInPath
        }
        return (NSHomeDirectory() as NSString).appendingPathComponent(".shepherd/worktrees")
    }

    /// Create a git worktree under the workspace's default repo and open a tab in it.
    /// git runs off-main; on success the tab opens in the worktree, on failure git's
    /// stderr is surfaced. Reuses an existing branch named `name`, else creates it off origin's
    /// freshly-fetched default branch.
    func newWorktreeTab(inWorkspace wsID: String, name: String) {
        if let t = remoteTarget(forWorkspace: wsID) {   // repo is on the host — it runs git
            let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !n.isEmpty else { return }
            t.client.send(.cmdNewWorktreeTab(workspaceID: t.wsID, name: n)); return
        }
        guard let ws = workspaces.first(where: { $0.id == wsID }),
              let repoDir = expandedDefaultPath(ws) else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let dest = worktreePath(base: worktreeBaseDir(), repoDir: repoDir, name: trimmed)
        // Show the tab immediately in a loading state, then run git off-main — the
        // terminal mounts once the directory exists (or the tab is removed on failure).
        guard let provisional = addProvisioningTab(inWorkspace: wsID, name: trimmed, dest: dest) else { return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Git.addWorktree(dest: dest, name: trimmed, in: repoDir)
            DispatchQueue.main.async {
                guard let self else { return }
                if result.ok {
                    self.finishProvisioning(paneID: provisional.paneID)
                } else {
                    self.closeTab(provisional.tabID, inWorkspace: wsID)
                    self.showWorktreeError("Couldn't create worktree",
                                           detail: result.err.isEmpty ? "git worktree add failed." : result.err)
                }
            }
        }
    }

    /// Append a loading placeholder tab (a single provisioning pane) and select it.
    private func addProvisioningTab(inWorkspace wsID: String, name: String, dest: String) -> (tabID: String, paneID: String)? {
        guard let w = workspaces.firstIndex(where: { $0.id == wsID }) else { return nil }
        selectedWorkspaceID = wsID
        var pane = Pane()
        pane.provisioning = true
        pane.userTitle = name
        pane.cwd = dest
        let tab = Tab(pane: pane)
        workspaces[w].tabs.append(tab)
        workspaces[w].selectedTabID = tab.tabID
        save()
        return (tab.tabID, pane.paneID)
    }

    /// Clear a pane's provisioning flag so its `GhosttyTerminal` mounts in the now-real cwd.
    private func finishProvisioning(paneID: String) {
        guard let (w, t) = locatePane(paneID, in: workspaces) else { return }
        _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.provisioning = false }
        save()
        broadcastWorkspaceTree(workspaceID: workspaces[w].id)
        refocusActiveTerminal()
    }

    private func showWorktreeError(_ title: String, detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    // MARK: Worktree archive / restore

    private func loadArchives() {
        guard let data = UserDefaults.standard.data(forKey: archiveKey),
              let arr = try? JSONDecoder().decode([ArchivedWorktree].self, from: data) else { return }
        archivedWorktrees = arr
    }

    private func saveArchives() {
        if let data = try? JSONEncoder().encode(archivedWorktrees) {
            UserDefaults.standard.set(data, forKey: archiveKey)
        }
    }

    /// Drop archives past the retention window and delete their git state off-main.
    private func expireOldArchives() {
        let (keep, expired) = WorktreeArchive.expireArchives(archivedWorktrees, now: Date())
        guard !expired.isEmpty else { return }
        archivedWorktrees = keep
        saveArchives()
        DispatchQueue.global(qos: .utility).async {
            for a in expired { Git.deleteArchive(a) }
        }
    }

    /// Archive the tab's worktree: snapshot its work, reclaim the directory, keep a
    /// restorable record. On success the tab is closed (its dir is gone).
    func archiveWorktreeTab(_ tabID: String, inWorkspace wsID: String) {
        guard let w = workspaces.firstIndex(where: { $0.id == wsID }), !workspaces[w].isRemote,
              let tab = workspaces[w].tabs.first(where: { $0.tabID == tabID }),
              let cwd = tab.focusedPane()?.cwd ?? tab.root.panes.first?.cwd else { return }
        let name = tab.displayTitle
        let wsName = workspaces[w].displayName(index: w)
        let sessionID = tab.root.panes.compactMap { $0.sessionID }.first
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let info = Git.worktreeInfo(cwd) else {
                DispatchQueue.main.async { self?.showWorktreeError("Can't archive", detail: "This tab isn't a git worktree.") }
                return
            }
            let id = UUID().uuidString
            let result = Git.archiveWorktree(info: info, id: id)
            DispatchQueue.main.async {
                guard let self else { return }
                guard result.ok else {
                    self.showWorktreeError("Couldn't archive worktree", detail: result.err)
                    return
                }
                self.archivedWorktrees.append(ArchivedWorktree(
                    id: id, workspaceID: wsID, workspaceName: wsName, repoDir: info.mainRepo, branch: info.branch,
                    name: name, dest: info.root, headCommit: info.head, archivedAt: Date(), sessionID: sessionID))
                self.saveArchives()
                self.closeTab(tabID, inWorkspace: wsID)
            }
        }
    }

    /// Recreate an archived worktree and open a tab in it (resuming its agent if any).
    func restoreWorktree(_ id: String) {
        guard let a = archivedWorktrees.first(where: { $0.id == id }) else { return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Git.restoreWorktree(a)
            DispatchQueue.main.async {
                guard let self else { return }
                guard result.ok else {
                    self.showWorktreeError("Couldn't restore worktree", detail: result.err)
                    return
                }
                self.archivedWorktrees.removeAll { $0.id == id }
                self.saveArchives()
                self.openRestoredWorktree(a)
            }
        }
    }

    /// Open a restored worktree in its original workspace, recreating that workspace
    /// (with its saved name) if it no longer exists.
    private func openRestoredWorktree(_ a: ArchivedWorktree) {
        if workspaces.contains(where: { $0.id == a.workspaceID }) {
            newTab(inWorkspace: a.workspaceID, cwd: a.dest, sessionID: a.sessionID)
            return
        }
        let wsID = newWorkspace()   // seeds one empty tab + selects it
        if let name = a.workspaceName, !name.isEmpty { renameWorkspace(wsID, to: name) }
        let seed = workspaces.first { $0.id == wsID }?.tabs.first?.tabID
        newTab(inWorkspace: wsID, cwd: a.dest, sessionID: a.sessionID)
        if let seed { closeTab(seed, inWorkspace: wsID) }   // drop the empty seed tab
    }

    /// Forget an archive entirely (protection ref + branch). Same semantics as expiry.
    func deleteArchive(_ id: String) {
        guard let a = archivedWorktrees.first(where: { $0.id == id }) else { return }
        archivedWorktrees.removeAll { $0.id == id }
        saveArchives()
        DispatchQueue.global(qos: .utility).async { Git.deleteArchive(a) }
    }

    /// Close a tab, but if it's a single-pane local git worktree, first offer to
    /// archive vs discard (removing the dir) vs cancel. Non-worktree tabs close now.
    func requestCloseTab(_ tabID: String, inWorkspace wsID: String) {
        guard let w = workspaces.firstIndex(where: { $0.id == wsID }),
              let tab = workspaces[w].tabs.first(where: { $0.tabID == tabID }) else { return }
        guard !workspaces[w].isRemote, !tab.isSplit, let cwd = tab.focusedPane()?.cwd, !cwd.isEmpty else {
            closeTab(tabID, inWorkspace: wsID); return
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let isWt = Git.isLinkedWorktree(cwd)
            DispatchQueue.main.async {
                guard let self else { return }
                guard isWt else { self.closeTab(tabID, inWorkspace: wsID); return }
                self.presentCloseWorktreePrompt(tabID: tabID, inWorkspace: wsID, cwd: cwd)
            }
        }
    }

    private func presentCloseWorktreePrompt(tabID: String, inWorkspace wsID: String, cwd: String) {
        let alert = NSAlert()
        alert.messageText = "Close this worktree tab?"
        alert.informativeText = "Archive keeps your work (resumable for \(WorktreeArchive.retentionDays) days) and frees the directory. Discard removes the worktree directory."
        alert.addButton(withTitle: "Archive")
        alert.addButton(withTitle: "Discard")
        alert.addButton(withTitle: "Cancel")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            archiveWorktreeTab(tabID, inWorkspace: wsID)
        case .alertSecondButtonReturn:
            closeTab(tabID, inWorkspace: wsID)
            DispatchQueue.global(qos: .utility).async {
                if let info = Git.worktreeInfo(cwd) { Git.removeWorktree(root: info.root, mainRepo: info.mainRepo) }
            }
        default:
            break
        }
    }

    // MARK: Tabs (current workspace)

    @discardableResult
    func newTab() -> String {
        guard let w = currentWorkspaceIndex else { return newWorkspace() }
        if let (c, wid) = currentRemote { c.send(.cmdNewTab(workspaceID: wid)); return "" }  // host creates it → re-broadcasts
        var pane = Pane()
        pane.cwd = expandedDefaultPath(workspaces[w])
        let tab = Tab(pane: pane)
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

    func closeSelected() {
        guard let sel = selectedTab, let wsID = selectedWorkspaceID else { return }
        requestCloseTab(sel, inWorkspace: wsID)
    }

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

    // MARK: Workspace-scoped tab ops (accordion — a tab may live in a non-active folder)

    /// A remote target for a specific workspace (mirror ⇒ its host), independent of selection.
    private func remoteTarget(forWorkspace wsID: String) -> (client: RemoteClient, wsID: String)? {
        guard let ws = workspaces.first(where: { $0.id == wsID }), let h = ws.remoteHostID,
              let wid = ws.remoteWorkspaceID, let c = remoteClients[h] else { return nil }
        return (c, wid)
    }

    /// Select a tab in any workspace — makes its folder the active workspace too.
    func select(tabID: String, inWorkspace wsID: String) {
        guard let w = workspaces.firstIndex(where: { $0.id == wsID }),
              let tab = workspaces[w].tabs.first(where: { $0.tabID == tabID }) else { return }
        selectedWorkspaceID = wsID
        workspaces[w].selectedTabID = tabID
        didFocus(paneID: tab.focusedPaneID)   // viewing a finished tab clears its need-to-check
        refocusActiveTerminal()
    }

    /// New tab into a specific folder, selecting it (the folder-header hover `+`).
    /// An explicit `cwd` (worktree flow) overrides the workspace's default directory.
    @discardableResult
    func newTab(inWorkspace wsID: String, cwd: String? = nil, sessionID: String? = nil) -> String {
        guard let w = workspaces.firstIndex(where: { $0.id == wsID }) else { return "" }
        selectedWorkspaceID = wsID
        if let (c, wid) = remoteTarget(forWorkspace: wsID) { c.send(.cmdNewTab(workspaceID: wid)); return "" }
        var pane = Pane()
        pane.cwd = cwd ?? expandedDefaultPath(workspaces[w])
        pane.sessionID = sessionID   // set ⇒ GhosttyTerminal seeds `claude --resume` on mount
        let tab = Tab(pane: pane)
        workspaces[w].tabs.append(tab)
        workspaces[w].selectedTabID = tab.tabID
        save()
        refocusActiveTerminal()
        broadcastWorkspaceTree(workspaceID: wsID)
        return tab.tabID
    }

    func rename(tabID: String, to title: String, inWorkspace wsID: String) {
        guard let w = workspaces.firstIndex(where: { $0.id == wsID }),
              let i = workspaces[w].tabs.firstIndex(where: { $0.tabID == tabID }) else { return }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        workspaces[w].tabs[i].userTitle = trimmed.isEmpty ? nil : trimmed
        save()
        broadcastWorkspaceTree(workspaceID: wsID)
    }

    func closeTab(_ tabID: String, inWorkspace wsID: String) {
        guard let w = workspaces.firstIndex(where: { $0.id == wsID }) else { return }
        closeTabInWorkspace(w, tabID: tabID)
    }

    func reorder(tabID: String, toIndex: Int, inWorkspace wsID: String) {
        guard let w = workspaces.firstIndex(where: { $0.id == wsID }),
              let from = workspaces[w].tabs.firstIndex(where: { $0.tabID == tabID }),
              from != toIndex, workspaces[w].tabs.indices.contains(toIndex) else { return }
        let item = workspaces[w].tabs.remove(at: from)
        workspaces[w].tabs.insert(item, at: toIndex)
    }

    func commitOrder(inWorkspace wsID: String) { save(); broadcastWorkspaceTree(workspaceID: wsID) }

    /// Move a tab (with its whole pane tree + live agents) into another folder,
    /// appended, selected, and made active. No-op across remote/mirror workspaces
    /// (host-authoritative) or into its own folder. The source reseeds if emptied.
    func moveTab(_ tabID: String, toWorkspace destID: String) {
        guard let srcW = workspaces.firstIndex(where: { ws in ws.tabs.contains { $0.tabID == tabID } }),
              let destW = workspaces.firstIndex(where: { $0.id == destID }),
              srcW != destW,
              !workspaces[srcW].isRemote, !workspaces[destW].isRemote,
              let ti = workspaces[srcW].tabs.firstIndex(where: { $0.tabID == tabID }) else { return }

        let srcID = workspaces[srcW].id
        let wasSelected = workspaces[srcW].selectedTabID == tabID
        let tab = workspaces[srcW].tabs.remove(at: ti)
        if workspaces[srcW].tabs.isEmpty {
            workspaces[srcW].reseedIfEmpty()
        } else if wasSelected {
            workspaces[srcW].selectedTabID = workspaces[srcW].tabs.last?.tabID
        }

        workspaces[destW].tabs.append(tab)
        workspaces[destW].selectedTabID = tab.tabID
        selectedWorkspaceID = destID
        didFocus(paneID: tab.focusedPaneID)
        save()
        refocusActiveTerminal()
        broadcastWorkspaceTree(workspaceID: srcID)
        broadcastWorkspaceTree(workspaceID: destID)
        updateDockBadge()
    }

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

    func pane(_ paneID: String) -> Pane? {
        guard let (w, t) = locatePane(paneID, in: workspaces) else { return nil }
        return workspaces[w].tabs[t].root.pane(paneID)
    }

    /// A pane running a live Claude session (so the comment→prompt composer applies).
    func hasLiveAgent(paneID: String) -> Bool {
        (pane(paneID)?.sessionID?.isEmpty == false)
    }

    /// ⌘G — toggle the diff panel for the selected tab's focused pane.
    func toggleDiffPanel() {
        if diffPanelOpen { diffPanelOpen = false; return }
        guard let tab = tabs.first(where: { $0.tabID == selectedTab }) else { return }
        codeSurface = nil          // one code surface at a time: diff replaces edit
        diffPanelPaneID = tab.focusedPaneID
        diffPanelOpen = true
    }

    /// ⌘O — toggle the code surface (edit mode); mirrors ⌘G for the diff.
    func openEditor() {
        if codeSurface != nil { codeSurface = nil; return }
        diffPanelOpen = false      // one code surface at a time: edit replaces diff
        let tab = tabs.first(where: { $0.tabID == selectedTab })
        codeSurface = .editing(root: focusedPaneCwd ?? NSHomeDirectory(), pane: tab?.focusedPaneID)
    }

    /// Open a specific file as a tab (from the file tree, or a diff's "edit" pencil).
    func openFile(_ path: String) {
        diffPanelOpen = false
        if codeSurface == nil {
            let tab = tabs.first(where: { $0.tabID == selectedTab })
            codeSurface = .editing(root: focusedPaneCwd ?? (path as NSString).deletingLastPathComponent,
                                   pane: tab?.focusedPaneID)
        }
        codeSurface?.open(path)
    }

    func closeFile(_ path: String) { codeSurface?.close(path) }
    func selectFile(_ path: String) { codeSurface?.open(path) }
    func closeCodeSurface() { codeSurface = nil }
    func markCodeSurfaceDirty(_ path: String) { codeSurface?.markDirty(path) }

    func saveActiveFile(_ text: String) {
        guard let path = codeSurface?.activeFile else { return }
        try? text.write(toFile: path, atomically: true, encoding: .utf8)
        codeSurface?.clearDirty(path)
    }

    /// cwd of the selected tab's focused pane — the file tree's root.
    var focusedPaneCwd: String? {
        guard let tab = tabs.first(where: { $0.tabID == selectedTab }) else { return nil }
        return tab.root.pane(tab.focusedPaneID)?.cwd
    }

    /// Inject text into a live pane's PTY (diff-review "send to agent").
    func injectText(_ text: String, intoPane paneID: String) {
        GhosttySurfaceView.perform(paneID: paneID, injectText: text)
    }

    /// Compose review comments into one prompt and inject it into the pane's agent.
    /// `shepherd.diff.autoReviewSubmit` (default true) appends a newline to send it;
    /// false stages the text for the user to press Enter.
    func submitReview(_ comments: [ReviewComment], toPane paneID: String) {
        guard !comments.isEmpty else { return }
        let auto = (UserDefaults.standard.object(forKey: "shepherd.diff.autoReviewSubmit") as? Bool) ?? true
        let prompt = ReviewPrompt.compose(comments) + (auto ? "\n" : "")
        injectText(prompt, intoPane: paneID)
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
        if res.state == .needsCheck {
            diffTurnPane = paneID
            diffTurnTick += 1   // an open diff panel watches this to offer a refresh
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
        // Navigating to a pane (tab click, ⌘⇧A, a notification) surfaces the
        // terminal — a full-takeover overlay would otherwise stay stale on top.
        if diffPanelOpen || codeSurface != nil { diffPanelOpen = false; codeSurface = nil }
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
        searches.removeValue(forKey: paneID)   // drop any open search for this pane
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

    // MARK: Terminal search (⌘F; libghostty does the matching + highlight)

    /// The focused pane of the selected tab, across the current workspace.
    var focusedPaneID: String? {
        guard let t = selectedTab else { return nil }
        return anyTab(t)?.focusedPaneID
    }

    /// ⌘F: open (or refocus) search on the focused pane.
    func openSearch() {
        guard let pid = focusedPaneID else { return }
        if searches[pid] == nil { searches[pid] = SearchState() }
        GhosttySurfaceView.perform(paneID: pid, binding: "start_search")
        searchFocusTick += 1
    }

    func closeSearch(paneID: String) {
        guard searches.removeValue(forKey: paneID) != nil else { return }
        GhosttySurfaceView.perform(paneID: paneID, binding: "end_search")
        refocusActiveTerminal()
    }

    /// Live needle update. An empty needle cancels the search in the core.
    func setSearchQuery(_ q: String, paneID: String) {
        guard searches[paneID] != nil else { return }
        searches[paneID]?.query = q
        if q.isEmpty { searches[paneID]?.total = 0; searches[paneID]?.selected = 0 }
        GhosttySurfaceView.perform(paneID: paneID, binding: "search:\(q)")
    }

    func navigateSearch(_ dir: SearchDirection, paneID: String) {
        guard searches[paneID] != nil else { return }
        GhosttySurfaceView.perform(paneID: paneID, binding: "navigate_search:\(dir.rawValue)")
    }

    /// ⌘G / ⌘⇧G from the menu: step the focused pane's active search, if any.
    func navigateFocusedSearch(_ dir: SearchDirection) {
        guard let pid = focusedPaneID else { return }
        navigateSearch(dir, paneID: pid)
    }

    // Core → app (from handleAction).
    func setSearchTotal(_ n: Int, paneID: String) { searches[paneID]?.total = max(0, n) }
    func setSearchSelected(_ n: Int, paneID: String) { searches[paneID]?.selected = max(0, n) }
    func endSearchFromCore(paneID: String) {
        if searches.removeValue(forKey: paneID) != nil { refocusActiveTerminal() }
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
                          tabs: ws.tabs.map(remoteTab), selectedTabID: ws.selectedTabID,
                          defaultPath: ws.defaultPath)
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
                                 tabs: ws.tabs.map(remoteTab), selectedTabID: ws.selectedTabID,
                                 defaultPath: ws.defaultPath)
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
        case .cmdSetWorkspaceDirectory(let ws, let path): setWorkspaceDirectory(ws, to: path)
        case .cmdNewWorktreeTab(let ws, let name):        newWorktreeTab(inWorkspace: ws, name: name)
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
