import SwiftUI

struct Agent: Identifiable {
    let tabID: String
    var title: String = "New session"   // replaced by the surface's OSC title callback
    var state: AgentState = .idle
    var id: String { tabID }
}

/// Source of truth for the sidebar. Encodes the SPEC §2 transition rules.
@MainActor
final class AgentStore: ObservableObject {
    @Published private(set) var agents: [Agent] = []   // stable order = insertion order

    /// A Claude Code hook event (delivered over the unix socket) for a tab.
    func apply(event: String, tabID: String) {
        if event == "SessionEnd" { remove(tabID: tabID); return }
        guard let newState = AgentState.from(event: event) else { return }
        upsert(tabID: tabID) { $0.state = newState }
    }

    /// Surface title callback (OSC 0/2) → row label. Separate feed from state.
    func setTitle(_ title: String, tabID: String) {
        upsert(tabID: tabID) { if !title.isEmpty { $0.title = title } }
    }

    /// Focus clears need-to-check → idle ONLY. Never touches blocked/working.
    func didFocus(tabID: String) {
        guard let i = agents.firstIndex(where: { $0.tabID == tabID }) else { return }
        if agents[i].state == .needsCheck { agents[i].state = .idle }
    }

    /// Backstop: PTY child-exit removes the row too (not just SessionEnd).
    func remove(tabID: String) {
        agents.removeAll { $0.tabID == tabID }
    }

    var attentionCount: Int { agents.filter { $0.state.wantsAttention }.count }

    private func upsert(tabID: String, _ mutate: (inout Agent) -> Void) {
        if let i = agents.firstIndex(where: { $0.tabID == tabID }) {
            mutate(&agents[i])
        } else {
            var a = Agent(tabID: tabID)
            mutate(&a)
            agents.append(a)
        }
    }

    /// TODO(seam 1+2): bind the unix socket here and call `apply(event:tabID:)`.
    /// The working accept/read/parse loop already exists in
    /// `../socket-probe/Sources/socket-probe/main.swift` — lift it onto a
    /// background task and hop back to the main actor to call `apply`.
    func listen() async { /* empty in skeleton — see socket-probe */ }
}
