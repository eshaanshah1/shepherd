import SwiftUI

/// One tab. `state` starts at `.shell` and lights up when a Claude session runs
/// in it (driven by hook events over the socket).
struct Agent: Identifiable {
    let tabID: String
    var title: String           // OSC title the program sets
    var userTitle: String?      // user-set name; overrides the OSC title
    var cwd: String?            // last-known working dir (for restore-on-relaunch)
    var state: AgentState
    var reason: String?         // why blocked / errored (sidebar subtitle)
    var id: String { tabID }

    var displayTitle: String {
        if let u = userTitle, !u.isEmpty { return u }
        return title.isEmpty ? "Terminal" : title
    }
}

/// App model: open tabs, selection, the agent-state socket, and tab persistence.
@MainActor
final class AgentStore: ObservableObject {
    static let shared = AgentStore()

    @Published private(set) var tabs: [Agent] = []
    @Published var selected: String?

    /// Injected into each tab's PTY as $SHEPHERD_SOCK so the Claude plugin can reach us.
    let socketPath: String

    private var server: SocketServer?
    private let persistKey = "shepherd.tabs.v1"

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

    func select(_ tabID: String) { selected = tabID }

    func closeTab(_ tabID: String) {
        tabs.removeAll { $0.tabID == tabID }
        if selected == tabID { selected = tabs.last?.tabID }
        save()
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

    // MARK: Management

    func rename(tabID: String, to title: String) {
        guard let i = tabs.firstIndex(where: { $0.tabID == tabID }) else { return }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        tabs[i].userTitle = trimmed.isEmpty ? nil : trimmed
        save()
    }

    func move(fromOffsets: IndexSet, toOffset: Int) {
        tabs.move(fromOffsets: fromOffsets, toOffset: toOffset)
        save()
    }

    /// cwd to seed a restored tab's surface (consumed once at surface creation).
    func cwd(forTab tabID: String) -> String? {
        tabs.first(where: { $0.tabID == tabID })?.cwd
    }

    // MARK: Feeds from libghostty

    /// Agent-state hook event (over the socket). `detail` carries tool_name /
    /// notification_type / error_type / agent_type depending on the event.
    /// This is the lifecycle map (see SPEC + the hooks.md analysis).
    func apply(event: String, detail: String, tabID: String) {
        guard let i = tabs.firstIndex(where: { $0.tabID == tabID }) else { return }
        func set(_ s: AgentState, _ reason: String? = nil) {
            tabs[i].state = s
            tabs[i].reason = reason
        }
        switch event {
        case "SessionStart":
            set(.idle)
        case "UserPromptSubmit", "PreToolUse", "PostToolUse",
             "PostToolUseFailure", "ElicitationResult", "SubagentStop":
            set(.working)
        case "SubagentStart":
            set(.working, detail.isEmpty ? "subagent" : "subagent: \(detail)")
        case "PermissionRequest":
            // detail = tool_name; ExitPlanMode == plan approval.
            set(.blocked, detail == "ExitPlanMode" ? "plan approval"
                        : (detail.isEmpty ? "approval needed" : "approve \(detail)"))
        case "Elicitation":
            set(.blocked, "input requested")
        case "Notification":
            switch detail {        // notification_type
            case "permission_prompt":  set(.blocked, "approval needed")
            case "elicitation_dialog": set(.blocked, "input requested")
            default: break          // idle_prompt / auth_success / … — no state change
            }
        case "Stop":
            set(.needsCheck)
        case "StopFailure":
            set(.error, detail.isEmpty ? "API error" : detail)   // detail = error_type
        case "SessionEnd":
            set(.shell)             // agent gone; tab persists as a shell
        default:
            break
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
        if tabs[i].state == .needsCheck { tabs[i].state = .idle }
    }

    var attentionCount: Int { tabs.filter { $0.state.wantsAttention }.count }

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
