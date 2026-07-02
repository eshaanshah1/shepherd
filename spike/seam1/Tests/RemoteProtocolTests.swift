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
        let b = try FrameCodec.encode(.snapshot(panes: [
            PaneInfo(paneID: "p1", title: "claude", workspace: "Home", state: "working", reason: nil)
        ]))
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

    func testPairingKnownDeviceGoodSecretAccepts() {
        let known = [PairedDevice(deviceID: "d1", secret: "s", name: "Pixel")]
        let d = pairingDecision(deviceID: "d1", name: "Pixel", code: nil, secret: "s",
                                known: known, currentCode: "8421", newSecret: "NEW")
        XCTAssertEqual(d, .accept(persistSecret: nil))
    }

    func testPairingKnownDeviceBadSecretRejects() {
        let known = [PairedDevice(deviceID: "d1", secret: "s", name: "Pixel")]
        let d = pairingDecision(deviceID: "d1", name: "Pixel", code: nil, secret: "WRONG",
                                known: known, currentCode: "8421", newSecret: "NEW")
        XCTAssertEqual(d, .reject(reason: "bad secret"))
    }

    func testPairingNewDeviceWithGoodCodeNeedsApproval() {
        let d = pairingDecision(deviceID: "d2", name: "Pixel", code: "8421", secret: nil,
                                known: [], currentCode: "8421", newSecret: "NEW")
        XCTAssertEqual(d, .needsApproval(deviceID: "d2", name: "Pixel", proposedSecret: "NEW"))
    }

    func testPairingNewDeviceWrongCodeRejects() {
        let d = pairingDecision(deviceID: "d2", name: "Pixel", code: "0000", secret: nil,
                                known: [], currentCode: "8421", newSecret: "NEW")
        XCTAssertEqual(d, .reject(reason: "pairing required"))
    }

    func testPairingNewDeviceWithCodeAndSuppliedSecretPersistsThatSecret() {
        // The phone owns its per-device secret and sends it in the first hello; the host
        // must persist the phone-supplied secret (not its own mint) so reconnect works.
        let d = pairingDecision(deviceID: "d2", name: "Pixel", code: "8421", secret: "phone-secret",
                                known: [], currentCode: "8421", newSecret: "NEW")
        XCTAssertEqual(d, .needsApproval(deviceID: "d2", name: "Pixel", proposedSecret: "phone-secret"))
    }

    func testBuildSnapshotMapsRows() {
        let s = buildSnapshot([("Home", "p1", "claude", "blocked", "approve Bash")])
        XCTAssertEqual(s, [PaneInfo(paneID: "p1", title: "claude", workspace: "Home", state: "blocked", reason: "approve Bash")])
    }

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

    func testTailscaleCGNATDetection() {
        XCTAssertTrue(isTailscaleCGNAT("100.101.102.103"))
        XCTAssertTrue(isTailscaleCGNAT("100.64.0.1"))
        XCTAssertFalse(isTailscaleCGNAT("192.168.1.5"))
        XCTAssertFalse(isTailscaleCGNAT("100.200.0.1"))   // .200 > 127, outside /10
        XCTAssertEqual(tailscaleIPv4(from: [("en0","192.168.1.5"), ("utun3","100.101.102.103")]),
                       "100.101.102.103")
    }
}
