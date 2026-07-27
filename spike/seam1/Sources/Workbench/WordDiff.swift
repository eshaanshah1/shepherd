import Foundation

/// A run of characters within one line, flagged as changed or unchanged.
/// `range` indexes the line's characters (not UTF-16 units).
struct WordSpan: Equatable {
    let range: Range<Int>
    let changed: Bool
}

/// Which line on the opposite side each changed line of a hunk replaced.
///
/// Pairs **adjacent runs only**: a maximal run of removals immediately followed by a
/// maximal run of additions, and only when the two runs are the same length. Anything
/// else is left unpaired, so it renders as a plain added/removed row.
///
/// The rule matters. Pairing by ordinal across the whole hunk — matching the *n*th
/// removal with the *n*th addition wherever they sit — lines up unrelated lines as soon
/// as a hunk holds two separate edits, and the word diff then tints words that never
/// changed. A hunk of pure additions with an equal number of removals somewhere else in
/// it is the common case, and it painted nonsense.
struct HunkPairing: Equatable {
    /// Index within the hunk's lines → the opposite side's text.
    private let counterparts: [Int: String]

    init(kinds: [DiffLineKind], texts: [String]) {
        var map: [Int: String] = [:]
        var i = 0
        while i < kinds.count {
            guard kinds[i] == .removed else { i += 1; continue }
            let removedStart = i
            while i < kinds.count, kinds[i] == .removed { i += 1 }
            let addedStart = i
            while i < kinds.count, kinds[i] == .added { i += 1 }
            let count = addedStart - removedStart
            guard count == i - addedStart, count > 0 else { continue }
            for k in 0..<count {
                map[removedStart + k] = texts[addedStart + k]
                map[addedStart + k] = texts[removedStart + k]
            }
        }
        counterparts = map
    }

    /// The opposite-side text for the line at `index` within the hunk, if it is paired.
    func counterpart(atLineIndex index: Int) -> String? { counterparts[index] }
}

/// Intra-line word diff over `SequenceAlign.lcs`. Spans tile the line with no gaps,
/// so a renderer can walk them in order and tint as it goes.
enum WordDiff {
    /// Word-level spans for a changed line pair. Lines longer than `maxLength` are
    /// reported as wholly changed rather than aligned — the cap keeps lockfiles and
    /// minified bundles from stalling the render.
    static func spans(old: String, new: String, maxLength: Int = 5000)
        -> (old: [WordSpan], new: [WordSpan]) {
        if old.isEmpty && new.isEmpty { return ([], []) }
        if old.count > maxLength || new.count > maxLength {
            return (wholeLine(old), wholeLine(new))
        }
        let oldTokens = tokenize(old), newTokens = tokenize(new)
        let ops = SequenceAlign.lcs(oldTokens.map(\.text), newTokens.map(\.text))
        var oldChanged = Set<Int>(), newChanged = Set<Int>()
        for op in ops {
            switch op {
            case .keep: break
            case .remove(let i): oldChanged.insert(i)
            case .add(let j): newChanged.insert(j)
            }
        }
        return (merge(oldTokens, changed: oldChanged), merge(newTokens, changed: newChanged))
    }

    private static func wholeLine(_ s: String) -> [WordSpan] {
        s.isEmpty ? [] : [WordSpan(range: 0..<s.count, changed: true)]
    }

    private struct Token { let text: String; let range: Range<Int> }

    /// Character classes a token is a run of. Whitespace is its own class, not lumped
    /// in with punctuation: `"()"` and `"() "` must compare equal in their punctuation
    /// part, or appending a trailing word retints the punctuation before it.
    private enum CharClass { case word, space, punct }

    private static func classify(_ ch: Character) -> CharClass {
        if ch.isLetter || ch.isNumber || ch == "_" { return .word }
        if ch.isWhitespace { return .space }
        return .punct
    }

    /// Split into runs of a single character class, so a moved bracket doesn't smear
    /// the identifiers around it as changed.
    private static func tokenize(_ s: String) -> [Token] {
        var out: [Token] = []
        var start = 0
        var current = ""
        var currentClass: CharClass?
        for (idx, ch) in Array(s).enumerated() {
            let cls = classify(ch)
            if let was = currentClass, was != cls {
                out.append(Token(text: current, range: start..<idx))
                start = idx
                current = ""
            }
            currentClass = cls
            current.append(ch)
        }
        if !current.isEmpty { out.append(Token(text: current, range: start..<s.count)) }
        return out
    }

    /// Collapse adjacent tokens of the same changed-ness into contiguous spans, so
    /// consumers see alternating runs rather than one span per token.
    private static func merge(_ tokens: [Token], changed: Set<Int>) -> [WordSpan] {
        var out: [WordSpan] = []
        for (idx, token) in tokens.enumerated() {
            let isChanged = changed.contains(idx)
            if let last = out.last, last.changed == isChanged {
                out[out.count - 1] = WordSpan(range: last.range.lowerBound..<token.range.upperBound,
                                              changed: isChanged)
            } else {
                out.append(WordSpan(range: token.range, changed: isChanged))
            }
        }
        return out
    }
}
