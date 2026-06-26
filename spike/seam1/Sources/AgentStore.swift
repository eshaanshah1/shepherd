import SwiftUI

/// One tab. `state` starts at `.shell` and lights up when a Claude session runs
/// in it (driven by hook events arriving over the socket).
struct Agent: Identifiable {
    let tabID: String
    var title: String
    var state: AgentState
    var id: String { tabID }
}

/// App model: the open tabs, the selection, and the receiving end of the agent
/// state socket. One row per tab (we show them all for now — SPEC §4 filtering
/// comes later).
@MainActor
final class AgentStore: ObservableObject {
    static let shared = AgentStore()

    @Published private(set) var tabs: [Agent] = []
    @Published var selected: String?

    /// Injected into each tab's PTY as $SHEPHERD_SOCK so the Claude plugin can reach us.
    let socketPath: String

    private var server: SocketServer?

    private init() {
        socketPath = "/tmp/shepherd-\(getpid()).sock"   // short path: stays under sun_path's 104 limit
        server = SocketServer(path: socketPath) { [weak self] tabID, event in
            self?.apply(event: event, tabID: tabID)
        }
        server?.start()
        newTab()   // open with one tab
    }

    // MARK: Tabs

    @discardableResult
    func newTab(title: String = "Terminal") -> String {
        let id = UUID().uuidString
        tabs.append(Agent(tabID: id, title: title, state: .shell))
        selected = id
        return id
    }

    func select(_ tabID: String) { selected = tabID }

    func closeTab(_ tabID: String) {
        tabs.removeAll { $0.tabID == tabID }
        if selected == tabID { selected = tabs.last?.tabID }
    }

    // MARK: Agent state (from the socket)

    func apply(event: String, tabID: String) {
        guard let i = tabs.firstIndex(where: { $0.tabID == tabID }) else { return }
        if event == "SessionEnd" {
            tabs[i].state = .shell          // agent gone; the tab persists as a shell
        } else if let s = AgentState.from(event: event) {
            tabs[i].state = s
        }
    }

    func setTitle(_ title: String, tabID: String) {
        guard !title.isEmpty, let i = tabs.firstIndex(where: { $0.tabID == tabID }) else { return }
        tabs[i].title = title
    }

    /// Focus clears need-to-check → idle ONLY (never blocked/working).
    func didFocus(tabID: String) {
        guard let i = tabs.firstIndex(where: { $0.tabID == tabID }) else { return }
        if tabs[i].state == .needsCheck { tabs[i].state = .idle }
    }

    var attentionCount: Int { tabs.filter { $0.state.wantsAttention }.count }
}
