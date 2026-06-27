import SwiftUI
import AppKit
import UserNotifications

/// One tab. `state` starts at `.shell` and lights up when a Claude session runs
/// in it (driven by hook events over the socket).
struct Agent: Identifiable {
    let tabID: String
    var title: String           // OSC title the program sets
    var userTitle: String?      // user-set name; overrides the OSC title
    var cwd: String?            // last-known working dir (for restore-on-relaunch)
    var state: AgentState
    var reason: String?         // why blocked / errored
    var id: String { tabID }

    var displayTitle: String {
        if let u = userTitle, !u.isEmpty { return u }
        if state != .shell, !title.isEmpty { return title }   // agent: show the title it set
        return cwdName ?? "Terminal"
    }

    /// Default name from the working dir: home → "~", a child of home → "~/dir",
    /// else "parent/dir". We never surface the shell's user@host OSC title.
    private var cwdName: String? {
        guard let cwd, !cwd.isEmpty else { return nil }
        let home = NSHomeDirectory()
        if cwd == home { return "~" }
        let ns = cwd as NSString
        let last = ns.lastPathComponent
        let parent = ns.deletingLastPathComponent
        if parent == home { return "~/\(last)" }
        let parentName = (parent as NSString).lastPathComponent
        return (parentName.isEmpty || parentName == "/") ? last : "\(parentName)/\(last)"
    }
}

/// App model: open tabs, selection, the agent-state socket, and tab persistence.
@MainActor
final class AgentStore: ObservableObject {
    static let shared = AgentStore()

    @Published private(set) var tabs: [Agent] = []
    @Published var selected: String?

    /// Bumped to force the selected terminal to reclaim first responder
    /// (e.g. after a rename ends and the text field gives up focus).
    @Published var focusTick = 0
    func refocusActiveTerminal() { focusTick += 1 }

    /// Injected into each tab's PTY as $SHEPHERD_SOCK so the Claude plugin can reach us.
    let socketPath: String

