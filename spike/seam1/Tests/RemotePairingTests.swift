import XCTest
@testable import Shepherd

final class RemotePairingTests: XCTestCase {
    private let known = [PairedDevice(deviceID: "known", secret: "S", name: "Old Mac", fcmToken: nil)]

    func testKnownDeviceGoodSecretAccepts() {
        let d = pairingDecision(deviceID: "known", secret: "S", known: known, newSecret: "NEW",
                                peer: VerifiedPeer(userID: "u1", name: "Old Mac"), selfUserID: "u1")
        XCTAssertEqual(d, .accept(persistSecret: nil))
    }

    /// A wrong secret is rejected unless something else vouches for the peer. With a verified
    /// same-user tailnet peer it now earns a re-approval instead (see
    /// `testKnownDeviceWithBadSecretCanRepairOverTheTailnet`), because a permanent lockout that
    /// only a manual Forget can clear is a worse failure than asking the user once.
    func testKnownDeviceBadSecretRejectsWithoutAVerifiedPeer() {
        let d = pairingDecision(deviceID: "known", secret: "WRONG", known: known, newSecret: "NEW",
                                peer: nil, selfUserID: "u1")
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

    // MARK: one device, several routes

    /// The bug that broke every other pairing: a client mints its secret per host ADDRESS, so the
    /// same Mac presents different secrets over the tailnet and the LAN under ONE deviceID.
    /// Storing only the newest made each pairing evict the other.
    func testADeviceApprovedOnTwoRoutesIsAcceptedOnBoth() {
        let lanSecret = "LAN-SECRET", netSecret = "TAILNET-SECRET"
        var dev = PairedDevice(deviceID: "d1", secret: netSecret, name: "Air", fcmToken: nil)
        dev = dev.accepting(lanSecret)
        for (route, secret) in [(PeerOrigin.tailnet, netSecret), (.lan, lanSecret)] {
            XCTAssertEqual(pairingDecision(deviceID: "d1", secret: secret, known: [dev],
                                           newSecret: "NEW", peer: nil, selfUserID: "u1",
                                           origin: route),
                           .accept(persistSecret: nil), "\(route) route must still be accepted")
        }
    }

    func testAcceptingIsIdempotentAndBounded() {
        var dev = PairedDevice(deviceID: "d1", secret: "S0", name: "Air", fcmToken: nil)
        dev = dev.accepting("S0")
        XCTAssertNil(dev.altSecrets, "re-adding the primary secret must not grow the record")
        for i in 1...20 { dev = dev.accepting("S\(i)") }
        XCTAssertEqual(dev.altSecrets?.count, PairedDevice.maxAltSecrets)
        XCTAssertTrue(dev.allSecrets.contains("S20"), "the newest route must survive the cap")
        XCTAssertEqual(dev.secret, "S0", "the primary secret is never displaced")
    }

    /// A wrong secret from a verified same-user tailnet peer used to be a permanent lockout, with
    /// no equivalent of the LAN code path's escape.
    func testKnownDeviceWithBadSecretCanRepairOverTheTailnet() {
        let dev = PairedDevice(deviceID: "d1", secret: "RIGHT", name: "Air", fcmToken: nil)
        let d = pairingDecision(deviceID: "d1", secret: "WRONG", known: [dev], newSecret: "NEW",
                                peer: VerifiedPeer(userID: "u1", name: "Air"), selfUserID: "u1")
        XCTAssertEqual(d, .needsApproval(deviceID: "d1", name: "Air", proposedSecret: "WRONG",
                                         confirm: .trustedOrigin))
    }

    /// …but only for a peer that verifies. An unverified one stays rejected.
    func testUnverifiedPeerWithBadSecretIsStillRejected() {
        let dev = PairedDevice(deviceID: "d1", secret: "RIGHT", name: "Air", fcmToken: nil)
        XCTAssertEqual(pairingDecision(deviceID: "d1", secret: "WRONG", known: [dev],
                                       newSecret: "NEW", peer: nil, selfUserID: "u1"),
                       .reject(reason: "bad secret"))
        XCTAssertEqual(pairingDecision(deviceID: "d1", secret: "WRONG", known: [dev],
                                       newSecret: "NEW",
                                       peer: VerifiedPeer(userID: "OTHER", name: "Nope"),
                                       selfUserID: "u1"),
                       .reject(reason: "bad secret"))
    }

    /// A known LAN device with a stale secret and no live code must not be admitted.
    func testKnownLANDeviceWithBadSecretAndNoCodeIsRejected() {
        let dev = PairedDevice(deviceID: "d1", secret: "RIGHT", name: "Air", fcmToken: nil)
        XCTAssertEqual(pairingDecision(deviceID: "d1", secret: "WRONG", known: [dev],
                                       newSecret: "NEW", peer: nil, selfUserID: "u1",
                                       origin: .lan, deviceName: "Air",
                                       presentedCode: nil, activeCode: nil, codeAttemptsLeft: 0),
                       .reject(reason: "bad secret"))
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
