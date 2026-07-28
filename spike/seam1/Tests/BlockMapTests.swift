import XCTest
@testable import Shepherd

final class BlockMapTests: XCTestCase {
    private let fileA = SourceID("A.swift")
    private let fileB = SourceID("B.swift")

    private func header(_ id: String, _ src: SourceID, at line: Int) -> Block {
        Block(id: id, kind: .fileHeader(src), beforeStitchedLine: line, height: 28)
    }

    func testInsertKeepsBlocksSortedByPosition() {
        var map = BlockMap()
        map.insert(header("h2", fileB, at: 10))
        map.insert(header("h1", fileA, at: 0))
        map.insert(header("h3", fileB, at: 5))
        XCTAssertEqual(map.blocks.map(\.id), ["h1", "h3", "h2"])
    }

    func testBlocksAtAPositionAreReturnedInInsertionOrder() {
        var map = BlockMap()
        map.insert(header("first", fileA, at: 4))
        map.insert(Block(id: "second", kind: .spacer(rows: 2),
                         beforeStitchedLine: 4, height: 30))
        XCTAssertEqual(map.blocks(beforeStitchedLine: 4).map(\.id), ["first", "second"])
    }

    func testBlocksAtAPositionWithNoneReturnsEmpty() {
        var map = BlockMap()
        map.insert(header("h1", fileA, at: 0))
        XCTAssertTrue(map.blocks(beforeStitchedLine: 7).isEmpty)
    }

    func testTotalHeightSumsOnlyBlocksStrictlyAbove() {
        var map = BlockMap()
        map.insert(header("h1", fileA, at: 0))                                  // 28
        map.insert(Block(id: "d1", kind: .deletedLines(source: fileA, lines: ["a", "b"],
                                                       startingOldLine: 40),
                         beforeStitchedLine: 3, height: 44))
        map.insert(header("h2", fileB, at: 9))                                  // 28
        XCTAssertEqual(map.totalHeight(aboveStitchedLine: 0), 0, accuracy: 0.001)
        XCTAssertEqual(map.totalHeight(aboveStitchedLine: 1), 28, accuracy: 0.001)
        XCTAssertEqual(map.totalHeight(aboveStitchedLine: 4), 72, accuracy: 0.001)
        XCTAssertEqual(map.totalHeight(aboveStitchedLine: 99), 100, accuracy: 0.001)
    }

    func testRemoveAllDropsOnlyThatFilesBlocks() {
        var map = BlockMap()
        map.insert(header("h1", fileA, at: 0))
        map.insert(Block(id: "md", kind: .renderedMarkdown(fileA),
                         beforeStitchedLine: 1, height: 200))
        map.insert(header("h2", fileB, at: 9))
        map.removeAll(for: fileA)
        XCTAssertEqual(map.blocks.map(\.id), ["h2"])
    }

    func testRemoveAllIgnoresSpacersWhichBelongToNoFile() {
        var map = BlockMap()
        map.insert(Block(id: "sp", kind: .spacer(rows: 1),
                         beforeStitchedLine: 2, height: 15))
        map.removeAll(for: fileA)
        XCTAssertEqual(map.blocks.map(\.id), ["sp"], "a spacer has no owning file")
    }

    func testRemoveAllCoversEveryFileOwningBlockKind() {
        var map = BlockMap()
        map.insert(header("h", fileA, at: 0))
        map.insert(Block(id: "d", kind: .deletedLines(source: fileA, lines: ["x"],
                                                      startingOldLine: 1),
                         beforeStitchedLine: 1, height: 22))
        map.insert(Block(id: "c", kind: .conflictControls(source: fileA, conflictID: "a#1",
                                                          index: 1, total: 1,
                                                          resolution: nil, kind: .content,
                                                          oursLabel: "main",
                                                          theirsLabel: "feature"),
                         beforeStitchedLine: 2, height: 30))
        map.insert(Block(id: "s", kind: .conflictMarker(source: fileA, conflictID: "a#1",
                                                        label: "feature", side: .theirs,
                                                        isEnd: true),
                         beforeStitchedLine: 3, height: 22))
        map.insert(Block(id: "m", kind: .renderedMarkdown(fileA),
                         beforeStitchedLine: 4, height: 90))
        map.removeAll(for: fileA)
        XCTAssertTrue(map.blocks.isEmpty, "every file-owning kind must report its source")
    }

    func testShiftMovesBlocksAtOrBelowTheEditPoint() {
        var map = BlockMap()
        map.insert(header("above", fileA, at: 2))
        map.insert(header("at", fileA, at: 5))
        map.insert(header("below", fileB, at: 8))
        map.shift(fromStitchedLine: 5, by: 3)
        XCTAssertEqual(map.blocks.first { $0.id == "above" }?.beforeStitchedLine, 2)
        XCTAssertEqual(map.blocks.first { $0.id == "at" }?.beforeStitchedLine, 8)
        XCTAssertEqual(map.blocks.first { $0.id == "below" }?.beforeStitchedLine, 11)
    }

