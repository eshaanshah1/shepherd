import XCTest
@testable import Shepherd

/// What building the whole-diff document actually costs.
///
/// The roadmap calls virtualization the top outstanding perf item, on the grounds that the
/// document is stitched eagerly. Parses and `SourceBuffer`s are already lazy, so before
/// making the document lazy too — which touches every row-indexed table in the workbench —
/// this measures where the eager time really goes.
final class WholeDiffCostTests: XCTestCase {

    /// ~287 files, ~32k rows: the shape of the live run the roadmap describes.
    private func hugeDiff(files: Int = 287, hunksPerFile: Int = 4,
                          linesPerHunk: Int = 28) -> String {
        var out = ""
        out.reserveCapacity(files * hunksPerFile * linesPerHunk * 40)
        for f in 0..<files {
            out += "diff --git a/Sources/Module\(f)/File\(f).swift b/Sources/Module\(f)/File\(f).swift\n"
            out += "--- a/Sources/Module\(f)/File\(f).swift\n"
            out += "+++ b/Sources/Module\(f)/File\(f).swift\n"
            for h in 0..<hunksPerFile {
                let start = 1 + h * 200
                out += "@@ -\(start),\(linesPerHunk) +\(start),\(linesPerHunk) @@ func thing\(h)()\n"
                for l in 0..<linesPerHunk {
                    switch l % 4 {
                    case 0: out += "-    let removed\(l) = \(l)\n"
                    case 1: out += "+    let added\(l) = \(l)\n"
                    default: out += "     let context\(l) = \(l)\n"
                    }
                }
            }
        }
        return out
    }

    private func time(_ label: String, _ body: () -> Void) -> Double {
        let start = Date().timeIntervalSince1970
        body()
        let elapsed = (Date().timeIntervalSince1970 - start) * 1000
        print("  ⏱  \(label): \(String(format: "%.1f", elapsed))ms")
        return elapsed
    }

    func testWhatTheWholeDiffDocumentCosts() {
        let text = hugeDiff()
        print("  diff text: \(text.count / 1024)KB")

        var files: [DiffFile] = []
        let parseMS = time("DiffParser.parse") { files = DiffParser.parse(text) }

        var plan = RowPlan()
        let planMS = time("RowPlanner.plan") { plan = RowPlanner.plan(files: files) }

        print("  → \(files.count) files, \(plan.origins.count) rows, \(plan.blocks.count) blocks")

        // The string + per-row style table `rebuild()` materializes from the plan. Done here
        // without AppKit so the cost is attributable.
        var stitched = ""
        let buildMS = time("stitch + styles") {
            var tints: [Int] = []
            tints.reserveCapacity(plan.origins.count)
            var hunks: [String: DiffHunk] = [:]
            for file in files {
                for (i, hunk) in file.hunks.enumerated() { hunks["\(file.path)#\(i)"] = hunk }
            }
            for origin in plan.origins {
                let hunk = hunks["\(origin.path)#\(origin.hunkIndex)"]
                let line = hunk?.lines[origin.lineIndex]
                stitched += (line?.text ?? "") + "\n"
                tints.append(line?.kind == .added ? 1 : 0)
            }
        }
        let lineStartMS = time("lineStartOffsets") {
            _ = EditMap.lineStartOffsets(stitched)
        }

        let total = parseMS + planMS + buildMS + lineStartMS
        print("  ⏱  TOTAL: \(String(format: "%.1f", total))ms for \(plan.origins.count) rows")
        XCTAssertGreaterThan(plan.origins.count, 20_000, "fixture should be the big shape")
    }

    /// Focusing one file is the current stopgap; this is what it costs by comparison.
    func testWhatOneFocusedFileCosts() {
        let files = DiffParser.parse(hugeDiff())
        _ = time("plan, one file") { _ = RowPlanner.plan(files: [files[0]]) }
    }
}
