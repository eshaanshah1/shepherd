import XCTest

final class RemoteWiringTests: XCTestCase {
    func testNotServingMeansNoCommandOverride() {
        XCTAssertNil(remoteSurfaceCommand(serving: false, helperPath: "/x/shepherdd"))
    }

    func testServingRoutesThroughHelperPtySubcommand() {
        let cmd = remoteSurfaceCommand(serving: true, helperPath: "/x/Contents/MacOS/shepherdd")
        XCTAssertEqual(cmd, "/x/Contents/MacOS/shepherdd pty")
    }
}
