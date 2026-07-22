import Foundation

enum HandleKind: String { case workspace = "ws", tab = "t", pane = "p" }

/// Short, human-ish handles (ws1/t1/p1) mapped to opaque UUIDs. Handles are
/// stable while an entity lives and minted monotonically, so a number is never
/// reused for a different entity within one run.
final class HandleRegistry {
    private var toHandle: [String: String] = [:]   // uuid  -> handle
    private var toUUID: [String: String] = [:]      // handle -> uuid
    private var counters: [HandleKind: Int] = [:]

    func handle(for uuid: String, kind: HandleKind) -> String {
        if let h = toHandle[uuid] { return h }
        let n = (counters[kind] ?? 0) + 1
        counters[kind] = n
        let h = "\(kind.rawValue)\(n)"
        toHandle[uuid] = h
        toUUID[h] = uuid
        return h
    }

    func uuid(for handle: String) -> String? { toUUID[handle] }

    func prune(live: Set<String>) {
        for (uuid, h) in toHandle where !live.contains(uuid) {
            toHandle[uuid] = nil
            toUUID[h] = nil
        }
    }
}
