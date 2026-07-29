import XCTest
@testable import Shepherd

final class UpdateServiceTests: XCTestCase {
    private func releaseJSON(tag: String, hasZip: Bool = true) -> Data {
        var assets = #"{"name":"Shepherd.dmg","browser_download_url":"https://example.com/Shepherd.dmg"}"#
        if hasZip {
            assets += "," + #"{"name":"Shepherd.zip","browser_download_url":"https://example.com/Shepherd.zip"}"#
        }
        return """
        {"tag_name":"\(tag)","body":"## Notes\\nfixed things","assets":[\(assets)]}
        """.data(using: .utf8)!
    }

    func testParsesTagNotesAndZipAsset() {
        let r = UpdateService.parseRelease(releaseJSON(tag: "v0.5.0"))
        XCTAssertEqual(r?.tag, "v0.5.0")
        XCTAssertEqual(r?.notes.contains("fixed things"), true)
        XCTAssertEqual(r?.zipURL.absoluteString, "https://example.com/Shepherd.zip")
    }

    func testMissingZipAssetReturnsNil() {
        XCTAssertNil(UpdateService.parseRelease(releaseJSON(tag: "v0.5.0", hasZip: false)))
    }

    func testChoosesOnlyNewer() {
        XCTAssertNotNil(UpdateService.chooseUpdate(current: Version("0.4.0")!, releaseData: releaseJSON(tag: "v0.5.0")))
        XCTAssertNil(UpdateService.chooseUpdate(current: Version("0.5.0")!, releaseData: releaseJSON(tag: "v0.5.0")))
        XCTAssertNil(UpdateService.chooseUpdate(current: Version("0.6.0")!, releaseData: releaseJSON(tag: "v0.5.0")))
    }

    func testChosenUpdateCarriesFields() {
        let u = UpdateService.chooseUpdate(current: Version("0.4.0")!, releaseData: releaseJSON(tag: "v0.5.0"))
        XCTAssertEqual(u?.version, Version("0.5.0"))
        XCTAssertEqual(u?.tag, "v0.5.0")
        XCTAssertEqual(u?.zipURL.absoluteString, "https://example.com/Shepherd.zip")
    }

    // MARK: progress throttle

    func testPercentOnlyReportedOnChange() {
        let total: Int64 = 100_000_000
        XCTAssertEqual(UpdateService.reportablePercent(written: 1_000_000, total: total, last: -1), 1)
        XCTAssertNil(UpdateService.reportablePercent(written: 1_500_000, total: total, last: 1))
        XCTAssertEqual(UpdateService.reportablePercent(written: 2_000_000, total: total, last: 1), 2)
    }

    func testPercentNeverGoesBackwardsOrExceedsHundred() {
        XCTAssertNil(UpdateService.reportablePercent(written: 10, total: 100, last: 50))
        XCTAssertEqual(UpdateService.reportablePercent(written: 200, total: 100, last: 50), 100)
    }

    func testPercentNilWithoutKnownLength() {
        XCTAssertNil(UpdateService.reportablePercent(written: 500, total: -1, last: -1))
        XCTAssertNil(UpdateService.reportablePercent(written: 500, total: 0, last: -1))
    }

    /// A whole download must emit at most 101 callbacks, whatever the packet
    /// cadence — each one hops to the main actor.
    func testWholeDownloadEmitsAtMostOneHundredAndOneUpdates() {
        let total: Int64 = 120_000_000
        var last = -1, emitted = 0
        for chunk in Array(stride(from: Int64(0), through: total, by: 16 * 1024)) + [total] {
            if let pct = UpdateService.reportablePercent(written: chunk, total: total, last: last) {
                last = pct; emitted += 1
            }
        }
        XCTAssertEqual(emitted, 101)   // 0…100 inclusive, from ~7300 callbacks
        XCTAssertEqual(last, 100)
    }
}
