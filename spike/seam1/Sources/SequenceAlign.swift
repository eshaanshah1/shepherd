import Foundation

/// Pure LCS alignment of two sequences of string keys — the backbone of the rendered
/// markdown diff ([ADR 0019]). Callers key their items (a block's normalized markdown,
/// a table row's joined cells, …), align, then map the ops back to their own nodes and
/// decide which `remove`+`add` gaps to treat as an in-place change.
enum AlignOp: Equatable {
    case keep(old: Int, new: Int)   // keys equal
    case remove(old: Int)           // present only on the old side
    case add(new: Int)              // present only on the new side
}

enum SequenceAlign {
    /// Longest-common-subsequence alignment. Order is preserved; within a divergent
    /// region removals precede additions (so a replaced item reads old→new downstream).
    static func lcs(_ a: [String], _ b: [String]) -> [AlignOp] {
        let n = a.count, m = b.count
        var dp = Array(repeating: Array(repeating: 0, count: m + 1), count: n + 1)
        if n > 0 && m > 0 {
            for i in stride(from: n - 1, through: 0, by: -1) {
                for j in stride(from: m - 1, through: 0, by: -1) {
                    dp[i][j] = a[i] == b[j] ? dp[i + 1][j + 1] + 1 : max(dp[i + 1][j], dp[i][j + 1])
                }
            }
        }
        var out: [AlignOp] = []
        var i = 0, j = 0
        while i < n && j < m {
            if a[i] == b[j] { out.append(.keep(old: i, new: j)); i += 1; j += 1 }
            else if dp[i + 1][j] >= dp[i][j + 1] { out.append(.remove(old: i)); i += 1 }
            else { out.append(.add(new: j)); j += 1 }
        }
        while i < n { out.append(.remove(old: i)); i += 1 }
        while j < m { out.append(.add(new: j)); j += 1 }
        return out
    }
}
