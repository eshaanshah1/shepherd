import XCTest
import Security

final class LANIdentityTests: XCTestCase {

    private func tempDir() -> String {
        let d = (NSTemporaryDirectory() as NSString).appendingPathComponent("lanid-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        return d
    }

    func testMintsOnceAndReloadsTheSameIdentity() throws {
        let dir = tempDir()
        guard let a = LANIdentity.loadOrMint(dir: dir) else { throw XCTSkip("openssl unavailable") }
        guard let b = LANIdentity.loadOrMint(dir: dir) else { return XCTFail("reload failed") }
        XCTAssertEqual(a.certHash, b.certHash, "a reload must not re-mint — every pin would break")
        XCTAssertEqual(a.certHash.count, 32)
    }

    func testP12IsOwnerOnly() throws {
        let dir = tempDir()
        guard LANIdentity.loadOrMint(dir: dir) != nil else { throw XCTSkip("openssl unavailable") }
        let mode = try FileManager.default
            .attributesOfItem(atPath: LANIdentity.p12Path(dir))[.posixPermissions] as? NSNumber
        XCTAssertEqual(mode?.int16Value, 0o600)
    }

    func testMintLeavesNoPrivateKeyLyingAround() throws {
        let dir = tempDir()
        guard LANIdentity.loadOrMint(dir: dir) != nil else { throw XCTSkip("openssl unavailable") }
        let left = try FileManager.default.contentsOfDirectory(atPath: dir)
        XCTAssertEqual(left.sorted(), ["lan-identity.p12"], "the PEM key must not survive minting")
    }

    func testResetMintsANewIdentity() throws {
        let dir = tempDir()
        guard let a = LANIdentity.loadOrMint(dir: dir) else { throw XCTSkip("openssl unavailable") }
        LANIdentity.reset(dir: dir)
        guard let b = LANIdentity.loadOrMint(dir: dir) else { return XCTFail("re-mint failed") }
        XCTAssertNotEqual(a.certHash, b.certHash)
    }

    /// Byte-pinned so the Kotlin implementation cannot drift into showing other digits for the
    /// same host. The Android `SasTest` asserts this exact vector.
    func testSASDigitsAreAPinnedFunctionOfTheHash() {
        let hash = Data([0x00, 0x01, 0x02, 0x03] + [UInt8](repeating: 0xff, count: 28))
        XCTAssertEqual(sasDigits(certHash: hash), String(format: "%06u", 0x00010203 % 1_000_000))
        XCTAssertEqual(sasDigits(certHash: hash).count, 6)
        let nudged = Data([0x00, 0x01, 0x02, 0x04] + [UInt8](repeating: 0xff, count: 28))
        XCTAssertNotEqual(sasDigits(certHash: hash), sasDigits(certHash: nudged))
    }

    func testSASChoicesPlaceTheRealCodeAtTheGivenIndex() {
        XCTAssertEqual(sasChoices(real: "111111", decoys: ["222222", "333333"], insertAt: 1),
                       ["222222", "111111", "333333"])
        let clamped = sasChoices(real: "111111", decoys: ["222222", "333333"], insertAt: 99)
        XCTAssertEqual(clamped.count, 3)
        XCTAssertTrue(clamped.contains("111111"))
    }

    func testCodeExpiresAfterFiveMinutes() {
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        let code = LANCode(digits: "123456", issued: t0, attemptsLeft: 3)
        XCTAssertTrue(code.isValid(now: t0.addingTimeInterval(299)))
        XCTAssertFalse(code.isValid(now: t0.addingTimeInterval(301)))
    }

    func testExhaustedCodeIsInvalidEvenWhenFresh() {
        let t0 = Date()
        var code = LANCode.fresh(now: t0, digits: "123456")
        XCTAssertEqual(code.attemptsLeft, 3)
        code.attemptsLeft = 0
        XCTAssertFalse(code.isValid(now: t0))
    }
}
