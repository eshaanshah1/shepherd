import XCTest
@testable import Shepherd

final class RemotePairingTests: XCTestCase {
    private let known = [PairedDevice(deviceID: "known", secret: "S", name: "Old Mac", fcmToken: nil)]

    func testKnownDeviceGoodSecretAccepts() {
        let d = pairingDecision(deviceID: "known", secret: "S", known: known, newSecret: "NEW",
                                peer: VerifiedPeer(userID: "u1", name: "Old Mac"), selfUserID: "u1")
        XCTAssertEqual(d, .accept(persistSecret: nil))
    }

    func testKnownDeviceBadSecretRejects() {
        let d = pairingDecision(deviceID: "known", secret: "WRONG", known: known, newSecret: "NEW",
                                peer: VerifiedPeer(userID: "u1", name: "Old Mac"), selfUserID: "u1")
        XCTAssertEqual(d, .reject(reason: "bad secret"))
    }

    func testUnknownVerifiedSameUserNeedsApprovalWithVerifiedName() {
        let d = pairingDecision(deviceID: "new", secret: nil, known: known, newSecret: "NEW",
                                peer: VerifiedPeer(userID: "u1", name: "Verified Mini"), selfUserID: "u1")
        // Name comes from the verified peer, NOT any self-reported hello string.
        XCTAssertEqual(d, .needsApproval(deviceID: "new", name: "Verified Mini", proposedSecret: "NEW"))
    }

    func testUnknownReusesClientSecretWhenProvided() {
        let d = pairingDecision(deviceID: "new", secret: "CLIENTSEC", known: known, newSecret: "NEW",
                                peer: VerifiedPeer(userID: "u1", name: "Mini"), selfUserID: "u1")
        XCTAssertEqual(d, .needsApproval(deviceID: "new", name: "Mini", proposedSecret: "CLIENTSEC"))
    }

    func testUnknownDifferentUserRejected() {
        let d = pairingDecision(deviceID: "new", secret: nil, known: known, newSecret: "NEW",
                                peer: VerifiedPeer(userID: "OTHER", name: "Colleague Mac"), selfUserID: "u1")
        XCTAssertEqual(d, .reject(reason: "unverified peer"))
    }

    func testUnknownUnresolvedIPRejected() {
        let d = pairingDecision(deviceID: "new", secret: nil, known: known, newSecret: "NEW",
                                peer: nil, selfUserID: "u1")
        XCTAssertEqual(d, .reject(reason: "unverified peer"))
    }

    func testUnknownRejectedWhenSelfUserIDMissing() {
        let d = pairingDecision(deviceID: "new", secret: nil, known: known, newSecret: "NEW",
                                peer: VerifiedPeer(userID: "u1", name: "Mini"), selfUserID: nil)
        XCTAssertEqual(d, .reject(reason: "unverified peer"))
    }
}
