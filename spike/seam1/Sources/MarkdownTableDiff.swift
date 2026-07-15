import Foundation

/// Pure cell-level table diff ([ADR 0019]). Given the old and new tables as grids of
/// cell text (row 0 = header), align rows by content, pair a replaced row to diff its
/// cells, and report which cells changed, which rows are new, and which were removed —
/// so a one-cell edit highlights that cell instead of reprinting the whole table twice.
enum MarkdownTableDiff {
    struct Cell: Hashable { let row: Int; let col: Int }   // new-grid coordinates

    struct Result: Equatable {
        var changed: [Cell: String] = [:]  // changed cell (new coords) → its old text
        var addedRows: Set<Int> = []       // new-grid rows with no old counterpart
        var removedRows: [Int] = []        // old-grid rows with no new counterpart (order kept)
    }

    static func diff(old: [[String]], new: [[String]]) -> Result {
        let ops = SequenceAlign.lcs(old.map(rowKey), new.map(rowKey))
        var result = Result()
        var i = 0
        while i < ops.count {
            if case .keep = ops[i] { i += 1; continue }   // identical row
            var rem: [Int] = [], add: [Int] = []
            while i < ops.count, case .remove(let o) = ops[i] { rem.append(o); i += 1 }
            while i < ops.count, case .add(let n) = ops[i] { add.append(n); i += 1 }
            let paired = min(rem.count, add.count)
            for p in 0..<paired {
                let o = rem[p], n = add[p]
                let cols = max(old[o].count, new[n].count)
                for c in 0..<cols where cell(old[o], c) != cell(new[n], c) {
                    result.changed[Cell(row: n, col: c)] = cell(old[o], c)
                }
            }
            for p in paired..<rem.count { result.removedRows.append(rem[p]) }
            for p in paired..<add.count { result.addedRows.insert(add[p]) }
        }
        return result
    }

    private static func rowKey(_ cells: [String]) -> String { cells.joined(separator: "\u{1}") }
    private static func cell(_ row: [String], _ c: Int) -> String { c < row.count ? row[c] : "" }
}
