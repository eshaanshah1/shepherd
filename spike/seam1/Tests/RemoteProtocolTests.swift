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

    func testBuildSnapshotMapsRows() {
        let s = buildSnapshot([("Home", "p1", "claude", "blocked", "approve Bash")])
        XCTAssertEqual(s, [PaneInfo(paneID: "p1", title: "claude", workspace: "Home", state: "blocked", reason: "approve Bash")])
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
