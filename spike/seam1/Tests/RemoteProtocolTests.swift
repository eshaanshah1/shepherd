import XCTest

final class RemoteProtocolTests: XCTestCase {

    func testFrameRoundTripSingleMessage() throws {
        let msg = ControlMessage.state(paneID: "p1", state: "blocked", reason: "approve Bash")
        let data = try FrameCodec.encode(msg)
        let dec = FrameDecoder()
        XCTAssertEqual(try dec.feed(data), [msg])
    }

    func testFrameDecoderReassemblesAcrossChunks() throws {
        let a = try FrameCodec.encode(.ping)
        let b = try FrameCodec.encode(.paneRenamed(paneID: "p1", title: "claude"))
        let stream = a + b
        let dec = FrameDecoder()
        // Feed byte-by-byte: nothing emitted until each frame completes.
        var out: [ControlMessage] = []
        for byte in stream { out += try dec.feed(Data([byte])) }
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out.first, .ping)
    }

    func testHelloCodecRoundTrip() throws {
        let hello = ControlMessage.hello(deviceID: "d1", deviceName: "Pixel", pairingCode: "8421",
                                         secret: nil, fcmToken: nil, protocolVersion: kRemoteProtocolVersion)
        XCTAssertEqual(try FrameDecoder().feed(try FrameCodec.encode(hello)), [hello])
    }

    func testHelloCarriesFCMTokenAndVersion() throws {
        let hello = ControlMessage.hello(deviceID: "d1", deviceName: "Pixel", pairingCode: "8421",
                                         secret: nil, fcmToken: "FCMTOK", protocolVersion: kRemoteProtocolVersion)
        XCTAssertEqual(try FrameDecoder().feed(try FrameCodec.encode(hello)), [hello])
    }

    func testRefreshFCMTokenRoundTrip() throws {
        let msg = ControlMessage.refreshFCMToken(token: "NEWTOK")
        XCTAssertEqual(try FrameDecoder().feed(try FrameCodec.encode(msg)), [msg])
    }

    func testPairedDeviceCarriesFCMToken() throws {
        let dev = PairedDevice(deviceID: "d1", secret: "s", name: "Pixel", fcmToken: "FCMTOK")
        let back = try JSONDecoder().decode(PairedDevice.self, from: JSONEncoder().encode(dev))
        XCTAssertEqual(back, dev)
        XCTAssertEqual(back.fcmToken, "FCMTOK")
    }

    // Pairing-decision coverage lives in RemotePairingTests (identity-gated, code-free).

    func testDataHelloCarriesSize() throws {
        let m = DataMessage.dataHello(sessionNonce: "n1", paneID: "p1", cols: 40, rows: 30)
        let enc = try DataFrameCodec.encode(m)
        let dec = DataFrameDecoder()
        XCTAssertEqual(try dec.feed(enc), [m])
        // wire shape
        let json = String(data: enc.suffix(from: enc.startIndex + 4), encoding: .utf8)!
        XCTAssertTrue(json.contains("\"dataHello\""))
        XCTAssertTrue(json.contains("\"cols\":40")); XCTAssertTrue(json.contains("\"rows\":30"))
    }

    func testControlResizeRoundTrips() throws {
        let m = ControlMessage.resize(paneID: "p1", cols: 41, rows: 22)
        XCTAssertEqual(try FrameDecoder().feed(try FrameCodec.encode(m)), [m])
    }

    func testPromptRoundTrips() throws {
        let q = [PromptQuestion(prompt: "Pick one", header: "H", options: ["A", "B"], multiSelect: false)]
        let m = ControlMessage.prompt(paneID: "p1", kind: "askUserQuestion", detail: nil, questions: q)
        XCTAssertEqual(try FrameDecoder().feed(try FrameCodec.encode(m)), [m])
    }

    func testPromptPermissionOmitsQuestions() throws {
        let m = ControlMessage.prompt(paneID: "p1", kind: "permission", detail: "Bash", questions: nil)
        let json = String(data: try JSONEncoder().encode(m), encoding: .utf8)!
        XCTAssertFalse(json.contains("questions"))
        XCTAssertTrue(json.contains("\"kind\":\"permission\""))
    }

    func testHelperFrameInputRoundTrips() {
        let f = HelperFrame.input([0x1b, 0x5b, 0x41])   // ESC [ A
        let out = HelperFrameCodec.encode(f)
        // [u32 len=4][type 0x00][3 payload bytes]
        XCTAssertEqual(Array(out.prefix(4)), [0,0,0,4])
        XCTAssertEqual(out[out.startIndex + 4], 0x00)
        XCTAssertEqual(HelperFrameDecoder().feed(out), [f])
    }

    func testHelperFrameResizeEncodesColsRows() {
        let out = HelperFrameCodec.encode(.resize(cols: 40, rows: 30))
        XCTAssertEqual(Array(out.prefix(4)), [0,0,0,5])            // 1 type + 4 payload
        XCTAssertEqual(out[out.startIndex + 4], 0x01)
        XCTAssertEqual(HelperFrameDecoder().feed(out), [.resize(cols: 40, rows: 30)])
    }

    func testHelperFrameDecoderReassemblesSplitFrames() {
        let a = HelperFrameCodec.encode(.input([0x61]))
        let b = HelperFrameCodec.encode(.resize(cols: 10, rows: 5))
        let dec = HelperFrameDecoder()
        XCTAssertEqual(dec.feed(a.prefix(3)), [])
        XCTAssertEqual(dec.feed(a.suffix(from: a.startIndex + 3) + b.prefix(2)), [.input([0x61])])
        XCTAssertEqual(dec.feed(b.suffix(from: b.startIndex + 2)), [.resize(cols: 10, rows: 5)])
    }

    func testWorkspaceTreeRoundTrips() throws {
        let tree = WorkspaceTree(
            workspaceID: "w1", name: "ACTIVE WORK",
            tabs: [RemoteTab(
                tabID: "t1",
                root: .split(axis: "row", ratio: 0.6,
                    first: .leaf(RemotePane(paneID: "p1", title: "zsh", cwd: "/x", state: "working", reason: nil)),
                    second: .leaf(RemotePane(paneID: "p2", title: "claude", cwd: "/y", state: "blocked", reason: "answer needed"))),
                focusedPaneID: "p1", zoomedPaneID: nil)],
            selectedTabID: "t1")
        let data = try FrameCodec.encode(.workspaceTree(tree))
        let decoded = try FrameDecoder().feed(data)
        XCTAssertEqual(decoded, [.workspaceTree(tree)])
    }

    func testStructuralCommandsRoundTrip() throws {
        let msgs: [ControlMessage] = [
            .cmdNewTab(workspaceID: "w1"),
            .cmdSplit(paneID: "p1", axis: "column"),
            .cmdClosePane(paneID: "p2"),
            .cmdFocusPane(paneID: "p1"),
            .cmdZoom(paneID: "p1"),
            .cmdRenamePane(paneID: "p1", title: "build"),
            .cmdReorderTab(workspaceID: "w1", fromIndex: 0, toIndex: 2),
            .cmdSwitchTab(workspaceID: "w1", tabID: "t1"),
            .workspaceList(ids: ["w1", "w2"]),
            .workspaceRemoved(workspaceID: "w2"),
        ]
        let dec = FrameDecoder()
        var out: [ControlMessage] = []
        for m in msgs { out += try dec.feed(try FrameCodec.encode(m)) }
        XCTAssertEqual(out, msgs)
    }

    func testBuildRemoteNodeMirrorsSplitTree() {
        let p1 = Pane(); let p2 = Pane()
        let tree: SplitNode = .split(axis: .row, ratio: 0.5, first: .leaf(p1), second: .leaf(p2))
        let node = buildRemoteNode(tree) { p in
            RemotePane(paneID: p.paneID, title: "T-\(p.paneID.prefix(4))", cwd: nil, state: "working", reason: nil)
        }
        guard case let .split(axis, ratio, first, second) = node else { return XCTFail("expected split") }
        XCTAssertEqual(axis, "row"); XCTAssertEqual(ratio, 0.5)
        guard case let .leaf(lp) = first else { return XCTFail() }
        XCTAssertEqual(lp.paneID, p1.paneID); XCTAssertEqual(lp.state, "working")
        guard case .leaf = second else { return XCTFail() }
    }

    func testTailscaleCGNATDetection() {
        XCTAssertTrue(isTailscaleCGNAT("100.101.102.103"))
        XCTAssertTrue(isTailscaleCGNAT("100.64.0.1"))
        XCTAssertFalse(isTailscaleCGNAT("192.168.1.5"))
        XCTAssertFalse(isTailscaleCGNAT("100.200.0.1"))   // .200 > 127, outside /10
        XCTAssertEqual(tailscaleIPv4(from: [("en0","192.168.1.5"), ("utun3","100.101.102.103")]),
                       "100.101.102.103")
    }
}
