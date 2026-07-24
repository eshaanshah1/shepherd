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

    /// Scratch panes owned by no workspace (spec: ephemeral panes). At most one is
    /// un-collapsed (the overlay); the rest are bottom-right PiP thumbnails.
    @Published var ephemeralPanes: [EphemeralPane] = []
    /// Bumped when a summon is blocked at the cap — drives a brief PiP-row flash.
    @Published private(set) var ephemeralCapFlash: Int = 0

    /// The single open overlay's pane id (nil = all collapsed). Derived from
    /// `collapsed` so there's one source of truth.
    var expandedEphemeralID: String? { ephemeralPanes.first { !$0.collapsed }?.id }

    /// Archived git worktrees (dir reclaimed, work preserved under a git ref).
    /// Restorable until they expire; persisted under `archiveKey`.
    @Published private(set) var archivedWorktrees: [ArchivedWorktree] = []

    /// Archived worktrees whose git teardown is in flight — the footer row shows a
    /// dim, non-interactive "deleting" state until it clears. Transient.
    @Published private(set) var deletingArchiveIDs: Set<String> = []

    /// PR status per pane, shown in the sidebar when the pane is idle (transient —
    /// fetched via `gh`, refreshed while idle, never persisted).
    @Published private(set) var prStatuses: [String: PRStatus] = [:]
    private var prInFlight: Set<String> = []
    private var prTimer: Timer?

    /// PR review threads per pane (keyed by pane id), fetched alongside PR status.
    @Published private(set) var reviewThreads: [String: [GHReviewThread]] = [:]
    private var reviewThreadsInFlight: Set<String> = []

    /// Set by the `+` button / ⌘⇧N to ask the UI for a name before creating a
    /// workspace; ContentView presents the naming modal off this.
    @Published var promptingNewWorkspace = false

    /// Toggled by ⌘/ to show the keyboard-shortcut cheatsheet overlay (transient).
    @Published var showShortcuts = false

    /// Bumped to force the selected terminal to reclaim first responder.
    @Published var focusTick = 0
    func refocusActiveTerminal() { focusTick += 1 }

    /// Bumped on a live config reload so the chrome re-renders and re-reads the
    /// (now re-resolved) `Theme` tokens. Any @Published change re-renders the
    /// store's observers (sidebar, content) without remounting terminals.
    @Published private(set) var themeVersion = 0
    func bumpTheme() { themeVersion += 1 }

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

    /// Machine-level "serve panes through the helper" switch. Off by default; flip via
    /// the `⋯` sidebar menu ("Serve to remote devices", `setServing`) or, headless,
    /// `defaults write com.shepherd.Shepherd shepherd.remote.serving -bool YES`. Read at
    /// pane-creation time, so PTY streaming only affects panes opened after it changes.
    var isServing: Bool { UserDefaults.standard.bool(forKey: "shepherd.remote.serving") }

    /// The bundled `shepherdd` helper, beside the app executable in Contents/MacOS.
    let helperPath: String = Bundle.main.executableURL?
        .deletingLastPathComponent()
        .appendingPathComponent("shepherdd").path ?? "shepherdd"

    private var server: SocketServer?

    /// Always-on local control channel for the `shepherd` CLI. A stable, well-known
    /// path (single-window v1) so a shell outside a pane finds it without knowing the
    /// pid; also injected into each pane as $SHEPHERD_CTL_SOCK.
    let ctlSocketPath: String = AppMode.supportPath("control.sock")
    private var ctlServer: ControlServer?
    let controlHandles = HandleRegistry()

    private let persistKey = "shepherd.workspaces.v1"
    private let legacyKey  = "shepherd.tabs.v2"
    private let archiveKey = "shepherd.archived-worktrees.v1"

    // MARK: Remote control channel (Android "monitor" host side)

    /// Set when a not-yet-known device passes the pairing code and is awaiting the
    /// user's approval; ContentView presents the approval sheet off this.
    @Published var pendingApproval: (deviceID: String, name: String)?
    /// Drives the tailnet device-discovery sheet (⋯ menu → "Add remote device…").
    @Published var showingRemoteDevices = false
    /// Drives the phone-pairing QR sheet (⋯ menu → "Connect a phone…").
    @Published var showingPhonePairingQR = false
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

    /// Cached `tailscale status` for host-side pairing verification. Refreshed at most once
    /// per few seconds so a burst of hellos doesn't spawn a Process each. Serving-side only.
    private var tsStatusCache: (status: TSStatus, at: Date)?
    private let tsStatusLock = NSLock()
    private func tailnetStatus() -> TSStatus? {
        tsStatusLock.lock()
        if let c = tsStatusCache, Date().timeIntervalSince(c.at) < 5 { tsStatusLock.unlock(); return c.status }
        tsStatusLock.unlock()
        guard let s = TailscaleDiscovery.fetchStatus() else { return nil }
        tsStatusLock.lock(); tsStatusCache = (s, Date()); tsStatusLock.unlock()
        return s
    }

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
        server = SocketServer(path: socketPath) { [weak self] paneID, event, detail, sid, payload in
            self?.apply(event: event, detail: detail, paneID: paneID, sid: sid, payload: payload)
        }
        server?.start()
        try? FileManager.default.createDirectory(
            atPath: (ctlSocketPath as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true)
        ctlServer = ControlServer(path: ctlSocketPath) { [weak self] req in
            self?.controlRoute(req) ?? ["ok": false, "error": "store gone"]
        }
        ctlServer?.start()
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
        startPRRefreshTimer()              // keep idle agents' PR status live-ish
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

    /// Set (or clear) the bash the workspace runs after creating a worktree. Local-only
    /// (remote/mirror worktree hooks are deferred). Empty/whitespace clears it.
    func setWorktreeHook(_ id: String, to script: String?) {
        guard let i = workspaces.firstIndex(where: { $0.id == id }) else { return }
        let trimmed = script?.trimmingCharacters(in: .whitespacesAndNewlines)
        workspaces[i].worktreeHook = (trimmed?.isEmpty ?? true) ? nil : script
        save()
    }

    /// The base dir worktrees are created under: `# shepherd: worktree-base` from the config,
    /// else `~/.shepherd/worktrees`.
    private func worktreeBaseDir() -> String {
        let cfgPath = (NSHomeDirectory() as NSString).appendingPathComponent(".config/shepherd/config")
        if let contents = try? String(contentsOfFile: cfgPath, encoding: .utf8),
           let base = parseShepherdConfig(contents).worktreeBase, !base.isEmpty {
            return (base as NSString).expandingTildeInPath
        }
        return AppMode.supportPath("worktrees")
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
            var hookFailure: String? = nil
            if result.ok {
                let hook = ws.worktreeHook?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if !hook.isEmpty {
                    let env = WorktreeHookRunner.hookEnvironment(
                        worktreeDir: dest, src: repoDir, branch: trimmed, name: trimmed,
                        repoName: (repoDir as NSString).lastPathComponent)
                    let r = WorktreeHookRunner.run(script: hook, cwd: dest, env: env)
                    if r.exitCode != 0 { hookFailure = r.output }
                }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                if result.ok {
                    self.finishProvisioning(paneID: provisional.paneID)
                    if let out = hookFailure {
                        let tail = Self.tail(out, lines: 20)
                        self.showWorktreeError("Worktree hook reported an error",
                            detail: tail.isEmpty ? "The hook exited with a non-zero status." : tail)
                    }
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

    /// Last `n` non-empty-trimmed lines of hook output, for a compact error alert.
    private static func tail(_ s: String, lines n: Int) -> String {
        let all = s.split(separator: "\n", omittingEmptySubsequences: false)
        return all.suffix(n).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Mark a pane as being torn down (or clear it) so its row + content pane dim and
    /// lock while the git op runs.
    private func setStowing(_ paneID: String, _ kind: StowKind?) {
        guard let (w, t) = locatePane(paneID, in: workspaces) else { return }
        _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.stowing = kind }
        broadcastWorkspaceTree(workspaceID: workspaces[w].id)
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
        let stowPaneID = tab.focusedPaneID
        setStowing(stowPaneID, .archiving)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let info = Git.worktreeInfo(cwd) else {
                DispatchQueue.main.async {
                    self?.setStowing(stowPaneID, nil)
                    self?.showWorktreeError("Can't archive", detail: "This tab isn't a git worktree.")
                }
                return
            }
            let id = UUID().uuidString
            let result = Git.archiveWorktree(info: info, id: id)
            DispatchQueue.main.async {
                guard let self else { return }
                guard result.ok else {
                    self.setStowing(stowPaneID, nil)
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

    // MARK: PR status (idle agents)

    private func startPRRefreshTimer() {
        guard GH.isInstalled else { return }   // no gh ⇒ feature off, sidebar keeps the state dot
        prTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshAllIdlePRs() }
        }
    }

    /// Every pane currently idle → refresh its PR status.
    private func refreshAllIdlePRs() {
        for ws in workspaces where !ws.isRemote {
            for tab in ws.tabs {
                for pane in tab.root.panes where pane.state == .idle {
                    refreshPR(forPane: pane.paneID)
                }
            }
        }
    }

    /// Fetch (off-main) the PR for a pane's checked-out branch and cache it; clears
    /// the entry when there's no PR. No-op without a cwd or while already fetching.
    func refreshPR(forPane paneID: String) {
        guard GH.isInstalled, !prInFlight.contains(paneID),
              let cwd = cwd(forPane: paneID), !cwd.isEmpty else { return }
        prInFlight.insert(paneID)
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let status = GH.prStatus(inDir: cwd)
            DispatchQueue.main.async {
                guard let self else { return }
                self.prInFlight.remove(paneID)
                if let status {
                    self.prStatuses[paneID] = status
                    self.refreshReviewThreads(forPane: paneID)   // PR exists → pull its review threads
                } else {
                    self.prStatuses.removeValue(forKey: paneID)
                    self.reviewThreads.removeValue(forKey: paneID)
                }
            }
        }
    }

    /// Open a pane's PR in the browser (leading-icon click).
    func openPR(forPane paneID: String) {
        guard let url = prStatuses[paneID].flatMap({ URL(string: $0.url) }) else { return }
        NSWorkspace.shared.open(url)
    }

    /// Fetch (off-main) the review threads for a pane's PR and cache them; clears the
    /// entry when there's no PR. Reads owner/repo from the cached PRStatus url. No-op
    /// without `gh` / a PR / a cwd, or while already fetching.
    func refreshReviewThreads(forPane paneID: String) {
        guard GH.isInstalled, !reviewThreadsInFlight.contains(paneID),
              let status = prStatuses[paneID],
              let cwd = cwd(forPane: paneID), !cwd.isEmpty,
              let (owner, repo) = PRThreads.ownerRepo(fromURL: status.url) else { return }
        reviewThreadsInFlight.insert(paneID)
        let number = status.number
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let threads = GH.reviewThreads(owner: owner, repo: repo, number: number, inDir: cwd)
            DispatchQueue.main.async {
                guard let self else { return }
                self.reviewThreadsInFlight.remove(paneID)
                if let threads { self.reviewThreads[paneID] = threads }
                else { self.reviewThreads.removeValue(forKey: paneID) }
            }
        }
    }

    /// Post a reply into a thread, then refetch to reconcile. Off-main.
    func replyToThread(id: String, body: String, forPane paneID: String) {
        guard let cwd = cwd(forPane: paneID), !cwd.isEmpty else { return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            _ = GH.replyToThread(id: id, body: body, inDir: cwd)
            DispatchQueue.main.async { self?.refreshReviewThreads(forPane: paneID) }
        }
    }

    /// Resolve / unresolve a thread, then refetch to reconcile. Off-main.
    func setThreadResolved(id: String, _ resolved: Bool, forPane paneID: String) {
        guard let cwd = cwd(forPane: paneID), !cwd.isEmpty else { return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            _ = GH.setThreadResolved(id: id, resolved, inDir: cwd)
            DispatchQueue.main.async { self?.refreshReviewThreads(forPane: paneID) }
        }
    }

    /// Forget an archive entirely (protection ref + branch). Same semantics as expiry.
    func deleteArchive(_ id: String) {
        guard let a = archivedWorktrees.first(where: { $0.id == id }), !deletingArchiveIDs.contains(id) else { return }
        deletingArchiveIDs.insert(id)
        DispatchQueue.global(qos: .utility).async { [weak self] in
            Git.deleteArchive(a)
            DispatchQueue.main.async {
                guard let self else { return }
                self.archivedWorktrees.removeAll { $0.id == id }
                self.deletingArchiveIDs.remove(id)
                self.saveArchives()
            }
        }
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
            discardWorktreeTab(tabID, inWorkspace: wsID, cwd: cwd)
        default:
            break
        }
    }

    /// Remove the worktree directory and close the tab. The tab lingers in a locked
    /// "discarding" state until git finishes so the teardown is visible.
    private func discardWorktreeTab(_ tabID: String, inWorkspace wsID: String, cwd: String) {
        guard let w = workspaces.firstIndex(where: { $0.id == wsID }),
              let tab = workspaces[w].tabs.first(where: { $0.tabID == tabID }) else { return }
        let stowPaneID = tab.focusedPaneID
        setStowing(stowPaneID, .discarding)
        DispatchQueue.global(qos: .utility).async { [weak self] in
            if let info = Git.worktreeInfo(cwd) { Git.removeWorktree(root: info.root, mainRepo: info.mainRepo) }
            DispatchQueue.main.async { self?.closeTab(tabID, inWorkspace: wsID) }
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

    /// closeTab targeting a specific workspace. Closing the last tab leaves the
    /// workspace EMPTY (not deleted) — it persists and shows the empty state.
    private func closeTabInWorkspace(_ w: Int, tabID: String) {
        let wasSelected = workspaces[w].selectedTabID == tabID
        let closingPaneIDs = workspaces[w].tabs.first { $0.tabID == tabID }?.root.panes.map(\.paneID) ?? []
        workspaces[w].tabs.removeAll { $0.tabID == tabID }
        if workspaces[w].tabs.isEmpty {
            workspaces[w].selectedTabID = nil
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
        var flat: [(kind: String, ws: String?, pane: String)] = []
        for ws in workspaces { for tab in ws.tabs { for pid in tab.paneIDs { flat.append(("ws", ws.id, pid)) } } }
        for e in ephemeralPanes { flat.append(("ephemeral", nil, e.id)) }
        guard !flat.isEmpty else { return }
        let curPane = currentWorkspace.flatMap { ws in
            ws.tabs.first { $0.tabID == ws.selectedTabID }?.focusedPaneID
        }
        let start = flat.firstIndex { $0.kind == "ws" && $0.ws == selectedWorkspaceID && $0.pane == curPane } ?? -1
        for off in 1...flat.count {
            let e = flat[(start + off) % flat.count]
            let wants: Bool
            if e.kind == "ws" {
                wants = locatePane(e.pane, in: workspaces).map {
                    workspaces[$0.ws].tabs[$0.tab].root.pane(e.pane)?.state.wantsAttention == true
                } ?? false
            } else {
                wants = ephemeralPanes.first { $0.id == e.pane }?.pane.state.wantsAttention == true
            }
            guard wants else { continue }
            if e.kind == "ws" { revealPane(e.pane) } else { expandEphemeral(e.pane) }
            return
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
    /// (host-authoritative) or into its own folder. The source is left empty if drained.
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
            workspaces[srcW].selectedTabID = nil
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
        if let (w, t) = locatePane(paneID, in: workspaces) {
            return workspaces[w].tabs[t].root.pane(paneID)?.cwd
        }
        return ephemeralPanes.first { $0.id == paneID }?.pane.cwd
    }

    func pane(_ paneID: String) -> Pane? {
        if let (w, t) = locatePane(paneID, in: workspaces) {
            return workspaces[w].tabs[t].root.pane(paneID)
        }
        return ephemeralPanes.first { $0.id == paneID }?.pane
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
        let sid: String?
        if let (w, t) = locatePane(paneID, in: workspaces) {
            sid = workspaces[w].tabs[t].root.pane(paneID)?.sessionID
        } else {
            sid = ephemeralPanes.first { $0.id == paneID }?.pane.sessionID
        }
        guard let sid, !sid.isEmpty else { return nil }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let (w, t) = locatePane(paneID, in: self.workspaces) {
                _ = self.workspaces[w].tabs[t].root.updatePane(paneID) { $0.sessionID = nil }
            } else if let i = self.ephemeralPanes.firstIndex(where: { $0.id == paneID }) {
                self.ephemeralPanes[i].pane.sessionID = nil
            }
            self.save()
        }
        return claudeResumeInput(sessionID: sid)
    }

    // MARK: Feeds from libghostty (per-pane, ANY workspace via locatePane)

    /// Agent-state hook event: resolve the pane, fold the event through the pure
    /// `applyEvent` (lifecycle map + ordering guard + background-agent counter; see
    /// StopPolicy and ADR 0004), then surface the result (sidebar / badge / alert).
    func apply(event: String, detail: String, paneID: String, sid: String = "", payload: String? = nil) {
        if let (w, t) = locatePane(paneID, in: workspaces),
           let pane = workspaces[w].tabs[t].root.pane(paneID) {
            applyTransition(event: event, detail: detail, paneID: paneID, sid: sid, payload: payload,
                            current: pane, wsID: workspaces[w].id) { body in
                guard let (w, t) = locatePane(paneID, in: self.workspaces) else { return nil }
                _ = self.workspaces[w].tabs[t].root.updatePane(paneID, body)
                return self.workspaces[w].tabs[t].root.pane(paneID)
            }
        } else if let i = ephemeralPanes.firstIndex(where: { $0.id == paneID }) {
            applyTransition(event: event, detail: detail, paneID: paneID, sid: sid, payload: payload,
                            current: ephemeralPanes[i].pane, wsID: nil) { body in
                guard let i = self.ephemeralPanes.firstIndex(where: { $0.id == paneID }) else { return nil }
                body(&self.ephemeralPanes[i].pane)
                return self.ephemeralPanes[i].pane
            }
        } else {
            shepherdLog("event=\(event) tab=\(paneID.prefix(8)) -> NO SUCH TAB")
        }
    }

    /// The socket lifecycle tail, shared by the workspace and ephemeral feeds. `wsID`
    /// is nil for an ephemeral pane (no owning workspace ⇒ treated as "hidden" for
    /// notification routing, since it has no visible sidebar dot). `mutate` applies a
    /// change to the resolved pane and returns the updated pane.
    private func applyTransition(event: String, detail: String, paneID: String, sid: String,
                                 payload: String?, current: Pane, wsID: String?,
                                 mutate: ((inout Pane) -> Void) -> Pane?) {
        // A nested `claude` (e.g. `claude -p` run via Bash) reports on the parent pane's
        // id with its own session_id; drop it so it can't drive the parent's state.
        guard sessionEventAccepted(sid: sid, owner: current.sessionID) else {
            shepherdLog("event=\(event) tab=\(paneID.prefix(8)) (ignored: foreign session \(sid.prefix(8)))")
            return
        }
        let cur = current.state
        let res = applyEvent(event, detail: detail, current: cur, reason: current.reason)

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
        let updated = mutate {
            if res.clearTitle { $0.title = "" }
            $0.state = res.state
            $0.reason = res.reason
        }
        if res.state == .needsCheck {
            diffTurnPane = paneID
            diffTurnTick += 1   // an open diff panel watches this to offer a refresh
        }
        if res.state == .idle { refreshPR(forPane: paneID) }   // idle agent → surface its PR status
        // Track the live Claude session id so we can resume it on relaunch: SessionStart carries
        // the id (in detail), SessionEnd means the agent exited so there's nothing to resume.
        if event == "SessionStart", !detail.isEmpty {
            _ = mutate { $0.sessionID = detail }
            save()
        } else if event == "SessionEnd" {
            _ = mutate { $0.sessionID = nil }
            save()
        }
        if res.state != cur, res.state.wantsAttention, let updated {
            let routing = NotificationRoutingPolicy.decide(isAway: isAway())
            if routing.local {
                notifyAttention(updated, hidden: wsID == nil || wsID != selectedWorkspaceID)
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
        if wsID == nil { broadcastEphemeralTree() }   // ephemeral state changed → re-mirror
    }

    private func shepherdLog(_ msg: String) {
        let path = AppMode.isDev ? "/tmp/shepherd-dev-events.log" : "/tmp/shepherd-events.log"
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
        guard !title.isEmpty else { return }
        if let (w, t) = locatePane(paneID, in: workspaces) {
            _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.title = title }
        } else if let i = ephemeralPanes.firstIndex(where: { $0.id == paneID }) {
            ephemeralPanes[i].pane.title = title
            broadcastEphemeralTree()
        }
    }

    /// Working directory (PWD action) — tracked so we can restore it on relaunch.
    func setCwd(_ cwd: String, paneID: String) {
        guard !cwd.isEmpty else { return }
        if let (w, t) = locatePane(paneID, in: workspaces) {
            guard workspaces[w].tabs[t].root.pane(paneID)?.cwd != cwd else { return }
            _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.cwd = cwd }
            save()
        } else if let i = ephemeralPanes.firstIndex(where: { $0.id == paneID }) {
            guard ephemeralPanes[i].pane.cwd != cwd else { return }
            ephemeralPanes[i].pane.cwd = cwd
            save()
        }
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
        if let (w, t) = locatePane(paneID, in: workspaces) {
            guard workspaces[w].tabs[t].root.pane(paneID)?.state == .needsCheck else { return }
            _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.state = .idle }
        } else if let i = ephemeralPanes.firstIndex(where: { $0.id == paneID }) {
            guard ephemeralPanes[i].pane.state == .needsCheck else { return }
            ephemeralPanes[i].pane.state = .idle
            broadcastEphemeralTree()
        } else { return }
        updateDockBadge()
        refreshPR(forPane: paneID)   // finished turn just went idle → refresh its PR status
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

    // MARK: Ephemeral panes (workspace-less scratch panes)

    /// ⌘⌥N: open a fresh scratch shell in ~ as the overlay, collapsing any current
    /// overlay. Blocked (beep + flash) at the cap.
    func spawnEphemeral() {
        guard canSpawnEphemeral(count: ephemeralPanes.count) else {
            ephemeralCapFlash += 1
            NSSound.beep()
            return
        }
        var p = Pane()
        p.cwd = NSHomeDirectory()
        ephemeralPanes.append(EphemeralPane(pane: p, collapsed: false))
        ephemeralPanes = collapsingAllExcept(p.id, in: ephemeralPanes)   // single overlay
        save()
        broadcastEphemeralTree()
        // Claim keyboard focus once the surface is mounted in the window (next runloop).
        DispatchQueue.main.async { [weak self] in self?.refocusActiveTerminal() }
    }

    /// Click a PiP → make it the overlay (collapsing the previous one). Clears its
    /// need-to-check like any focus.
    func expandEphemeral(_ id: String) {
        guard ephemeralPanes.contains(where: { $0.id == id }) else { return }
        ephemeralPanes = collapsingAllExcept(id, in: ephemeralPanes)
        didFocus(paneID: id)
        broadcastEphemeralTree()
        DispatchQueue.main.async { [weak self] in self?.refocusActiveTerminal() }
    }

    /// Blur / minimize / Esc → tuck the overlay into PiP. Returns focus to the
    /// underlying terminal.
    func collapseEphemeral(_ id: String) {
        guard let i = ephemeralPanes.firstIndex(where: { $0.id == id }), !ephemeralPanes[i].collapsed else { return }
        ephemeralPanes[i].collapsed = true
        refocusActiveTerminal()
        broadcastEphemeralTree()
    }

    /// ⌘W (overlay up) / × button: destroy for good — free the surface (PTY dies).
    func closeEphemeral(_ id: String) {
        guard ephemeralPanes.contains(where: { $0.id == id }) else { return }
        let wasOverlay = expandedEphemeralID == id
        ephemeralPanes.removeAll { $0.id == id }
        postPaneClosed([id])              // GhosttyTerminal frees the surface
        if wasOverlay { refocusActiveTerminal() }
        save()
        updateDockBadge()
        broadcastEphemeralTree()
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
    /// Route a notification click to the right pane: an ephemeral pane expands its
    /// overlay; a workspace pane reveals its workspace/tab.
    func focusForNotification(paneID: String) {
        if ephemeralPanes.contains(where: { $0.id == paneID }) { expandEphemeral(paneID) }
        else { revealPane(paneID) }
    }

    func revealPane(_ paneID: String) {
        guard let (w, t) = locatePane(paneID, in: workspaces) else { return }
        selectedWorkspaceID = workspaces[w].id
        workspaces[w].tabs[t].focusedPaneID = paneID
        workspaces[w].selectedTabID = workspaces[w].tabs[t].tabID
        didFocus(paneID: paneID)
        refocusActiveTerminal()
    }

    var attentionCount: Int { totalAttentionCount(in: workspaces) + ephemeralAttentionCount(ephemeralPanes) }

    var hasBusyAgent: Bool { anyAgentBusy(in: workspaces) || anyEphemeralBusy(ephemeralPanes) }

    // MARK: Attention surfacing (dock badge + notifications + sound)

    private func updateDockBadge() {
        let n = attentionCount
        NSApp.dockTile.badgeLabel = n > 0 ? "\(n)" : nil
        SleepGuard.shared.update(hasBusyAgent: hasBusyAgent)
    }

    /// Fire a native notification when a pane needs you — while Shepherd is NOT
    /// frontmost OR the pane's workspace isn't the active one (a hidden-workspace
    /// agent has no visible sidebar dot to rely on).
    private func notifyAttention(_ pane: Pane, hidden: Bool) {
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
        let state = snapshotState(workspaces.filter { !$0.isRemote },
                                  selectedWorkspaceID: selectedWorkspaceID,
                                  ephemeral: ephemeralPanes)
        if let data = try? JSONEncoder().encode(state) {
            UserDefaults.standard.set(data, forKey: persistKey)
        }
    }

    private func restore() -> Bool {
        let defaults = UserDefaults.standard
        var state: PersistedState?
        if AppMode.isDev { state = devSeedState() }   // mirror the daily app's layout each launch (agents stripped)
        if state == nil {
            if let data = defaults.data(forKey: persistKey) {
                state = try? JSONDecoder().decode(PersistedState.self, from: data)
            } else if let legacy = defaults.data(forKey: legacyKey) {
                state = migrateLegacyTabs(legacy)   // one-time v2 → v1 wrap
            }
        }
        guard let state, !state.workspaces.isEmpty else { return false }
        workspaces = buildWorkspaces(from: state)
        guard !workspaces.isEmpty else { return false }
        ephemeralPanes = buildEphemerals(from: state.ephemeral)   // all collapsed (PiP)
        let i = workspaces.indices.contains(state.selectedWorkspaceIndex) ? state.selectedWorkspaceIndex : 0
        selectedWorkspaceID = workspaces[i].id
        save()   // re-persist in v1 form
        return true
    }

    /// (Dev builds only) The daily app's persisted layout, read cross-domain from its
    /// UserDefaults, with every pane's live Claude `sessionID` stripped so dev opens plain
    /// shells in the right cwds/splits — it mirrors your real setup without hijacking (or
    /// resuming) your live sessions. nil when the daily app has never persisted anything.
    private func devSeedState() -> PersistedState? {
        guard let daily = UserDefaults(suiteName: AppMode.dailyBundleID),
              let data = daily.data(forKey: persistKey),
              let decoded = try? JSONDecoder().decode(PersistedState.self, from: data)
        else { return nil }
        return decoded.strippingSessionIDs()
    }

    // MARK: Remote control channel

    /// Project every workspace to a client-facing `WorkspaceTree` (protocol v2): its tabs,
    /// each carrying its live `SplitNode` tree with per-pane title/state/cwd/reason. Sent on
    /// attach; a single workspace is re-sent by `broadcastWorkspaceTree` on structural change.
    func workspaceTrees() -> [WorkspaceTree] {
        var trees = workspaces.enumerated().map { (i, ws) in
            WorkspaceTree(workspaceID: ws.id, name: ws.displayName(index: i),
                          tabs: ws.tabs.map(remoteTab), selectedTabID: ws.selectedTabID,
                          defaultPath: ws.defaultPath)
        }
        if let e = ephemeralTree() { trees.append(e) }
        return trees
    }

    /// The synthetic "Temp Tabs" workspace projecting ephemeral panes as single-leaf
    /// tabs, so any client shows them as ordinary tabs. nil when there are none.
    private func ephemeralTree() -> WorkspaceTree? {
        guard !ephemeralPanes.isEmpty else { return nil }
        let tabs = ephemeralPanes.map { e in
            RemoteTab(tabID: e.pane.paneID,
                      root: .leaf(RemotePane(paneID: e.pane.paneID, title: e.pane.displayTitle,
                                             cwd: e.pane.cwd, state: e.pane.state.rawValue,
                                             reason: e.pane.reason)),
                      focusedPaneID: e.pane.paneID, zoomedPaneID: nil)
        }
        return WorkspaceTree(workspaceID: ephemeralWorkspaceID, name: "Temp Tabs",
                             tabs: tabs, selectedTabID: expandedEphemeralID ?? ephemeralPanes.first?.id,
                             defaultPath: nil)
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

    /// Re-broadcast the synthetic "Temp Tabs" tree to attached clients. When the last
    /// ephemeral pane closes, tell clients to drop the folder. No-op unless serving.
    func broadcastEphemeralTree() {
        guard isServing, let server = remoteServer else { return }
        if let tree = ephemeralTree() {
            server.broadcast(.workspaceTree(tree))
        } else {
            server.broadcast(.workspaceRemoved(workspaceID: ephemeralWorkspaceID))
        }
    }

    /// Apply a paired client's structural command to the real store (host-authoritative).
    /// Each maps to the SAME mutation the local keyboard path uses; pane-addressed commands
    /// go through `revealPane` first so they act on the right workspace/tab regardless of the
    /// desktop's current selection. A trailing tree re-broadcast guarantees the client sees
    /// the result even for the paths that don't broadcast themselves (focus/switch/rename).
    /// Runs on main (wired via the onCommand closure) — mutations touch @Published state.
    func applyRemoteCommand(_ msg: ControlMessage) {
        switch msg {
        case .cmdNewTab(let ws) where ws == ephemeralWorkspaceID:
            spawnEphemeral(); return
        case .cmdSwitchTab(let ws, let tab) where ws == ephemeralWorkspaceID:
            expandEphemeral(tab); return
        case .cmdClosePane(let p) where ephemeralPanes.contains(where: { $0.id == p }):
            closeEphemeral(p); return
        case .cmdFocusPane(let p) where ephemeralPanes.contains(where: { $0.id == p }):
            expandEphemeral(p); return
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

    /// UI toggle for `isServing` (the `⋯` menu item). Writes the flag, then starts or
    /// tears down the control channel live — no relaunch. `objectWillChange` fires so the
    /// menu checkmark + pairing-code row re-render off the new `isServing`. Panes already
    /// open keep their plain PTY (the helper is chosen at pane creation); control/mirroring
    /// takes effect immediately, PTY streaming only for panes opened after enabling.
    func setServing(_ on: Bool) {
        guard on != isServing else { return }
        objectWillChange.send()
        UserDefaults.standard.set(on, forKey: "shepherd.remote.serving")
        if on { startRemoteServingIfEnabled() } else { stopRemoteServing() }
    }

    /// Tear the control channel + pty hub down (serving-off counterpart to
    /// `startRemoteServingIfEnabled`). Idempotent; leaves paired-device records intact.
    func stopRemoteServing() {
        remoteServer?.stop(); remoteServer = nil
        ptyHub?.stop(); ptyHub = nil
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
            knownDevices: { [weak self] in
                guard let self else { return [] }
                self.pairedDevicesLock.lock(); defer { self.pairedDevicesLock.unlock() }
                return self.pairedDevices
            },
            persist: { [weak self] dev in self?.addPairedDevice(dev) },
            requestApproval: { [weak self] deviceID, name, decide in
                DispatchQueue.main.async {
                    self?.showingPhonePairingQR = false   // the phone connected; the QR is spent
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
            verifyPeer: { [weak self] ip in
                guard let s = self?.tailnetStatus() else { return nil }
                return TailscaleDiscovery.verifiedPeer(forIP: ip, in: s)
            },
            selfUserID: { [weak self] in self?.tailnetStatus()?.selfUserID },
            // Capture the hub ONCE (just created above) rather than re-reading self.ptyHub
            // per call: that property is written on main but this closure runs on
            // RemoteServer's connQueue, so re-reading it would be an unsynchronized data race.
            lookupBroker: { [weak hub] in hub?.broker(for: $0) },
            // A paired client's structural command arrives on RemoteServer's connQueue; apply
            // it on main since it mutates @Published state + drives libghostty focus.
            onCommand: { [weak self] msg in
                DispatchQueue.main.async { self?.applyRemoteCommand(msg) }
            })
        if s.start() {
            remoteServer = s
            shepherdLog("REMOTE serving on \(ip):\(remotePort)")
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

    /// Attach to a host over Tailscale (or loopback): dial, pair, and mirror its workspaces.
    /// Idempotent per host. No code — the host gates the first pairing by verifying our source
    /// IP against its tailnet peers (same user) + the approval popup; it persists the minted
    /// secret so reconnect skips re-pairing.
    func addRemoteHost(host: String, port: UInt16) {
        let hostID = "\(host):\(port)"
        guard remoteClients[hostID] == nil else { return }
        let secret = UUID().uuidString
        let client = RemoteClient(
            host: host, port: port, deviceID: clientDeviceID, deviceName: clientDeviceName,
            secret: secret,
            onAccepted: { _ in },
            onWorkspaceTree: { [weak self] tree in DispatchQueue.main.async { self?.upsertMirrorWorkspace(tree, hostID: hostID) } },
            onWorkspaceList: { [weak self] ids in DispatchQueue.main.async { self?.pruneMirrorWorkspaces(hostID: hostID, keep: ids) } },
            onWorkspaceRemoved: { [weak self] id in DispatchQueue.main.async { self?.removeMirrorWorkspace(hostID: hostID, remoteWorkspaceID: id) } },
            onState: { [weak self] p, s, r in DispatchQueue.main.async { self?.applyRemoteState(paneID: p, state: s, reason: r) } },
            onStatus: { [weak self] conn in DispatchQueue.main.async { self?.applyRemoteStatus(hostID: hostID, conn: conn) } })
        remoteClients[hostID] = client
        client.start()
    }

    /// The QR bootstrap payload for a phone to reach this host, or nil if Tailscale is down.
    func phonePairingPayload() -> String? {
        let status = tailnetStatus()
        let ip = status?.selfIPv4 ?? RemoteServer.currentTailscaleIPv4()
        let host = status?.selfDNSName
        guard host != nil || ip != nil else { return nil }
        let name = host?.split(separator: ".").first.map(String.init) ?? (Host.current().localizedName ?? "mac")
        return PairingPayload.encode(host: host, ip: ip, port: AgentStore.defaultRemotePort, name: name)
    }

    /// Human-readable host line under the QR (MagicDNS name : port), or nil.
    func phonePairingHostLabel() -> String? {
        guard let host = tailnetStatus()?.selfDNSName ?? RemoteServer.currentTailscaleIPv4() else { return nil }
        return "\(host):\(AgentStore.defaultRemotePort)"
    }

    /// Discover the user's own tailnet devices off-main, probe each online peer's control
    /// port, and deliver sorted rows on main. Empty if the tailscale binary is missing or
    /// no same-user peers exist (the sheet renders the appropriate empty state).
    func discoverDevices(_ completion: @escaping ([RemoteDeviceRow]) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            guard let status = TailscaleDiscovery.fetchStatus() else {
                DispatchQueue.main.async { completion([]) }; return
            }
            let port = AgentStore.defaultRemotePort
            let rows = TailscaleDiscovery.myPeers(status).map { peer -> RemoteDeviceRow in
                let open = peer.online && peer.ipv4.map { TailscaleDiscovery.probe(host: $0, port: port) } == true
                return TailscaleDiscovery.row(for: peer, portOpen: open)
            }
            DispatchQueue.main.async { completion(rows) }
        }
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
                    notifyAttention(pane, hidden: workspaces[w].id != selectedWorkspaceID)
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

    // MARK: - Control CLI

    func controlRoute(_ req: [String: Any]) -> [String: Any] {
        switch req["cmd"] as? String {
        case "ping": return ["ok": true, "data": "pong"]

        case "ls":
            return ["ok": true, "data": ["workspaces": controlSnapshot()]]

        case "whoami":
            guard let token = req["pane"] as? String, !token.isEmpty,
                  let uuid = resolvePane(token), let (w, t) = locatePane(uuid, in: workspaces)
            else { return ["ok": false, "error": "not inside a Shepherd pane"] }
            _ = controlSnapshot()   // ensure handles are minted
            return ["ok": true, "data": [
                "pane": controlHandles.handle(for: uuid, kind: .pane),
                "tab": controlHandles.handle(for: workspaces[w].tabs[t].tabID, kind: .tab),
                "workspace": controlHandles.handle(for: workspaces[w].id, kind: .workspace),
            ]]

        case "state":
            guard let token = req["pane"] as? String, let uuid = resolvePane(token),
                  let p = pane(uuid) else { return ["ok": false, "error": "no such pane"] }
            return ["ok": true, "data": ["state": p.state.rawValue, "reason": p.reason ?? ""]]

        case "workspace-new":
            let id = newWorkspace()
            return ["ok": true, "data": ["workspace": controlHandles.handle(for: id, kind: .workspace)]]
        case "workspace-rename":
            guard let ws = (req["workspace"] as? String).flatMap(resolveWorkspace),
                  let name = req["name"] as? String else { return ["ok": false, "error": "bad args"] }
            renameWorkspace(ws, to: name); return ["ok": true, "data": NSNull()]
        case "workspace-switch":
            guard let ws = (req["workspace"] as? String).flatMap(resolveWorkspace)
            else { return ["ok": false, "error": "no such workspace"] }
            selectWorkspace(ws); return ["ok": true, "data": NSNull()]

        case "tab-new":
            guard let ws = (req["workspace"] as? String).flatMap(resolveWorkspace) ?? selectedWorkspaceID
            else { return ["ok": false, "error": "no workspace"] }
            let tabID = newTab(inWorkspace: ws)
            _ = controlSnapshot()
            let paneID = workspaces.first { $0.id == ws }?.tabs.first { $0.tabID == tabID }?.root.firstLeafID
            return ["ok": true, "data": [
                "tab": controlHandles.handle(for: tabID, kind: .tab),
                "pane": paneID.map { controlHandles.handle(for: $0, kind: .pane) } ?? "",
            ]]
        case "tab-rename":
            guard let t = (req["tab"] as? String).flatMap(resolveTab), let name = req["name"] as? String,
                  let wsID = workspaces.first(where: { $0.tabs.contains { $0.tabID == t } })?.id
            else { return ["ok": false, "error": "bad args"] }
            rename(tabID: t, to: name, inWorkspace: wsID); return ["ok": true, "data": NSNull()]
        case "tab-switch":
            guard let t = (req["tab"] as? String).flatMap(resolveTab),
                  let wsID = workspaces.first(where: { $0.tabs.contains { $0.tabID == t } })?.id
            else { return ["ok": false, "error": "no such tab"] }
            applyRemoteCommand(.cmdSwitchTab(workspaceID: wsID, tabID: t)); return ["ok": true, "data": NSNull()]

        case "split":
            guard let p = (req["pane"] as? String).flatMap(resolvePane) else { return ["ok": false, "error": "no such pane"] }
            let axis = (req["axis"] as? String) == "column" ? "column" : "row"
            applyRemoteCommand(.cmdSplit(paneID: p, axis: axis))
            _ = controlSnapshot()
            return ["ok": true, "data": ["pane": focusedControlPaneHandle()]]
        case "pane-close":
            guard let p = (req["pane"] as? String).flatMap(resolvePane) else { return ["ok": false, "error": "no such pane"] }
            if paneHasLiveWork(p), req["force"] as? Bool != true {
                return ["ok": false, "error": "pane has a live agent; pass --force to close anyway"]
            }
            applyRemoteCommand(.cmdClosePane(paneID: p)); return ["ok": true, "data": NSNull()]

        case "workspace-rm":
            guard let ws = (req["workspace"] as? String).flatMap(resolveWorkspace)
            else { return ["ok": false, "error": "no such workspace"] }
            if workspaceHasLiveWork(ws), req["force"] as? Bool != true {
                return ["ok": false, "error": "workspace has live agents; pass --force to delete anyway"]
            }
            deleteWorkspace(ws); return ["ok": true, "data": NSNull()]

        case "tab-close":
            guard let t = (req["tab"] as? String).flatMap(resolveTab),
                  let wsID = workspaces.first(where: { $0.tabs.contains { $0.tabID == t } })?.id,
                  let tab = workspaces.first(where: { $0.id == wsID })?.tabs.first(where: { $0.tabID == t })
            else { return ["ok": false, "error": "no such tab"] }
            let live = tab.root.panes.contains { paneHasLiveWork($0.paneID) }
            if req["archive"] as? Bool == true { archiveWorktreeTab(t, inWorkspace: wsID); return ["ok": true, "data": NSNull()] }
            if live, req["force"] as? Bool != true {
                return ["ok": false, "error": "tab has live work; pass --force (close) or --archive"]
            }
            closeTab(t, inWorkspace: wsID); return ["ok": true, "data": NSNull()]
        case "focus":
            guard let p = (req["pane"] as? String).flatMap(resolvePane) else { return ["ok": false, "error": "no such pane"] }
            applyRemoteCommand(.cmdFocusPane(paneID: p)); return ["ok": true, "data": NSNull()]
        case "zoom":
            guard let p = (req["pane"] as? String).flatMap(resolvePane) else { return ["ok": false, "error": "no such pane"] }
            applyRemoteCommand(.cmdZoom(paneID: p)); return ["ok": true, "data": NSNull()]

        case "tell":
            guard let p = (req["pane"] as? String).flatMap(resolvePane),
                  let text = req["text"] as? String else { return ["ok": false, "error": "bad args"] }
            let payload = (req["enter"] as? Bool == false) ? text : text + "\n"
            injectText(payload, intoPane: p)
            return ["ok": true, "data": NSNull()]

        case "view":
            guard let p = (req["pane"] as? String).flatMap(resolvePane), let pn = pane(p)
            else { return ["ok": false, "error": "no such pane"] }
            let lines = (req["lines"] as? Int) ?? 40
            let forceRaw = (req["raw"] as? Bool) == true
            if !forceRaw, let sid = pn.sessionID, !sid.isEmpty {
                let projects = (NSHomeDirectory() as NSString).appendingPathComponent(".claude/projects")
                guard let file = TranscriptReader.sessionFile(sessionID: sid, projectsDir: projects),
                      let text = try? String(contentsOfFile: file, encoding: .utf8)
                else { return ["ok": true, "data": ["kind": "transcript", "text": "(no transcript yet)"]] }
                let turns = TranscriptReader.turns(fromJSONL: text.components(separatedBy: "\n"), limit: lines)
                let rendered = turns.map { "\($0.role): \($0.text)" }.joined(separator: "\n\n")
                return ["ok": true, "data": ["kind": "transcript", "text": rendered]]
            }
            guard let bytes = ptyRingSnapshot(paneID: p) else {
                return ["ok": false, "error": "no capture for this pane (shell panes need 'serve' enabled)"]
            }
            let raw = String(decoding: bytes, as: UTF8.self)
            let text = forceRaw ? AnsiText.tailLines(raw, lines) : AnsiText.tailLines(AnsiText.strip(raw), lines)
            return ["ok": true, "data": ["kind": forceRaw ? "raw" : "ring", "text": text]]

        case "config-get":
            guard let key = req["key"] as? String else { return ["ok": false, "error": "bad args"] }
            let value: Any = configGet(key).map { $0 as Any } ?? NSNull()
            return ["ok": true, "data": ["key": key, "value": value, "backend": configBackend(key)]]
        case "config-set":
            guard let key = req["key"] as? String, let value = req["value"] as? String
            else { return ["ok": false, "error": "bad args"] }
            guard configSet(key, value) else { return ["ok": false, "error": "unknown or invalid config key: \(key)"] }
            return ["ok": true, "data": NSNull()]
        case "config-list":
            return ["ok": true, "data": ["items": configList()]]

        default: return ["ok": false, "error": "unknown command: \(req["cmd"] as? String ?? "nil")"]
        }
    }

    /// Full workspace→tab→pane tree as plain dicts, assigning/refreshing handles.
    private func controlSnapshot() -> [[String: Any]] {
        var live = Set<String>()
        let tree = workspaces.enumerated().map { idx, ws -> [String: Any] in
            live.insert(ws.id)
            let tabsJSON = ws.tabs.map { tab -> [String: Any] in
                live.insert(tab.tabID)
                let panesJSON = tab.root.panes.map { p -> [String: Any] in
                    live.insert(p.paneID)
                    return [
                        "pane": controlHandles.handle(for: p.paneID, kind: .pane),
                        "uuid": p.paneID,
                        "state": p.state.rawValue,
                        "title": p.displayTitle,
                        "cwd": p.cwd ?? "",
                        "sessionID": p.sessionID ?? "",
                    ]
                }
                return [
                    "tab": controlHandles.handle(for: tab.tabID, kind: .tab),
                    "uuid": tab.tabID,
                    "title": tab.displayTitle,
                    "panes": panesJSON,
                ]
            }
            return [
                "workspace": controlHandles.handle(for: ws.id, kind: .workspace),
                "uuid": ws.id,
                "name": ws.displayName(index: idx),
                "active": ws.id == selectedWorkspaceID,
                "tabs": tabsJSON,
            ]
        }
        controlHandles.prune(live: live)
        return tree
    }

    private func ptyRingSnapshot(paneID: String) -> [UInt8]? {
        ptyHub?.broker(for: paneID)?.snapshotBytes()
    }

    private func paneHasLiveWork(_ paneID: String) -> Bool {
        guard let p = pane(paneID) else { return false }
        return p.state != .shell || (p.sessionID?.isEmpty == false)
    }
    private func workspaceHasLiveWork(_ wsID: String) -> Bool {
        guard let ws = workspaces.first(where: { $0.id == wsID }) else { return false }
        return ws.tabs.contains { $0.root.panes.contains { paneHasLiveWork($0.paneID) } }
    }

    // Config backends: app settings vs the ghostty-syntax config file.
    private var configFilePath: String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".config/shepherd/config")
    }
    private func configBackend(_ key: String) -> String {
        ["sleep.mode", "serve.remote"].contains(key) ? "app" : "file"
    }
    private func configGet(_ key: String) -> String? {
        switch key {
        case "sleep.mode":   return SleepGuard.shared.mode.rawValue
        case "serve.remote": return isServing ? "on" : "off"
        default:
            let text = (try? String(contentsOfFile: configFilePath, encoding: .utf8)) ?? ""
            return ShepherdConfigWriter.get(key, from: text)
        }
    }
    private func configSet(_ key: String, _ value: String) -> Bool {
        switch key {
        case "sleep.mode":
            guard let m = CaffeinateMode(rawValue: value) else { return false }
            SleepGuard.shared.mode = m; return true
        case "serve.remote":
            setServing(value == "on" || value == "true"); return true
        default:
            let edit = ConfigEdit(key: key, kind: ShepherdConfigWriter.kind(for: key), value: value)
            guard (try? ShepherdConfigWriter.set([edit])) != nil else { return false }
            GhosttyApp.shared.reloadConfig()
            return true
        }
    }
    private func configList() -> [[String: Any]] {
        var items: [[String: Any]] = [
            ["key": "sleep.mode", "value": SleepGuard.shared.mode.rawValue, "backend": "app"],
            ["key": "serve.remote", "value": isServing ? "on" : "off", "backend": "app"],
        ]
        let text = (try? String(contentsOfFile: configFilePath, encoding: .utf8)) ?? ""
        for key in ["theme", "worktree-base"] {
            items.append(["key": key, "value": ShepherdConfigWriter.get(key, from: text) ?? "", "backend": "file"])
        }
        return items
    }

    private func focusedControlPaneHandle() -> String {
        guard let id = focusedPaneID else { return "" }
        return controlHandles.handle(for: id, kind: .pane)
    }

    /// Resolve a handle or raw UUID to a live pane UUID.
    private func resolvePane(_ token: String) -> String? {
        let uuid = controlHandles.uuid(for: token) ?? token
        return locatePane(uuid, in: workspaces) != nil ? uuid : nil
    }
    private func resolveWorkspace(_ token: String) -> String? {
        let uuid = controlHandles.uuid(for: token) ?? token
        return workspaces.contains { $0.id == uuid } ? uuid : nil
    }
    private func resolveTab(_ token: String) -> String? {
        let uuid = controlHandles.uuid(for: token) ?? token
        return workspaces.contains { $0.tabs.contains { $0.tabID == uuid } } ? uuid : nil
    }
}
