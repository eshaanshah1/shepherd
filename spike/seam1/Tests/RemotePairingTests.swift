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

    func testLogLabelNamesOutcomeWithoutLeakingSecret() {
        XCTAssertEqual(PairingDecision.accept(persistSecret: nil).logLabel, "accept(known)")
        XCTAssertEqual(PairingDecision.accept(persistSecret: "S3CR3T").logLabel, "accept(new)")
        XCTAssertEqual(PairingDecision.reject(reason: "bad secret").logLabel, "reject(bad secret)")
        XCTAssertEqual(
            PairingDecision.needsApproval(deviceID: "d", name: "Mac", proposedSecret: "S3CR3T",
                                          confirm: .trustedOrigin).logLabel,
            "needsApproval")
        for d in [PairingDecision.accept(persistSecret: "S3CR3T"),
                  .needsApproval(deviceID: "d", name: "Mac", proposedSecret: "S3CR3T",
                                 confirm: .compareSAS)] {
            XCTAssertFalse(d.logLabel.contains("S3CR3T"))
        }
    }

    func testUnknownVerifiedSameUserNeedsApprovalWithVerifiedName() {
        let d = pairingDecision(deviceID: "new", secret: nil, known: known, newSecret: "NEW",
                                peer: VerifiedPeer(userID: "u1", name: "Verified Mini"), selfUserID: "u1")
        // Name comes from the verified peer, NOT any self-reported hello string.
        XCTAssertEqual(d, .needsApproval(deviceID: "new", name: "Verified Mini", proposedSecret: "NEW",
                                         confirm: .trustedOrigin))
    }

    func testUnknownReusesClientSecretWhenProvided() {
        let d = pairingDecision(deviceID: "new", secret: "CLIENTSEC", known: known, newSecret: "NEW",
                                peer: VerifiedPeer(userID: "u1", name: "Mini"), selfUserID: "u1")
        XCTAssertEqual(d, .needsApproval(deviceID: "new", name: "Mini", proposedSecret: "CLIENTSEC",
                                         confirm: .trustedOrigin))
    }

    // MARK: LAN origin

    func testKnownDeviceAdmittedBySecretOverLAN() {
        let d = pairingDecision(deviceID: "known", secret: "S", known: known, newSecret: "NEW",
                                peer: nil, selfUserID: "u1", origin: .lan)
        XCTAssertEqual(d, .accept(persistSecret: nil), "a paired device needs no code on reconnect")
    }

    func testNewLANDeviceWithTheLiveCodeNeedsASASCompare() {
        let d = pairingDecision(deviceID: "new", secret: nil, known: known, newSecret: "NEW",
                                peer: nil, selfUserID: "u1", origin: .lan, deviceName: "Air",
                                presentedCode: "123456", activeCode: "123456", codeAttemptsLeft: 3)
        XCTAssertEqual(d, .needsApproval(deviceID: "new", name: "Air", proposedSecret: "NEW",
                                         confirm: .compareSAS))
    }

    func testNewLANDeviceWithoutAGoodCodeIsRejected() {
        func decide(presented: String?, active: String?, attempts: Int) -> PairingDecision {
            pairingDecision(deviceID: "new", secret: nil, known: known, newSecret: "NEW",
                            peer: nil, selfUserID: "u1", origin: .lan, deviceName: "Air",
                            presentedCode: presented, activeCode: active, codeAttemptsLeft: attempts)
        }
        XCTAssertEqual(decide(presented: nil, active: "123456", attempts: 3), .reject(reason: "bad code"))
        XCTAssertEqual(decide(presented: "000000", active: "123456", attempts: 3), .reject(reason: "bad code"))
        XCTAssertEqual(decide(presented: "123456", active: nil, attempts: 3), .reject(reason: "bad code"),
                       "no code showing on the host means no pairing is open")
        XCTAssertEqual(decide(presented: "123456", active: "123456", attempts: 0), .reject(reason: "bad code"),
                       "attempts exhausted")
    }

    /// A verified tailnet peer must not be a way around the LAN code: origin decides, and the
    /// LAN branch never consults `peer`.
    func testLANOriginIgnoresAVerifiedPeer() {
        let d = pairingDecision(deviceID: "new", secret: nil, known: known, newSecret: "NEW",
                                peer: VerifiedPeer(userID: "u1", name: "Mini"), selfUserID: "u1",
                                origin: .lan, deviceName: "Air",
                                presentedCode: nil, activeCode: "123456", codeAttemptsLeft: 3)
        XCTAssertEqual(d, .reject(reason: "bad code"))
    }

    func testLANFallsBackToTheDeviceIDWhenNoNameIsGiven() {
        let d = pairingDecision(deviceID: "new", secret: nil, known: known, newSecret: "NEW",
                                peer: nil, selfUserID: nil, origin: .lan, deviceName: nil,
                                presentedCode: "123456", activeCode: "123456", codeAttemptsLeft: 3)
        XCTAssertEqual(d, .needsApproval(deviceID: "new", name: "new", proposedSecret: "NEW",
                                         confirm: .compareSAS))
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
