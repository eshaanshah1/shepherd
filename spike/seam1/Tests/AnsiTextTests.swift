import XCTest
@testable import Shepherd

final class AnsiTextTests: XCTestCase {
    func testStripsCSIColor() {
        XCTAssertEqual(AnsiText.strip("\u{1B}[31mred\u{1B}[0m done"), "red done")
    }
    func testStripsOSCTitle() {
        XCTAssertEqual(AnsiText.strip("\u{1B}]0;my title\u{07}hello"), "hello")
    }
    func testTailLines() {
        XCTAssertEqual(AnsiText.tailLines("a\nb\nc\nd", 2), "c\nd")
        XCTAssertEqual(AnsiText.tailLines("only", 5), "only")
    }
}
