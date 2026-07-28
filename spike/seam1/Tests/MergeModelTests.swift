import XCTest
@testable import Shepherd

/// What a resolution puts in the buffer, and what finally reaches disk. `preview` and
/// `text` must never disagree about content — only about whether writing is allowed yet.
final class MergeModelTests: XCTestCase {

    private func file(_ regions: [MergeRegion], kind: ConflictKind = .content) -> MergeFile {
        MergeFile(path: "App.swift", kind: kind, regions: regions,
                  oursLabel: "master", theirsLabel: "feature")
    }

    private let conflicted: [MergeRegion] = [
        .stable(["top"]),
        .conflict(base: ["was"], ours: ["mine"], theirs: ["yours"]),
        .stable(["bottom"]),
    ]

    // MARK: - Conflict derivation

    func testConflictsAreNumberedFromOneAndIdentifiedByPath() {
        let subject = file([
            .conflict(base: [], ours: ["a"], theirs: ["b"]),
            .stable(["m"]),
            .conflict(base: [], ours: ["c"], theirs: ["d"]),
        ])
        XCTAssertEqual(subject.conflicts.map(\.id), ["App.swift#1", "App.swift#2"])
        XCTAssertEqual(subject.conflicts.map(\.index), [1, 2])
    }

    func testAFileWithNoConflictsHasNoDecisions() {
        XCTAssertTrue(file([.stable(["a"])]).conflicts.isEmpty)
    }

    // MARK: - Resolutions

    func testEachResolutionPicksTheRightLines() {
        let conflict = MergeConflict(id: "x", index: 1, base: ["was"],
                                     ours: ["mine"], theirs: ["yours"])
        XCTAssertEqual(MergeOutput.lines(for: conflict, resolution: .ours), ["mine"])
        XCTAssertEqual(MergeOutput.lines(for: conflict, resolution: .theirs), ["yours"])
        XCTAssertEqual(MergeOutput.lines(for: conflict, resolution: .bothOursFirst),
                       ["mine", "yours"])
        XCTAssertEqual(MergeOutput.lines(for: conflict, resolution: .bothTheirsFirst),
                       ["yours", "mine"])
    }

    /// Undecided shows both sides, the way git wrote them — deciding with half the
    /// information hidden behind a band was the thing that made this hard to read.
    func testAnUndecidedConflictDisplaysBothSides() {
        let conflict = MergeConflict(id: "x", index: 1, base: [],
                                     ours: ["mine"], theirs: ["yours"])
        let shown = MergeOutput.display(for: conflict, resolution: nil)
        XCTAssertEqual(shown.map(\.side), [.ours, .theirs])
        XCTAssertEqual(shown.flatMap(\.lines), ["mine", "yours"])
        XCTAssertTrue(MergeOutput.isSplit(resolution: nil))
    }

    func testADecidedConflictDisplaysOnlyWhatItWillWrite() {
        let conflict = MergeConflict(id: "x", index: 1, base: [],
                                     ours: ["mine"], theirs: ["yours"])
        XCTAssertEqual(MergeOutput.display(for: conflict, resolution: .ours).flatMap(\.lines),
                       ["mine"])
        XCTAssertEqual(MergeOutput.display(for: conflict, resolution: .theirs).flatMap(\.lines),
                       ["yours"])
        XCTAssertFalse(MergeOutput.isSplit(resolution: .ours))
        XCTAssertFalse(MergeOutput.isSplit(resolution: .theirs))
    }

    /// Keep-both stays split: both sides really are staying, and the markers are what say
    /// in which order.
    func testKeepingBothStaysSplitAndOrdersTheSides() {
        let conflict = MergeConflict(id: "x", index: 1, base: [],
                                     ours: ["mine"], theirs: ["yours"])
        XCTAssertEqual(
            MergeOutput.display(for: conflict, resolution: .bothOursFirst).map(\.side),
            [.ours, .theirs])
        XCTAssertEqual(
            MergeOutput.display(for: conflict, resolution: .bothTheirsFirst).map(\.side),
            [.theirs, .ours])
        XCTAssertTrue(MergeOutput.isSplit(resolution: .bothOursFirst))
        XCTAssertTrue(MergeOutput.isSplit(resolution: .bothTheirsFirst))
    }

    // MARK: - Word-diff pairing

    func testEqualLengthSidesPairLineForLine() {
        let conflict = MergeConflict(id: "x", index: 1, base: [],
                                     ours: ["let a = 1", "let b = 2"],
                                     theirs: ["let a = 9", "let b = 8"])
        XCTAssertEqual(MergeOutput.counterpart(in: conflict, side: .ours, index: 0),
                       "let a = 9")
        XCTAssertEqual(MergeOutput.counterpart(in: conflict, side: .theirs, index: 1),
                       "let b = 2")
    }

    /// The rule `HunkPairing` had to learn: pairing by ordinal across runs of different
    /// lengths lines up unrelated lines, and the word diff then brightens words that never
    /// changed. Better a flat tint than a confident lie.
    func testUnequalLengthSidesDoNotPair() {
        let conflict = MergeConflict(id: "x", index: 1, base: [],
                                     ours: ["one"], theirs: ["one", "two"])
        XCTAssertNil(MergeOutput.counterpart(in: conflict, side: .ours, index: 0))
        XCTAssertNil(MergeOutput.counterpart(in: conflict, side: .theirs, index: 0))
    }

