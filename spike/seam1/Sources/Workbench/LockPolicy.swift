import Foundation

/// Whether a buffer tracks disk. `.lockedStale` means the user has unsaved edits
/// *and* an agent has written the file since — the only state needing a decision
/// from the user.
enum FollowState: Equatable { case following, locked, lockedStale }

enum DiskEvent: Equatable {
    case externalWrite   // an agent (or anything else) wrote the file
    case userEdit        // the user typed in this buffer
    case userSaved       // keep-mine: our text was written to disk
    case userDiscarded   // take-theirs: drop our edits
}

/// The live-follow / dirty-lock decision, pure so it can be exhaustively tested
/// (mirrors `SleepPolicy` behind `SleepGuard`).
///
/// Clean buffers stream agent edits. The instant the user types, that one buffer
/// stops following — never the whole workbench.
enum LockPolicy {
    static func next(_ state: FollowState, on event: DiskEvent) -> FollowState {
        switch (state, event) {
        case (_, .userSaved), (_, .userDiscarded):
            return .following
        case (.following, .externalWrite):
            return .following
        case (.following, .userEdit):
            return .locked
        case (.locked, .externalWrite), (.lockedStale, _):
            return .lockedStale
        case (.locked, .userEdit):
            return .locked
        }
    }

    /// Whether this transition should re-read the file. Only two cases: a clean
    /// buffer seeing a write, and an explicit discard.
    static func shouldReloadFromDisk(_ state: FollowState, on event: DiskEvent) -> Bool {
        switch event {
        case .externalWrite:        return state == .following
        case .userDiscarded:        return true
        case .userEdit, .userSaved: return false
        }
    }
}
