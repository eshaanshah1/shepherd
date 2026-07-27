import XCTest
@testable import Shepherd

final class LockPolicyTests: XCTestCase {
    private let allStates: [FollowState] = [.following, .locked, .lockedStale]

    func testACleanFileFollowsExternalWrites() {
        XCTAssertEqual(LockPolicy.next(.following, on: .externalWrite), .following)
        XCTAssertTrue(LockPolicy.shouldReloadFromDisk(.following, on: .externalWrite))
    }

    func testTypingLocksTheFile() {
        XCTAssertEqual(LockPolicy.next(.following, on: .userEdit), .locked)
    }

    func testALockedFileIgnoresExternalWritesButRemembersThem() {
        XCTAssertEqual(LockPolicy.next(.locked, on: .externalWrite), .lockedStale)
        XCTAssertFalse(LockPolicy.shouldReloadFromDisk(.locked, on: .externalWrite),
                       "reloading would discard the user's unsaved edits")
    }

    func testAStaleLockedFileStaysStaleOnFurtherWrites() {
        XCTAssertEqual(LockPolicy.next(.lockedStale, on: .externalWrite), .lockedStale)
        XCTAssertFalse(LockPolicy.shouldReloadFromDisk(.lockedStale, on: .externalWrite))
    }

    func testEditingAStaleFileKeepsItStale() {
        // The agent's write is still unreconciled; typing more must not hide that.
        XCTAssertEqual(LockPolicy.next(.lockedStale, on: .userEdit), .lockedStale)
    }

    func testEditingALockedFileKeepsItMerelyLocked() {
        XCTAssertEqual(LockPolicy.next(.locked, on: .userEdit), .locked)
    }

    func testSavingResumesFollowingFromAnyState() {
        for state in allStates {
            XCTAssertEqual(LockPolicy.next(state, on: .userSaved), .following,
                           "\(state) should resume following after a save")
        }
    }

    func testDiscardingResumesFollowingAndReloads() {
        XCTAssertEqual(LockPolicy.next(.lockedStale, on: .userDiscarded), .following)
        XCTAssertTrue(LockPolicy.shouldReloadFromDisk(.lockedStale, on: .userDiscarded),
                      "take-theirs must pull the agent's version in")
    }

    func testSavingDoesNotReloadFromDisk() {
        XCTAssertFalse(LockPolicy.shouldReloadFromDisk(.locked, on: .userSaved),
                       "we just wrote our own text; re-reading it is pointless churn")
    }

    func testUserEditNeverReloads() {
        for state in allStates {
            XCTAssertFalse(LockPolicy.shouldReloadFromDisk(state, on: .userEdit))
        }
    }

    func testOnlyLockedStateIsEverStale() {
        // A file that has never been typed in can't need reconciliation.
        XCTAssertNotEqual(LockPolicy.next(.following, on: .externalWrite), .lockedStale)
    }

    func testEveryStateEventPairIsTotal() {
        // Exhaustiveness: no combination traps or returns something unexpected.
        let events: [DiskEvent] = [.externalWrite, .userEdit, .userSaved, .userDiscarded]
        for state in allStates {
            for event in events {
                XCTAssertTrue(allStates.contains(LockPolicy.next(state, on: event)),
                              "\(state) + \(event) produced an unknown state")
            }
        }
    }
}
