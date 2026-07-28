import Foundation

/// Where a row reads its line text from, when the diff does not carry it.
///
/// Gap-revealed rows and rows of an edited file are the only rows whose text is not in the
/// diff, and they all funnel through one lookup in `WorkbenchSession.rebuild`.
enum LineTextSource: Equatable {
    case workingCopy
    case commitBlob(sha: String)
}

/// The document's provenance: what its text is, and therefore what may be done to it.
///
/// Three decisions, one place. Every one of them has a wrong answer that looks right on
/// screen — colours from the wrong file, a gap expansion splicing today's lines into a
/// three-week-old commit, an edit written at offsets derived from text that is not on disk.
enum DocumentProvenance {

    /// The variant a row's colours are parsed from.
    ///
    /// A commit wins over a merge preview: the lock means the two cannot coexist, but if
    /// they ever did, the commit is what the document is showing.
    static func variant(hasMergePreview: Bool, commitSha: String?) -> HighlightVariant {
        if let commitSha { return .commit(commitSha) }
        return hasMergePreview ? .mergePreview : .new
    }

    static func lineSource(commitSha: String?) -> LineTextSource {
        guard let commitSha else { return .workingCopy }
        return .commitBlob(sha: commitSha)
    }

    /// Editing history is not a thing. Read-only is structural here rather than a flag, so
    /// there is no path that forgets to check it.
    static func isEditable(commitSha: String?) -> Bool { commitSha == nil }

    /// Why the document will not accept typing. **Must be surfaced** — a buffer that
    /// silently refuses edits is the W2.2 defect.
    static func readOnlyReason(commitSha: String?) -> String? {
        commitSha == nil ? nil : "read-only · historical commit"
    }
}
