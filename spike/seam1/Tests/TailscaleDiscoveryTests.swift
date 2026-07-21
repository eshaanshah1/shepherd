import XCTest
@testable import Shepherd

final class TailscaleDiscoveryTests: XCTestCase {
    // Trimmed shape of `tailscale status --json`: Self + two peers (one same-user, one other-user).
    private let json = Data("""
    {
      "Self": { "UserID": 1, "HostName": "my-mac", "DNSName": "my-mac.tail.ts.net.",
                "OS": "macOS", "Online": true, "TailscaleIPs": ["100.78.141.27"] },
      "User": {
        "1": { "ID": 1, "LoginName": "me@example.com", "DisplayName": "Me" },
        "9": { "ID": 9, "LoginName": "co@corp.com", "DisplayName": "Coworker" }
      },
      "Peer": {
        "keyA": { "UserID": 1, "HostName": "mac-mini", "DNSName": "mac-mini.tail.ts.net.",
                  "OS": "macOS", "Online": true, "TailscaleIPs": ["100.115.91.30", "fd7a::1"] },
        "keyB": { "UserID": 9, "HostName": "colleague", "DNSName": "colleague.tail.ts.net.",
                  "OS": "linux", "Online": true, "TailscaleIPs": ["100.9.9.9"] },
        "keyC": { "UserID": 1, "HostName": "phone", "DNSName": "phone.tail.ts.net.",
                  "OS": "android", "Online": false, "TailscaleIPs": ["100.121.36.111"] }
      }
    }
    """.utf8)

    func testParseSelfAndPeersExcludingSelf() {
        let s = TailscaleDiscovery.parse(json)!
        XCTAssertEqual(s.selfUserID, "1")
        XCTAssertEqual(s.peers.count, 3)                       // Self excluded, all 3 Peer entries kept
        XCTAssertEqual(s.userNames["1"], "Me")
        let mini = s.peers.first { $0.hostName == "mac-mini" }!
        XCTAssertEqual(mini.ipv4, "100.115.91.30")             // first 100.x, IPv6 skipped
        XCTAssertEqual(mini.dnsName, "mac-mini.tail.ts.net")   // trailing dot trimmed
    }

    func testMyPeersDropsOtherUser() {
        let s = TailscaleDiscovery.parse(json)!
        let mine = TailscaleDiscovery.myPeers(s)
        XCTAssertEqual(Set(mine.map(\.hostName)), ["mac-mini", "phone"])   // "colleague" (UserID 9) excluded
    }

    func testRowPairability() {
        let s = TailscaleDiscovery.parse(json)!
        let mini = s.peers.first { $0.hostName == "mac-mini" }!
        let phone = s.peers.first { $0.hostName == "phone" }!
        XCTAssertEqual(TailscaleDiscovery.row(for: mini, portOpen: true).pairability, .pairable)
        XCTAssertEqual(TailscaleDiscovery.row(for: mini, portOpen: false).pairability, .notServing)
        XCTAssertEqual(TailscaleDiscovery.row(for: phone, portOpen: false).pairability, .offline)  // offline wins
    }

    func testVerifiedPeerMatchesSameUserIP() {
        let s = TailscaleDiscovery.parse(json)!
        XCTAssertEqual(TailscaleDiscovery.verifiedPeer(forIP: "100.115.91.30", in: s),
                       VerifiedPeer(userID: "1", name: "mac-mini"))   // name = hostName
    }

    func testVerifiedPeerNilForUnknownIP() {
        let s = TailscaleDiscovery.parse(json)!
        XCTAssertNil(TailscaleDiscovery.verifiedPeer(forIP: "10.0.0.1", in: s))
    }

    func testResolveBinaryPrefersAppBundle() {
        // Only the Homebrew path "exists" → it wins (app bundle absent).
        let hb = TailscaleDiscovery.resolveBinary { $0 == "/opt/homebrew/bin/tailscale" }
        XCTAssertEqual(hb, "/opt/homebrew/bin/tailscale")
        // App bundle present → it wins over everything.
        let app = TailscaleDiscovery.resolveBinary { _ in true }
        XCTAssertEqual(app, "/Applications/Tailscale.app/Contents/MacOS/Tailscale")
        XCTAssertNil(TailscaleDiscovery.resolveBinary { _ in false })
    }
}