    func testShiftCannotDriveAPositionNegative() {
        var map = BlockMap()
        map.insert(header("h1", fileA, at: 2))
        map.shift(fromStitchedLine: 0, by: -10)
        XCTAssertEqual(map.blocks[0].beforeStitchedLine, 0)
    }

    func testShiftKeepsTheArraySortedAndStable() {
        var map = BlockMap()
        map.insert(header("h1", fileA, at: 1))
        map.insert(header("h2", fileB, at: 4))
        map.shift(fromStitchedLine: 4, by: -3)
        XCTAssertEqual(map.blocks.map(\.beforeStitchedLine), [1, 1])
        XCTAssertEqual(map.blocks.map(\.id), ["h1", "h2"], "stable under equal positions")
    }

    func testAZeroShiftChangesNothing() {
        var map = BlockMap()
        map.insert(header("h1", fileA, at: 3))
        let before = map
        map.shift(fromStitchedLine: 0, by: 0)
        XCTAssertEqual(map, before)
    }

    // MARK: - The row index

    /// The index is derived state rebuilt on mutation, so the cheap thing to assert is that
    /// it never disagrees with the linear answer it replaced. Every mutation path is
    /// exercised, because a missed `reindex()` is invisible until a band draws in the wrong
    /// place.
    private func assertIndexAgreesWithLinearScan(_ map: BlockMap,
                                                 _ message: String,
                                                 file: StaticString = #filePath,
                                                 line: UInt = #line) {
        let positions = Set(map.blocks.map(\.beforeStitchedLine))
        for probe in (positions.union([0, 1, 999]).map { $0 } + positions.map { $0 + 1 }) {
            XCTAssertEqual(map.blocks(beforeStitchedLine: probe).map(\.id),
                           map.blocks.filter { $0.beforeStitchedLine == probe }.map(\.id),
                           "\(message): blocks at \(probe)", file: file, line: line)
            XCTAssertEqual(map.height(beforeStitchedLine: probe),
                           map.blocks.filter { $0.beforeStitchedLine == probe }
                               .reduce(0) { $0 + $1.height },
                           accuracy: 0.001, "\(message): height at \(probe)",
                           file: file, line: line)
            XCTAssertEqual(map.totalHeight(aboveStitchedLine: probe),
                           map.blocks.reduce(0) {
                               $0 + ($1.beforeStitchedLine < probe ? $1.height : 0)
                           },
                           accuracy: 0.001, "\(message): total above \(probe)",
                           file: file, line: line)
        }
    }

    private func populated() -> BlockMap {
        BlockMap(blocks: [
            header("h1", fileA, at: 0),
            Block(id: "d1", kind: .deletedLines(source: fileA, lines: ["a"],
                                                startingOldLine: 1),
                  beforeStitchedLine: 3, height: 22),
            Block(id: "sp", kind: .spacer(rows: 1), beforeStitchedLine: 3, height: 15),
            header("h2", fileB, at: 9),
        ])
    }

    func testLookupsAgreeWithALinearScanAfterInit() {
        assertIndexAgreesWithLinearScan(populated(), "after init")
    }

    func testLookupsAgreeWithALinearScanAfterInsert() {
        var map = populated()
        map.insert(header("mid", fileB, at: 5))
        map.insert(header("first", fileA, at: 0))
        assertIndexAgreesWithLinearScan(map, "after insert")
    }

    func testLookupsAgreeWithALinearScanAfterRemoveAll() {
        var map = populated()
        map.removeAll(for: fileA)
        assertIndexAgreesWithLinearScan(map, "after removeAll")
    }

    func testLookupsAgreeWithALinearScanAfterShift() {
        var map = populated()
        map.shift(fromStitchedLine: 3, by: 4)
        assertIndexAgreesWithLinearScan(map, "after a positive shift")
        map.shift(fromStitchedLine: 0, by: -50)
        assertIndexAgreesWithLinearScan(map, "after a clamping negative shift")
    }

    func testLookupsOnAnEmptyMapAreSafe() {
        let map = BlockMap()
        XCTAssertTrue(map.blocks(beforeStitchedLine: 0).isEmpty)
        XCTAssertEqual(map.height(beforeStitchedLine: 0), 0, accuracy: 0.001)
        XCTAssertEqual(map.totalHeight(aboveStitchedLine: 42), 0, accuracy: 0.001)
    }

    func testSeveralBlocksAtOnePositionComeBackInOrder() {
        var map = BlockMap()
        map.insert(header("first", fileA, at: 4))
        map.insert(Block(id: "second", kind: .spacer(rows: 2),
                         beforeStitchedLine: 4, height: 30))
        map.insert(Block(id: "third", kind: .spacer(rows: 1),
                         beforeStitchedLine: 4, height: 10))
        XCTAssertEqual(map.blocks(beforeStitchedLine: 4).map(\.id),
                       ["first", "second", "third"])
        XCTAssertEqual(map.height(beforeStitchedLine: 4), 68, accuracy: 0.001)
    }

    func testInitSortsBlocksGivenOutOfOrder() {
        let map = BlockMap(blocks: [header("late", fileB, at: 9), header("early", fileA, at: 1)])
        XCTAssertEqual(map.blocks.map(\.id), ["early", "late"])
    }
}
