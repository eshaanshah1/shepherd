import XCTest
@testable import Shepherd

final class VersionTests: XCTestCase {
    func testParsesWithAndWithoutVPrefix() {
        XCTAssertEqual(Version("v0.4.0"), Version("0.4.0"))
        XCTAssertEqual(Version("1.2.3")?.description, "1.2.3")
    }

    func testInvalidReturnsNil() {
        XCTAssertNil(Version("garbage"))
        XCTAssertNil(Version(""))
    }

    func testOrdering() {
        XCTAssertLessThan(Version("0.4.0")!, Version("0.4.1")!)
        XCTAssertLessThan(Version("0.4.0")!, Version("0.5.0")!)
        XCTAssertLessThan(Version("0.9.0")!, Version("1.0.0")!)
    }

    func testPrereleaseSortsBelowRelease() {
        XCTAssertTrue(Version("0.0.0-dev")!.isPrerelease)
        XCTAssertLessThan(Version("1.2.3-dev")!, Version("1.2.3")!)
        XCTAssertLessThan(Version("0.0.0-dev")!, Version("0.1.0")!)
    }

    func testShouldSurface() {
        XCTAssertTrue(shouldSurface(available: Version("0.5.0")!, skipped: nil))
        XCTAssertFalse(shouldSurface(available: Version("0.5.0")!, skipped: Version("0.5.0")!))
        XCTAssertTrue(shouldSurface(available: Version("0.6.0")!, skipped: Version("0.5.0")!))
    }
}