    func testAnIndexPastTheEndPairsWithNothing() {
        let conflict = MergeConflict(id: "x", index: 1, base: [],
                                     ours: ["a"], theirs: ["b"])
        XCTAssertNil(MergeOutput.counterpart(in: conflict, side: .ours, index: 5))
    }

    func testAnEmptySideNeverPairs() {
        let conflict = MergeConflict(id: "x", index: 1, base: ["was"],
                                     ours: [], theirs: ["b"])
        XCTAssertNil(MergeOutput.counterpart(in: conflict, side: .theirs, index: 0))
    }

    // MARK: - preview vs text

    func testAnUndecidedRegionPreviewsBothSides() {
        XCTAssertEqual(MergeOutput.preview(file(conflicted), resolutions: [:]),
                       ["top", "mine", "yours", "bottom"])
    }

    func testAnUndecidedFileRefusesToProduceTextToWrite() {
        XCTAssertNil(MergeOutput.text(file(conflicted), resolutions: [:]))
    }

    func testADecidedFileWritesExactlyWhatItPreviewed() {
        let subject = file(conflicted)
        let resolutions = ["App.swift#1": Resolution.theirs]
        XCTAssertEqual(MergeOutput.preview(subject, resolutions: resolutions),
                       ["top", "yours", "bottom"])
        XCTAssertEqual(MergeOutput.text(subject, resolutions: resolutions),
                       "top\nyours\nbottom\n")
    }

    func testOnlyTheLastUndecidedRegionBlocksTheWrite() {
        let subject = file([
            .conflict(base: [], ours: ["a"], theirs: ["b"]),
            .conflict(base: [], ours: ["c"], theirs: ["d"]),
        ])
        XCTAssertNil(MergeOutput.text(subject, resolutions: ["App.swift#1": .ours]))
        XCTAssertEqual(MergeOutput.unresolved(subject,
                                              resolutions: ["App.swift#1": .ours]).map(\.id),
                       ["App.swift#2"])
        XCTAssertEqual(
            MergeOutput.text(subject, resolutions: ["App.swift#1": .ours,
                                                    "App.swift#2": .theirs]),
            "a\nd\n")
    }

    func testAFileWithNothingToDecideWritesItsStableText() {
        XCTAssertEqual(MergeOutput.text(file([.stable(["a", "b"])]), resolutions: [:]),
                       "a\nb\n")
    }

    // MARK: - Whole-file conflicts

    func testAWholeFileConflictCarriesOneDecisionAndNoRegions() {
        let subject = MergeFile.wholeFile(path: "logo.png", kind: .binary,
                                          oursLabel: "master", theirsLabel: "feature")
        XCTAssertTrue(subject.regions.isEmpty)
        XCTAssertEqual(subject.conflicts.map(\.id), ["logo.png#1"])
    }

    /// The important one: we must never synthesize content for a file we cannot read as
    /// lines, even once the user has decided. That decision goes to git.
    func testAWholeFileConflictNeverProducesTextToWrite() {
        let subject = MergeFile.wholeFile(path: "logo.png", kind: .binary,
                                          oursLabel: "master", theirsLabel: "feature")
        XCTAssertNil(MergeOutput.text(subject, resolutions: ["logo.png#1": .ours]))
    }

    func testWholeFileKindsAreExactlyTheOnesWithNoLineAnswer() {
        XCTAssertFalse(ConflictKind.content.isWholeFile)
        XCTAssertFalse(ConflictKind.addAdd.isWholeFile)
        XCTAssertTrue(ConflictKind.deletedByThem.isWholeFile)
        XCTAssertTrue(ConflictKind.deletedByUs.isWholeFile)
        XCTAssertTrue(ConflictKind.binary.isWholeFile)
        XCTAssertTrue(ConflictKind.unknown.isWholeFile)
    }

    // MARK: - WholeFileResolve

    func testKeepingTheSideThatDeletedTheFileRemovesIt() {
        XCTAssertEqual(
            WholeFileResolve.commands(kind: .deletedByThem, side: .theirs, path: "a.swift"),
            [["rm", "-f", "--", "a.swift"]])
        XCTAssertEqual(
            WholeFileResolve.commands(kind: .deletedByUs, side: .ours, path: "a.swift"),
            [["rm", "-f", "--", "a.swift"]])
    }

    func testKeepingTheSideThatModifiedTheFileChecksItOutAndStagesIt() {
        XCTAssertEqual(
            WholeFileResolve.commands(kind: .deletedByThem, side: .ours, path: "a.swift"),
            [["checkout", "--ours", "--", "a.swift"], ["add", "--", "a.swift"]])
        XCTAssertEqual(
            WholeFileResolve.commands(kind: .deletedByUs, side: .theirs, path: "a.swift"),
            [["checkout", "--theirs", "--", "a.swift"], ["add", "--", "a.swift"]])
    }

    func testABinaryConflictChecksOutTheChosenSide() {
        XCTAssertEqual(
            WholeFileResolve.commands(kind: .binary, side: .theirs, path: "logo.png"),
            [["checkout", "--theirs", "--", "logo.png"], ["add", "--", "logo.png"]])
    }
}
