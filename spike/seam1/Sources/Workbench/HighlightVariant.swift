import Foundation

/// Which text a row's syntax colours are parsed from.
///
/// A row is not always a line of a file on disk. A removed line lives in the base blob; a
/// row of a conflicted file lives in a merge preview that exists nowhere but memory, because
/// the file on disk still holds git's markers; a row of a historical commit lives in a blob
/// that may not correspond to any line of the file today. Asking for `.new` and indexing the
/// working copy — which is what every anchor did before W3 — paints those rows with whatever
/// line happens to sit at that number, which is the bug that mangled highlighting on the
/// first live run.
///
/// Lives in its own file, free of the editor and AppKit, so `DocumentProvenance` — the one
/// place that decides which variant a row gets — can be unit-tested. `MultiHighlighter`
/// caches by `(SourceID, HighlightVariant)`, so a variant is a cache key as much as a
/// description: anything that must not share a parse has to differ here.
enum HighlightVariant: Hashable {
    /// The working copy.
    case new
    /// The base blob, for deletion bands.
    case old
    /// The merged text a conflicted file's document is showing.
    case mergePreview
    /// A file as of a commit. Keyed by sha: two commits touching one file are two texts.
    case commit(String)
    /// A fragment with no file position at all — the hidden side of a conflict. Keyed by
    /// the block id so each band parses and caches on its own.
    case snippet(String)
}
