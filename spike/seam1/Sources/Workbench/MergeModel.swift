import Foundation

enum MergeSide: Hashable { case ours, theirs }

/// What kind of unmerged entry git is holding, decided from which index stages exist
/// (plus a UTF-8 decode check, which is the reader's job, not the stage set's).
enum ConflictKind: Equatable {
    case content            // stages 1,2,3 — three text blobs
    case addAdd             // stages 2,3 — both sides created it; no ancestor
    case deletedByThem      // stages 1,2
    case deletedByUs        // stages 1,3
    case binary             // any stage that isn't text
    case unknown

    /// Whether this conflict has no line-level answer.
    ///
    /// A binary blob and a deletion have no line list, so there is nothing to show as rows
    /// and nothing we could write without fabricating it. These are resolved by handing the
    /// decision to git (`checkout --ours/--theirs`, `rm`) rather than by writing content
    /// ourselves.
    var isWholeFile: Bool {
        switch self {
        case .content, .addAdd:                                 return false
        case .deletedByThem, .deletedByUs, .binary, .unknown:   return true
        }
    }
}

enum Resolution: Equatable, CaseIterable {
    case ours, theirs, bothOursFirst, bothTheirsFirst

    /// A whole-file conflict can only keep one side outright; interleaving a deletion or a
    /// binary blob means nothing.
    static let wholeFileChoices: [Resolution] = [.ours, .theirs]
}

/// One decision the user has to make inside a file.
struct MergeConflict: Equatable, Identifiable {
    /// `"<path>#<n>"` — stable across reloads of the same conflict set, so choices survive
    /// a refresh.
    let id: String
    /// 1-based, for "CONFLICT 2/5".
    let index: Int
    let base: [String]
    let ours: [String]
    let theirs: [String]
}

/// One unmerged file: its regions, and the decisions inside it.
struct MergeFile: Equatable {
    let path: String
    let kind: ConflictKind
    let regions: [MergeRegion]
    let conflicts: [MergeConflict]
    /// Real ref names, not "ours"/"theirs". Mid-rebase, stage 2 is the branch you are
    /// rebasing **onto** and stage 3 is your own commit being replayed, so the git words
    /// are actively misleading on the button that decides which one survives.
    let oursLabel: String
    let theirsLabel: String

    private init(path: String, kind: ConflictKind, regions: [MergeRegion],
                 conflicts: [MergeConflict], oursLabel: String, theirsLabel: String) {
        self.path = path
        self.kind = kind
        self.regions = regions
        self.conflicts = conflicts
        self.oursLabel = oursLabel
        self.theirsLabel = theirsLabel
    }

    init(path: String, kind: ConflictKind, regions: [MergeRegion],
         oursLabel: String, theirsLabel: String) {
        var made: [MergeConflict] = []
        for region in regions {
            guard case .conflict(let base, let ours, let theirs) = region else { continue }
            made.append(MergeConflict(id: "\(path)#\(made.count + 1)", index: made.count + 1,
                                      base: base, ours: ours, theirs: theirs))
        }
        self.init(path: path, kind: kind, regions: regions, conflicts: made,
                  oursLabel: oursLabel, theirsLabel: theirsLabel)
    }

    /// A conflict with no line-level answer: no regions, no rows, one synthetic decision so
    /// it flows through the same `resolutions` map as everything else.
    static func wholeFile(path: String, kind: ConflictKind,
                          oursLabel: String, theirsLabel: String) -> MergeFile {
        MergeFile(path: path, kind: kind, regions: [],
                  conflicts: [MergeConflict(id: "\(path)#1", index: 1,
                                            base: [], ours: [], theirs: [])],
                  oursLabel: oursLabel, theirsLabel: theirsLabel)
    }
}

enum MergeOutput {

    /// The lines a resolution puts in the document.
    static func lines(for conflict: MergeConflict, resolution: Resolution) -> [String] {
        switch resolution {
        case .ours:            return conflict.ours
        case .theirs:          return conflict.theirs
        case .bothOursFirst:   return conflict.ours + conflict.theirs
        case .bothTheirsFirst: return conflict.theirs + conflict.ours
        }
    }

