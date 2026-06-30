import XCTest

final class FCMMessageTests: XCTestCase {

    func testParseServiceAccount() throws {
        // private_key is a harmless placeholder — parseServiceAccount only extracts fields;
        // PEM validity is exercised by FCMPusher (not unit-tested), not here.
        let json = """
        {"client_email":"svc@proj.iam.gserviceaccount.com","private_key":"PEM_PLACEHOLDER","project_id":"proj-123","token_uri":"https://oauth2.googleapis.com/token"}
        """.data(using: .utf8)!
        let sa = try parseServiceAccount(json)
        XCTAssertEqual(sa.clientEmail, "svc@proj.iam.gserviceaccount.com")
        XCTAssertEqual(sa.projectID, "proj-123")
        XCTAssertEqual(sa.tokenURI, "https://oauth2.googleapis.com/token")
        XCTAssertEqual(sa.privateKeyPEM, "PEM_PLACEHOLDER")
    }

    func testBase64URLHasNoPaddingOrUnsafeChars() {
        let s = base64url(Data([0xfb, 0xff, 0xfe]))   // base64 would be "+//+"
        XCTAssertFalse(s.contains("+")); XCTAssertFalse(s.contains("/")); XCTAssertFalse(s.contains("="))
    }

    func testSigningInputIsTwoB64URLSegmentsWithExpectedClaims() throws {
        let input = buildSigningInput(clientEmail: "svc@x.com",
                                      tokenURI: "https://oauth2.googleapis.com/token",
                                      scope: "https://www.googleapis.com/auth/firebase.messaging",
                                      iat: 1000)
        let parts = input.split(separator: ".")
        XCTAssertEqual(parts.count, 2)
        // Decode the claims segment (add back base64 padding) and assert iat/exp/iss.
        var b64 = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        let claims = try JSONSerialization.jsonObject(with: Data(base64Encoded: b64)!) as! [String: Any]
        XCTAssertEqual(claims["iss"] as? String, "svc@x.com")
        XCTAssertEqual(claims["iat"] as? Int, 1000)
        XCTAssertEqual(claims["exp"] as? Int, 4600)   // iat + 3600
        XCTAssertEqual(claims["aud"] as? String, "https://oauth2.googleapis.com/token")
    }

    func testWakeMessageIsDataOnlyWithUrgency() {
        let m = buildWakeMessage(token: "TOK", paneID: "p1", state: "blocked", urgent: true)
        let msg = m["message"] as! [String: Any]
        XCTAssertEqual(msg["token"] as? String, "TOK")
        let data = msg["data"] as! [String: String]
        XCTAssertEqual(data, ["paneID": "p1", "state": "blocked", "urgent": "true"])
        XCTAssertEqual((msg["android"] as! [String: String])["priority"], "high")
        XCTAssertNil(msg["notification"])   // data-only: no notification block, ever
    }

    func testWakeMessageNonUrgentIsNormalPriority() {
        let m = buildWakeMessage(token: "TOK", paneID: "p1", state: "needsCheck", urgent: false)
        let msg = m["message"] as! [String: Any]
        XCTAssertEqual((msg["data"] as! [String: String])["urgent"], "false")
        XCTAssertEqual((msg["android"] as! [String: String])["priority"], "normal")
    }

    func testDedupSuppressesSameStateWithinWindow() {
        let now = Date(timeIntervalSince1970: 100)
        let last = ["p1": (state: "blocked", at: Date(timeIntervalSince1970: 96))]
        XCTAssertFalse(PushDecision.shouldPush(paneID: "p1", state: "blocked", lastPushed: last, now: now, window: 5))
    }

    func testDedupAllowsDifferentStateOrAfterWindow() {
        let now = Date(timeIntervalSince1970: 100)
        let last = ["p1": (state: "blocked", at: Date(timeIntervalSince1970: 96))]
        XCTAssertTrue(PushDecision.shouldPush(paneID: "p1", state: "error", lastPushed: last, now: now, window: 5))
        XCTAssertTrue(PushDecision.shouldPush(paneID: "p1", state: "blocked", lastPushed: last, now: now, window: 2))
        XCTAssertTrue(PushDecision.shouldPush(paneID: "p2", state: "blocked", lastPushed: last, now: now, window: 5))
    }
}
