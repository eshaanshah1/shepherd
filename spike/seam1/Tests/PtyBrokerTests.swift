import XCTest

final class PtyRingTests: XCTestCase {
    func testAppendUnderCapKeepsEverythingInOrder() {
        var r = PtyRing(cap: 16)
        r.append(Array("abc".utf8)); r.append(Array("def".utf8))
        XCTAssertEqual(r.snapshot(), Array("abcdef".utf8))
        XCTAssertEqual(r.count, 6)
    }

    func testAppendOverCapEvictsOldest() {
        var r = PtyRing(cap: 4)
        r.append(Array("abcdef".utf8))          // only last 4 survive
        XCTAssertEqual(r.snapshot(), Array("cdef".utf8))
        XCTAssertEqual(r.count, 4)
    }

    func testAppendAcrossBoundaryEvictsAcrossCalls() {
        var r = PtyRing(cap: 4)
        r.append(Array("ab".utf8)); r.append(Array("cde".utf8))  // "abcde" → last 4 = "bcde"
        XCTAssertEqual(r.snapshot(), Array("bcde".utf8))
    }

    func testSingleAppendLargerThanCapKeepsTail() {
        var r = PtyRing(cap: 3)
        r.append(Array("abcdefgh".utf8))
        XCTAssertEqual(r.snapshot(), Array("fgh".utf8))
    }
}
