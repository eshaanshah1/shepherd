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
}
