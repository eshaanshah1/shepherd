import XCTest
import Darwin

/// Loopback: a real RemoteServer + a real RemoteClient over 127.0.0.1 — proves the client
/// pairs, receives the structural snapshot, exposes the session nonce, and drives the host.
final class RemoteClientTests: XCTestCase {

    /// Thread-safe one-slot holder (callbacks fire on the client's reader thread).
    private final class Holder<T> {
        private let lock = NSLock(); private var v: T?
        func set(_ x: T) { lock.lock(); v = x; lock.unlock() }
        var value: T? { lock.lock(); defer { lock.unlock() }; return v }
    }

    private func server(trees: @escaping () -> [WorkspaceTree],
                        onCommand: @escaping (ControlMessage) -> Void = { _ in }) -> RemoteServer {
        RemoteServer(
            bindAddress: "127.0.0.1", port: 0,
            currentCode: { "8421" },
            knownDevices: { [PairedDevice(deviceID: "macB", secret: "S", name: "MacB")] },   // known → auto-accept
            persist: { _ in },
            requestApproval: { _, _, decide in decide(true) },
            workspaceTrees: trees,
            updateFCMToken: { _, _ in },
            makeSecret: { "S" }, makeNonce: { "NONCE" },
            onCommand: onCommand)
    }

    private let sampleTree = WorkspaceTree(
        workspaceID: "w1", name: "WS",
        tabs: [RemoteTab(tabID: "t1",
            root: .leaf(RemotePane(paneID: "p1", title: "zsh", cwd: nil, state: "working", reason: nil)),
            focusedPaneID: "p1", zoomedPaneID: nil)],
        selectedTabID: "t1")

    func testClientPairsReceivesTreeAndNonce() throws {
        let s = server(trees: { [self.sampleTree] })
        XCTAssertTrue(s.start()); defer { s.stop() }

        let accepted = expectation(description: "accepted")
        let gotTree = expectation(description: "workspaceTree")
        let nonceH = Holder<String>(); let treeH = Holder<WorkspaceTree>()
        let client = RemoteClient(
            host: "127.0.0.1", port: s.boundPort, deviceID: "macB", deviceName: "MacB",
            code: nil, secret: "S",
            onAccepted: { nonceH.set($0); accepted.fulfill() },
            onWorkspaceTree: { treeH.set($0); gotTree.fulfill() },
            onState: { _, _, _ in },
            onStatus: { _ in })
        client.start(); defer { client.stop() }

        wait(for: [accepted, gotTree], timeout: 5)
        XCTAssertEqual(nonceH.value, "NONCE")
        XCTAssertEqual(client.sessionNonce, "NONCE")
        XCTAssertEqual(treeH.value, sampleTree)
    }

    func testClientSendReachesHostOnCommand() throws {
        let got = expectation(description: "cmd reached host")
        let cmdH = Holder<ControlMessage>()
        let s = server(trees: { [self.sampleTree] }, onCommand: { cmdH.set($0); got.fulfill() })
        XCTAssertTrue(s.start()); defer { s.stop() }

        let ready = expectation(description: "accepted")
        let client = RemoteClient(
            host: "127.0.0.1", port: s.boundPort, deviceID: "macB", deviceName: "MacB",
            code: nil, secret: "S",
            onAccepted: { _ in ready.fulfill() },
            onWorkspaceTree: { _ in },
            onState: { _, _, _ in },
            onStatus: { _ in })
        client.start(); defer { client.stop() }
        wait(for: [ready], timeout: 5)                 // only send once paired

        client.send(.cmdNewTab(workspaceID: "w1"))
        wait(for: [got], timeout: 5)
        XCTAssertEqual(cmdH.value, .cmdNewTab(workspaceID: "w1"))
    }

    func testBadSecretGoesDead() throws {
        let s = server(trees: { [] })
        XCTAssertTrue(s.start()); defer { s.stop() }
        let dead = expectation(description: "dead")
        dead.assertForOverFulfill = false   // .dead fires on both reject and loop-exit
        let client = RemoteClient(
            host: "127.0.0.1", port: s.boundPort, deviceID: "macB", deviceName: "MacB",
            code: nil, secret: "WRONG",                // known device, wrong secret → reject
            onAccepted: { _ in XCTFail("should not accept") },
            onWorkspaceTree: { _ in },
            onState: { _, _, _ in },
            onStatus: { if $0 == .dead { dead.fulfill() } })
        client.start(); defer { client.stop() }
        wait(for: [dead], timeout: 5)
        XCTAssertNil(client.sessionNonce)
    }
}
