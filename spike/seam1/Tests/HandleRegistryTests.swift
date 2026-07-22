import XCTest
@testable import Shepherd

final class HandleRegistryTests: XCTestCase {
    func testMintsSequentialPerKind() {
        let r = HandleRegistry()
        XCTAssertEqual(r.handle(for: "uuid-a", kind: .pane), "p1")
        XCTAssertEqual(r.handle(for: "uuid-b", kind: .pane), "p2")
        XCTAssertEqual(r.handle(for: "ws-a", kind: .workspace), "ws1")
        XCTAssertEqual(r.handle(for: "t-a", kind: .tab), "t1")
    }

    func testHandleIsStableForSameUUID() {
        let r = HandleRegistry()
        let h = r.handle(for: "uuid-a", kind: .pane)
        XCTAssertEqual(r.handle(for: "uuid-a", kind: .pane), h)
    }

    func testReverseResolves() {
        let r = HandleRegistry()
        let h = r.handle(for: "uuid-a", kind: .pane)
        XCTAssertEqual(r.uuid(for: h), "uuid-a")
        XCTAssertNil(r.uuid(for: "p999"))
    }

    func testPruneDropsDeadAndNeverReusesNumber() {
        let r = HandleRegistry()
        XCTAssertEqual(r.handle(for: "uuid-a", kind: .pane), "p1")
        r.prune(live: [])                       // uuid-a is gone
        XCTAssertNil(r.uuid(for: "p1"))
        XCTAssertEqual(r.handle(for: "uuid-b", kind: .pane), "p2")   // not p1 again
    }
}