    /// The side **not** currently shown as rows, which renders as a band. Nil when both
    /// sides are already rows, or when the hidden side is empty.
    static func display(for conflict: MergeConflict,
                        resolution: Resolution?) -> [(side: MergeSide, lines: [String])] {
        switch resolution {
        case .none, .some(.bothOursFirst):
            return [(.ours, conflict.ours), (.theirs, conflict.theirs)]
        case .some(.bothTheirsFirst):
            return [(.theirs, conflict.theirs), (.ours, conflict.ours)]
        case .some(.ours):
            return [(.ours, conflict.ours)]
        case .some(.theirs):
            return [(.theirs, conflict.theirs)]
        }
    }

    /// The line on the other side that a conflict line should word-diff against.
    ///
    /// **Only when the two sides have the same number of lines.** That is the same rule
    /// `HunkPairing` settled on for a hunk, and for the same reason: pairing by ordinal
    /// across runs of different lengths lines up unrelated lines, and the word diff then
    /// brightens words that never changed. Anything else renders with a flat tint, which
    /// says "these differ" without claiming to know how.
    static func counterpart(in conflict: MergeConflict, side: MergeSide,
                            index: Int) -> String? {
        guard conflict.ours.count == conflict.theirs.count else { return nil }
        let other = side == .ours ? conflict.theirs : conflict.ours
        return other.indices.contains(index) ? other[index] : nil
    }

    /// Whether a conflict is showing both sides, and so wants the `=======` / `>>>>>>>`
    /// markers between and after them.
    ///
    /// True while undecided, and true for the keep-both choices — there the markers are
    /// what say which order you picked.
    static func isSplit(resolution: Resolution?) -> Bool {
        resolution == nil || resolution == .bothOursFirst || resolution == .bothTheirsFirst
    }

    /// What the buffer shows.
    ///
    /// An undecided region shows **both** sides, the way git wrote them and every merge tool
    /// presents them; the markers around them are drawn as bands, never as text, so a marker
    /// can never end up in a written file. Once decided, only the chosen side remains — so
    /// for a fully decided file this is exactly what `text` writes.
    static func preview(_ file: MergeFile, resolutions: [String: Resolution]) -> [String] {
        var out: [String] = []
        var index = 0
        for region in file.regions {
            switch region {
            case .stable(let lines):
                out += lines
            case .conflict:
                guard index < file.conflicts.count else { continue }
                let conflict = file.conflicts[index]
                index += 1
                out += display(for: conflict, resolution: resolutions[conflict.id])
                    .flatMap(\.lines)
            }
        }
        return out
    }

    /// What gets written. Nil while anything is undecided, or for a whole-file conflict —
    /// those go through git, never through a write of ours.
    static func text(_ file: MergeFile, resolutions: [String: Resolution]) -> String? {
        guard !file.kind.isWholeFile,
              unresolved(file, resolutions: resolutions).isEmpty else { return nil }
        return MergeText.blob(preview(file, resolutions: resolutions))
    }

    static func unresolved(_ file: MergeFile,
                           resolutions: [String: Resolution]) -> [MergeConflict] {
        file.conflicts.filter { resolutions[$0.id] == nil }
    }
}

/// The git commands that settle a conflict we will not write ourselves.
///
/// Pure so the mapping is testable; the caller runs them in order and stops on the first
/// failure. Never reconstructs content — a binary blob or a deletion has no line list, and
/// writing a fabricated one makes the fabrication real.
enum WholeFileResolve {
    static func commands(kind: ConflictKind, side: MergeSide, path: String) -> [[String]] {
        let deletesIt = (kind == .deletedByThem && side == .theirs)
            || (kind == .deletedByUs && side == .ours)
        if deletesIt { return [["rm", "-f", "--", path]] }
        return [["checkout", side == .ours ? "--ours" : "--theirs", "--", path],
                ["add", "--", path]]
    }
}