    private var server: SocketServer?
    private let persistKey = "shepherd.tabs.v1"

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
        server = SocketServer(path: socketPath) { [weak self] tabID, event, detail in
            self?.apply(event: event, detail: detail, tabID: tabID)
        }
        server?.start()
        if !restore() { newTab() }   // reopen prior tabs, else start with one
    }

    // MARK: Tabs

    @discardableResult
    func newTab(title: String = "Terminal") -> String {
        let id = UUID().uuidString
        tabs.append(Agent(tabID: id, title: title, state: .shell))
        selected = id
        save()
        return id
    }

    func select(_ tabID: String) {
        selected = tabID
        didFocus(tabID: tabID)   // viewing a finished tab clears its need-to-check
    }

    func closeTab(_ tabID: String) {
        tabs.removeAll { $0.tabID == tabID }
        if selected == tabID {
            selected = tabs.last?.tabID
            // Reclaim focus next runloop: the closed surface's teardown resets the
            // window's first responder, clobbering any same-pass refocus.
            DispatchQueue.main.async { [weak self] in self?.refocusActiveTerminal() }
        }
        save()
        updateDockBadge()
    }

    func closeSelected() {
        if let sel = selected { closeTab(sel) }
    }

    // MARK: Keyboard navigation

    func selectIndex(_ oneBased: Int) {
        let i = oneBased - 1
        guard tabs.indices.contains(i) else { return }
        selected = tabs[i].tabID
    }

    func selectNext()     { cycle(+1) }
    func selectPrevious() { cycle(-1) }

    private func cycle(_ delta: Int) {
        guard !tabs.isEmpty,
              let cur = selected,
              let i = tabs.firstIndex(where: { $0.tabID == cur }) else { return }
        selected = tabs[(i + delta + tabs.count) % tabs.count].tabID
    }

    /// Jump to the next tab that needs you (blocked / need-to-check / error).
    func selectNextAttention() {
        guard !tabs.isEmpty else { return }
        let start = tabs.firstIndex(where: { $0.tabID == selected }) ?? -1
        for off in 1...tabs.count {
            let idx = (start + off) % tabs.count
            if tabs[idx].state.wantsAttention { selected = tabs[idx].tabID; return }
        }
        NSSound.beep()   // nothing needs you
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

    /// cwd to seed a restored tab's surface (consumed once at surface creation).
    func cwd(forTab tabID: String) -> String? {
        tabs.first(where: { $0.tabID == tabID })?.cwd
    }

    // MARK: Feeds from libghostty

    /// Agent-state hook event (over the socket). `detail` carries the cosmetic
    /// reason field (tool_name / error_type / agent_type) for the few events that
    /// have one. The lifecycle map — see SPEC + the hooks.md analysis.
    ///
    /// Ordering guard: hooks are independent socket writes with no delivery-order
    /// guarantee, so a stale mid-turn event can arrive after `Stop`. We only let
    /// mid-turn transitions apply while the tab is actually mid-turn (working or
    /// blocked); a finished turn (need-to-check) can only be left by a real new
    /// turn (UserPromptSubmit) or by focus. This kills the "need-to-check flips
    /// back to working" bug deterministically, regardless of arrival order.
    func apply(event: String, detail: String, tabID: String) {
        guard let i = tabs.firstIndex(where: { $0.tabID == tabID }) else {
            shepherdLog("event=\(event) tab=\(tabID.prefix(8)) -> NO SUCH TAB")
            return
        }
        let cur = tabs[i].state
        let midTurn = (cur == .working || cur == .blocked)
        var applied = true
        func set(_ s: AgentState, _ reason: String? = nil) {
            tabs[i].state = s
            tabs[i].reason = reason
        }

        switch event {
        case "SessionStart":      tabs[i].title = ""; set(.idle)      // drop shell title; the agent sets its own
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

        shepherdLog("event=\(event)\(detail.isEmpty ? "" : "[\(detail)]") tab=\(tabID.prefix(8)) "
            + (applied ? "\(cur.rawValue)->\(tabs[i].state.rawValue)" : "\(cur.rawValue) (ignored: not mid-turn)"))

        if applied {
            let newState = tabs[i].state
            if newState != cur, newState.wantsAttention {
                notifyAttention(tabs[i])
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
    func setTitle(_ title: String, tabID: String) {
        guard !title.isEmpty, let i = tabs.firstIndex(where: { $0.tabID == tabID }) else { return }
        tabs[i].title = title
    }

    /// Working directory (PWD action) — tracked so we can restore it on relaunch.
    func setCwd(_ cwd: String, tabID: String) {
        guard !cwd.isEmpty, let i = tabs.firstIndex(where: { $0.tabID == tabID }), tabs[i].cwd != cwd else { return }
        tabs[i].cwd = cwd
        save()
    }

    /// Focus clears need-to-check → idle ONLY (never blocked/working).
    func didFocus(tabID: String) {
        guard let i = tabs.firstIndex(where: { $0.tabID == tabID }) else { return }
        if tabs[i].state == .needsCheck { tabs[i].state = .idle; updateDockBadge() }
    }

    var attentionCount: Int { tabs.filter { $0.state.wantsAttention }.count }

    // MARK: Attention surfacing (dock badge + backgrounded notifications)

    private func updateDockBadge() {
        let n = attentionCount
        NSApp.dockTile.badgeLabel = n > 0 ? "\(n)" : nil
    }

    /// Fire a native notification when a tab needs you — but only while Shepherd
    /// is NOT frontmost (when it is, the badge + sidebar are enough).
    private func notifyAttention(_ tab: Agent) {
        guard !NSApp.isActive else { return }
        let content = UNMutableNotificationContent()
        content.title = tab.displayTitle
        switch tab.state {
        case .blocked:    content.body = tab.reason ?? "needs you"
        case .needsCheck: content.body = "finished — needs a look"
        case .error:      content.body = "errored: \(tab.reason ?? "API error")"
        default:          return
        }
        content.userInfo = ["tabID": tab.tabID]
        content.sound = nil   // we play our own chime (playAttentionSound) — avoid a double
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "\(tab.tabID)-\(tab.state.rawValue)",
                                  content: content, trigger: nil))
    }

    /// Audible cue on entering an attention state. Always plays, foreground or
    /// background; `error` has no entry and is intentionally silent.
    private func playAttentionSound(for state: AgentState) {
        guard let sound = attentionSounds[state] else { return }
        sound.stop()   // restart if still ringing, so a rapid re-block re-pings
        sound.play()
    }

    // MARK: Persistence (userTitle + cwd, in tab order)

    private struct Persisted: Codable { var userTitle: String?; var cwd: String? }

    private func save() {
        let snapshot = tabs.map { Persisted(userTitle: $0.userTitle, cwd: $0.cwd) }
        if let data = try? JSONEncoder().encode(snapshot) {
            UserDefaults.standard.set(data, forKey: persistKey)
        }
    }

    private func restore() -> Bool {
        guard let data = UserDefaults.standard.data(forKey: persistKey),
              let snapshot = try? JSONDecoder().decode([Persisted].self, from: data),
              !snapshot.isEmpty else { return false }
        tabs = snapshot.map {
            Agent(tabID: UUID().uuidString, title: "Terminal",
                  userTitle: $0.userTitle, cwd: $0.cwd, state: .shell)
        }
        selected = tabs.first?.tabID
        return true
    }
}
