import XCTest
@testable import Shepherd

final class CodeSurfaceStateTests: XCTestCase {
    func testEditingFactorySetsRootAndMode() {
        let s = CodeSurfaceState.editing(root: "/repo", pane: "p1")
        XCTAssertEqual(s.mode, .edit)
        XCTAssertEqual(s.rootPath, "/repo")
        XCTAssertEqual(s.targetPaneID, "p1")
        XCTAssertTrue(s.openFiles.isEmpty)
        XCTAssertNil(s.activeFile)
    }

    func testOpenAddsTabAndActivates() {
        var s = CodeSurfaceState.editing(root: "/repo", pane: nil)
        s.open("/repo/a.swift")
        s.open("/repo/b.swift")
        XCTAssertEqual(s.openFiles, ["/repo/a.swift", "/repo/b.swift"])
        XCTAssertEqual(s.activeFile, "/repo/b.swift")
    }

    func testOpenExistingFileJustActivates() {
        var s = CodeSurfaceState.editing(root: "/repo", pane: nil)
        s.open("/repo/a.swift")
        s.open("/repo/b.swift")
        s.open("/repo/a.swift")
        XCTAssertEqual(s.openFiles, ["/repo/a.swift", "/repo/b.swift"])
        XCTAssertEqual(s.activeFile, "/repo/a.swift")
    }

    func testCloseActivatesNeighbor() {
        var s = CodeSurfaceState.editing(root: "/repo", pane: nil)
        ["a", "b", "c"].forEach { s.open("/repo/\($0)") }
        s.open("/repo/b")            // active = b (index 1)
        s.close("/repo/b")
        XCTAssertEqual(s.openFiles, ["/repo/a", "/repo/c"])
        XCTAssertEqual(s.activeFile, "/repo/c")   // neighbor at same index
    }

    func testCloseLastLeavesNoActive() {
        var s = CodeSurfaceState.editing(root: "/repo", pane: nil)
        s.open("/repo/only")
        s.close("/repo/only")
        XCTAssertTrue(s.openFiles.isEmpty)
        XCTAssertNil(s.activeFile)
    }

    func testDirtyTracking() {
        var s = CodeSurfaceState.editing(root: "/repo", pane: nil)
        s.open("/repo/a")
        s.markDirty("/repo/a")
        XCTAssertTrue(s.isDirty("/repo/a"))
        s.clearDirty("/repo/a")
        XCTAssertFalse(s.isDirty("/repo/a"))
    }

    func testCloseClearsDirty() {
        var s = CodeSurfaceState.editing(root: "/repo", pane: nil)
        s.open("/repo/a")
        s.markDirty("/repo/a")
        s.close("/repo/a")
        XCTAssertFalse(s.isDirty("/repo/a"))
    }

    func testDisplayName() {
        let s = CodeSurfaceState.editing(root: nil, pane: nil)
        XCTAssertEqual(s.displayName("/repo/src/main.swift"), "main.swift")
    }
}
