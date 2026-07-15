import Foundation

/// Pure word-level diff for inline text ([ADR 0019]). A changed block's old and new
/// plain text are tokenized on whitespace and LCS-diffed into an ordered op list —
/// `keep`/`add`/`remove` — which the renderer walks to color added words and strike
/// removed ones while keeping the surrounding markdown formatting intact.
enum WordOp: Equatable {
    case keep(String)
    case add(String)
    case remove(String)
}

enum MarkdownInlineDiff {
    /// Whitespace-separated tokens (a "word" carries its trailing punctuation). Runs of
    /// whitespace collapse — markdown renders them the same, and the renderer re-spaces.
    static func tokenize(_ s: String) -> [String] {
        s.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }).map(String.init)
    }

    static func diff(old: String, new: String) -> [WordOp] {
        diffWords(old: tokenize(old), new: tokenize(new))
    }

    static func diffWords(old a: [String], new b: [String]) -> [WordOp] {
        SequenceAlign.lcs(a, b).map { op in
            switch op {
            case .keep(_, let n):  return .keep(b[n])
            case .remove(let o):   return .remove(a[o])
            case .add(let n):      return .add(b[n])
            }
        }
    }
}
