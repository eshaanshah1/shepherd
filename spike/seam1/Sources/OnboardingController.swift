import SwiftUI
import AppKit

enum OnboardingPhase: Equatable { case dormant, running(Int), finished }

/// Drives the first-run tour: resolves what's available, performs each step's real
/// action against the store, and removes its own sandbox on every exit path.
///
/// Every mutation is scoped to the workspace it created — it never calls an unscoped
/// store op, so there is no path by which the tour can touch a workspace of yours.
@MainActor
final class OnboardingController: ObservableObject {

    @Published private(set) var phase: OnboardingPhase = .dormant
    @Published private(set) var preflight = Preflight(claudePath: nil, pluginInstalled: false,
                                                      gitAvailable: false, sandboxBuilt: false)
    /// Bumped whenever a card's own content changes without the step changing, so the
    /// overlay re-reads copy that depends on live state.
    @Published private(set) var revision = 0
    /// Whether the current step's goal is met. Published rather than computed so the card
    /// re-renders on it: the card observes this controller, not the store or the workbench
    /// session, and those are where the evidence actually lives.
    @Published private(set) var satisfied = true

    private(set) var demoWorkspaceID: String?
    private(set) var demoTabID: String?

    private weak var store: AgentStore?
    private var steps: [OnboardingStep] = []
    private let paths = DemoRepoPaths.standard()
    private var watch: Timer?
    private var stagedBaseline = 0
    private var turnFinishedWatched = false
    private var turnFinishedAway = false

    private static let completedKey = "shepherd.onboarding.completedVersion"
    private static let workspacesKey = "shepherd.workspaces.v1"

    static let shared = OnboardingController(store: .shared)

    init(store: AgentStore) { self.store = store }

    // MARK: - Lifecycle

    /// A dev build seeds its layout from the daily app, so "fresh install" is never
    /// true there; the Help menu item still works.
    func startIfFirstRun() {
        guard !AppMode.isDev,
              UserDefaults.standard.string(forKey: Self.completedKey) == nil,
              UserDefaults.standard.data(forKey: Self.workspacesKey) == nil
        else { return }
        start()
    }

    func start() {
        if case .running = phase { return }
        preflight = resolvePreflight(sandboxBuilt: false)
        steps = OnboardingPolicy.steps(for: preflight)
        guard !steps.isEmpty else { return }
        phase = .running(0)
        enter(steps[0])
        run(steps[0].action)
    }

    /// A sandbox on disk with no tour running is the residue of a crash mid-tour.
    func reconcileAtLaunch() {
        guard phase == .dormant,
              FileManager.default.fileExists(atPath: paths.root) else { return }
        OnboardingDemoRepo.teardown(at: paths, worktreeBase: worktreeBase())
    }

    // MARK: - Navigation

    var currentStep: OnboardingStep? {
        guard case .running(let i) = phase, steps.indices.contains(i) else { return nil }
        return steps[i]
    }
    var stepNumber: Int { if case .running(let i) = phase { return i + 1 }; return 0 }
    var stepCount: Int { steps.count }
    var isLastStep: Bool { if case .running(let i) = phase { return i == steps.count - 1 }; return false }

    /// Lifted off the store each time the card re-renders (the card observes the store, so
    /// this is re-read whenever anything it depends on changes).
    var progress: TourProgress {
        var p = TourProgress(stagedBaseline: stagedBaseline)
        guard let store else { return p }
        p.ephemeralOpen = !store.ephemeralPanes.isEmpty
        p.workbenchOpen = store.diffPanelOpen
        p.cheatsheetOpen = store.showShortcuts
        p.turnFinishedWatched = turnFinishedWatched
        p.turnFinishedAway = turnFinishedAway
        if let ws = demoWorkspaceID, let w = store.workspaces.first(where: { $0.id == ws }) {
            p.demoTabCount = w.tabs.count
            if let t = demoTabID, let tab = w.tabs.first(where: { $0.tabID == t }) {
                p.demoPaneCount = tab.paneIDs.count
                p.agentRunning = tab.root.panes.contains { $0.state != .shell }
            }
        }
        if let session = demoSession() {
            p.stagedCount = session.stagedPaths.count
            p.bufferDirty = !session.dirtyPaths.isEmpty
            p.commentCount = session.comments.count
            p.inCommitsScope = session.scope == .commits
        }
        return p
    }

    /// Has the user done what this card asked? `.none` goals are always satisfied.
    private var goalMet: Bool {
        guard let step = currentStep else { return true }
        return step.goal.satisfied(by: progress)
    }

    /// Polled rather than observed: the evidence is spread across `AgentStore` and a lazily
    /// created `WorkbenchSession`, and one timer that stops itself on success beats two
    /// subscription lifecycles. Cheap — it only runs while a goal is outstanding.
    private func startWatching() {
        stopWatching()
        satisfied = goalMet
        guard !satisfied else { return }
        watch = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                let met = self.goalMet
                if met != self.satisfied { self.satisfied = met }
                if met { self.stopWatching() }
            }
        }
    }

    private func stopWatching() {
        watch?.invalidate()
        watch = nil
    }

    func advance() {
        guard case .running(let i) = phase else { return }
        leave(steps[i])
        let next = i + 1
        guard next < steps.count else { return finish() }
        phase = .running(next)
        enter(steps[next])
        run(steps[next].action)
    }

    /// Snapshot whatever a goal has to be measured against. The sandbox ships with one
    /// file already staged, so "staged something" is a delta, not a count.
    private func enter(_ step: OnboardingStep) {
        if step.goal == .stagedSomething {
            stagedBaseline = demoSession()?.stagedPaths.count ?? 0
        }
        if step.goal == .turnFinished || step.goal == .turnFinishedAway {
            turnFinishedWatched = false
            turnFinishedAway = false
        }
        startWatching()
    }

    /// Undo anything a step left floating over the rest of the tour. The ephemeral overlay
    /// sits above the workbench in `ContentView`'s ZStack — by design, it's a scratch shell
    /// over your work — so leaving it up would occlude every later step.
    private func leave(_ step: OnboardingStep) {
        guard let store else { return }
        switch step.goal {
        case .ephemeralOpen:
            // They may have left it up; the ephemeral overlay sits above the workbench by
            // design, so it would occlude every later step.
            for pane in store.ephemeralPanes { store.closeEphemeral(pane.id) }
        case .cheatsheetOpen:
            store.showShortcuts = false
        case .unsplitPane:
            // Skipped rather than done — put the tab back to one pane anyway.
            if let second = demoPane(1) { store.closePane(second) }
        default:
            break
        }
    }

    func skip() {
        guard case .running = phase else { return }
        finish()
    }

    private func finish() {
        stopWatching()
        teardownNow()
        phase = .finished
    }

    // MARK: - Preflight

    func refreshPreflight() {
        preflight = resolvePreflight(sandboxBuilt: preflight.sandboxBuilt)
    }

    /// A GUI .app misses Homebrew's PATH, so `claude` has to be resolved through a login
    /// shell rather than assumed present — the same problem `GH.executablePath` solves.
    private func resolvePreflight(sandboxBuilt: Bool) -> Preflight {
        // `linkedElsewhere` counts as installed: the hook fires whichever checkout the
        // symlink points at, so a developer running off the repo link has a working
        // plugin and must not be told the agent demo is unavailable.
        let plugin: Bool
        switch ClaudePluginInstaller.currentState() {
        case .installed, .linkedElsewhere: plugin = true
        case .unavailable, .notInstalled, .occupied: plugin = false
        }
        return Preflight(claudePath: Self.resolve("claude"),
                         pluginInstalled: plugin,
                         gitAvailable: Self.resolve("git") != nil,
                         sandboxBuilt: sandboxBuilt)
    }

    /// Probes the usual install locations first — a GUI `.app` inherits a minimal PATH
    /// that omits Homebrew — then falls back to `which` under an augmented PATH. Not
    /// `bash -lc`: that reads *bash* profiles, so a PATH configured in zsh is invisible
    /// to it and the tour concluded Claude Code wasn't installed.
    private static func resolve(_ tool: String) -> String? {
        let candidates = ["/opt/homebrew/bin/", "/usr/local/bin/", "/usr/bin/", "/bin/"]
            .map { $0 + tool }
        if let hit = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            return hit
        }
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.environment = env
        p.arguments = ["which", tool]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        let path = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return path.isEmpty ? nil : path
    }

    func reloadConfig() { GhosttyApp.shared.reloadConfig() }

    private func worktreeBase() -> String {
        store?.worktreeBaseDir() ?? AppMode.supportPath("worktrees")
    }

    // MARK: - Actions

    private func run(_ action: OnboardingAction) {
        switch action {
        case .none:
            break
        case .buildSandbox:
            let p = paths
            Task.detached {
                let ok: Bool
                if case .success = OnboardingDemoRepo.build(at: p) { ok = true } else { ok = false }
                await MainActor.run { self.sandboxFinished(ok) }
            }
        case .createDemoWorkspace:  createDemoWorkspace()
        case .startConflictMerge:   startConflictMerge()
        case .teardown:             teardownNow()
        }
    }

    /// Re-filtering here rather than in `start()` is what lets the sandbox build run
    /// while the user reads the welcome card.
    private func sandboxFinished(_ ok: Bool) {
        preflight.sandboxBuilt = ok
        guard case .running(let i) = phase, steps.indices.contains(i) else { return }
        let currentID = steps[i].id
        steps = OnboardingPolicy.steps(for: preflight)
        if let idx = steps.firstIndex(where: { $0.id == currentID }) { phase = .running(idx) }
        revision += 1
    }

    /// `newWorkspace()` already comes with one tab, whose pane predates the default
    /// directory — so the tour adds its own tab in the sandbox and drops that one,
    /// leaving the demo tab at index 0 and the worktree tab at index 1.
    private func createDemoWorkspace() {
        guard let store else { return }
        let ws = store.newWorkspace()
        let placeholder = store.workspaces.first { $0.id == ws }?.tabs.first?.tabID
        store.renameWorkspace(ws, to: "Shepherd Tour")
        store.setWorkspaceDirectory(ws, to: paths.clone)

        let tab = store.newTab(inWorkspace: ws, cwd: paths.clone)
        guard !tab.isEmpty else { return }
        if let placeholder { store.closeTab(placeholder, inWorkspace: ws) }

        demoWorkspaceID = ws
        demoTabID = tab
        store.selectWorkspace(ws)
        store.select(tabID: tab, inWorkspace: ws)
    }

    /// Reuses the same store call ⌘D makes, after selecting the demo tab — no synthetic
    /// key events, and no new unscoped store surface.
    private func demoPane(_ index: Int) -> String? {
        guard let store, let ws = demoWorkspaceID, let t = demoTabID,
              let w = store.workspaces.first(where: { $0.id == ws }),
              let tab = w.tabs.first(where: { $0.tabID == t }),
              tab.paneIDs.indices.contains(index) else { return nil }
        return tab.paneIDs[index]
    }

    /// The workbench session the user is actually looking at — which is the worktree tab's
    /// once the conflict step moves them there, not the original demo pane's.
    private func demoSession() -> WorkbenchSession? {
        guard let store else { return nil }
        if let pid = store.diffPanelPaneID { return store.workbenchSession(forPane: pid) }
        guard let pane = demoPane(0) else { return nil }
        return store.workbenchSession(forPane: pane)
    }

    /// Set from `AgentStore.applyTransition`, which already knows whether the pane was
    /// being watched — read off `StateTransition.turnFinished`, never `state == .needsCheck`,
    /// which by design never happens for a turn that ends under your eyes.
    func noteTurnFinished(paneID: String, viewing: Bool) {
        guard let ws = demoWorkspaceID, let store,
              let w = store.workspaces.first(where: { $0.id == ws }),
              w.tabs.contains(where: { $0.paneIDs.contains(paneID) }) else { return }
        if viewing { turnFinishedWatched = true } else { turnFinishedAway = true }
        revision += 1
    }

    /// The conflict is created in the *worktree*, not the clone: the clone's tree is
    /// deliberately dirty and git refuses to merge over a modified index. The worktree
    /// is clean, so this is a plain commit-then-merge.
    private func startConflictMerge() {
        guard let store, let ws = demoWorkspaceID else { return }
        // The user named the worktree, so its path can't be recomputed — take it from the
        // cwd of the tab they created.
        guard let w = store.workspaces.first(where: { $0.id == ws }),
              let wtTab = w.tabs.last(where: { $0.tabID != demoTabID }),
              let dir = wtTab.root.panes.first?.cwd,
              FileManager.default.fileExists(atPath: dir) else { return }

        let readme = (dir as NSString).appendingPathComponent("README.md")
        try? "# Shepherd Tour Sandbox\n\nEdited on this branch.\n"
            .write(toFile: readme, atomically: true, encoding: .utf8)
        let ident = ["-c", "user.name=Shepherd Tour", "-c", "user.email=tour@shepherd.local",
                     "-c", "commit.gpgsign=false"]
        _ = Git.run(ident + ["commit", "-am", "Reword the README here too"], in: dir)
        _ = Git.run(ident + ["merge", OnboardingDemoRepo.conflictBranch], in: dir)

        store.select(tabID: wtTab.tabID, inWorkspace: ws)
        store.focusPane(wtTab.focusedPaneID)
        if !store.diffPanelOpen { store.toggleDiffPanel() }
    }

    // MARK: - Teardown

    /// Idempotent, and the sandbox must be gone before the store persists — otherwise
    /// the demo workspace, its cwds and a live Claude sessionID land in
    /// `shepherd.workspaces.v1` and get `--resume`d next launch into a deleted directory.
    func teardownNow() {
        // Quit calls this unconditionally. Without this guard, someone who never saw
        // the tour would have it marked complete and never be offered it.
        guard phase != .dormant || demoWorkspaceID != nil else { return }

        if let store {
            store.showShortcuts = false
            if store.diffPanelOpen { store.toggleDiffPanel() }
            for pane in store.ephemeralPanes { store.closeEphemeral(pane.id) }
            if let ws = demoWorkspaceID {
                store.deleteWorkspace(ws)
                // `deleteWorkspace` refuses to remove the last workspace. If the tour's
                // is somehow it, empty it instead — a workspace with no tabs is legal,
                // and leaving live panes on a deleted directory is not.
                if let stuck = store.workspaces.first(where: { $0.id == ws }) {
                    for tab in stuck.tabs { store.closeTab(tab.tabID, inWorkspace: ws) }
                }
            }
        }
        demoWorkspaceID = nil
        demoTabID = nil
        OnboardingDemoRepo.teardown(at: paths, worktreeBase: worktreeBase())
        UserDefaults.standard.set(AppVersion.current.description, forKey: Self.completedKey)
        store?.save()
    }
}
